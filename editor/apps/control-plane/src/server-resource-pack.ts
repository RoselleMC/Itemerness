import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ServerResourcePackStatus } from "@itemerness/protocol";

const MAX_RESOURCE_PACK_BYTES = 512 * 1024 * 1024;

export class ServerResourcePackService {
    private readonly path: string | null;
    private cached: {
        readonly size: number;
        readonly modified: number;
        readonly bytes: Buffer;
        readonly sha1: string;
    } | null = null;

    constructor(path: string | null) {
        this.path = path ? resolve(path) : null;
    }

    async status(): Promise<ServerResourcePackStatus> {
        if (!this.path) return this.unavailable();
        try {
            const entry = await stat(this.path);
            if (!entry.isFile() || entry.size > MAX_RESOURCE_PACK_BYTES) {
                return this.unavailable();
            }
            const loaded = await this.load(entry.size, entry.mtimeMs);
            return {
                available: true,
                name: basename(this.path),
                sha1: loaded.sha1,
                byteLength: entry.size,
                modifiedAt: entry.mtime.toISOString(),
            };
        } catch {
            return this.unavailable();
        }
    }

    async bytes(): Promise<{ bytes: Buffer; name: string; sha1: string }> {
        if (!this.path) throw new Error("未配置 ITEMERNESS_RESOURCE_PACK");
        const entry = await stat(this.path);
        if (!entry.isFile()) throw new Error("服务器资源包路径不是文件");
        if (entry.size > MAX_RESOURCE_PACK_BYTES) {
            throw new Error("服务器资源包超过 512 MiB 限制");
        }
        const loaded = await this.load(entry.size, entry.mtimeMs);
        return {
            bytes: loaded.bytes,
            name: basename(this.path),
            sha1: loaded.sha1,
        };
    }

    private async load(size: number, modified: number) {
        if (this.cached?.size === size && this.cached.modified === modified) {
            return this.cached;
        }
        const bytes = await readFile(this.path!);
        const sha1 = createHash("sha1").update(bytes).digest("hex");
        this.cached = { size, modified, bytes, sha1 };
        return this.cached;
    }

    private unavailable(): ServerResourcePackStatus {
        return {
            available: false,
            name: null,
            sha1: null,
            byteLength: null,
            modifiedAt: null,
        };
    }
}

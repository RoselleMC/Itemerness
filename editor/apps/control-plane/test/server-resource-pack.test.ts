import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerResourcePackService } from "../src/server-resource-pack.js";

describe("ServerResourcePackService", () => {
    let root: string;
    let packPath: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "itemerness-pack-"));
        packPath = join(root, "build.zip");
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("reports and serves the exact configured pack bytes", async () => {
        const bytes = Buffer.from(
            "PK\u0003\u0004server-resource-pack-fixture",
            "binary",
        );
        await writeFile(packPath, bytes);
        const service = new ServerResourcePackService(packPath);
        const sha1 = createHash("sha1").update(bytes).digest("hex");

        await expect(service.status()).resolves.toMatchObject({
            available: true,
            name: "build.zip",
            sha1,
            byteLength: bytes.length,
        });
        const loaded = await service.bytes();
        expect(loaded.name).toBe("build.zip");
        expect(loaded.sha1).toBe(sha1);
        expect(loaded.bytes).toEqual(bytes);
    });

    it("is unavailable when the server pack is not configured", async () => {
        const service = new ServerResourcePackService(null);
        await expect(service.status()).resolves.toEqual({
            available: false,
            name: null,
            sha1: null,
            byteLength: null,
            modifiedAt: null,
        });
        await expect(service.bytes()).rejects.toThrow(
            "未配置 ITEMERNESS_RESOURCE_PACK",
        );
    });
});

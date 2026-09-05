import { randomBytes } from "node:crypto";
import {
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentToken } from "./agent-channel.js";

interface TokenDocument {
    readonly schemaVersion: 1;
    readonly tokens: readonly AgentToken[];
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function nullableDate(value: unknown): string | null | undefined {
    if (value === null) return null;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        return undefined;
    }
    return value;
}

function decodeToken(value: unknown): AgentToken | null {
    const source = record(value);
    if (!source) return null;
    const environment = source.environment;
    const revokedAt = nullableDate(source.revokedAt);
    const lastSeenAt = nullableDate(source.lastSeenAt);
    if (
        typeof source.lookupId !== "string" ||
        !/^agt_[A-Za-z0-9_-]{12}$/u.test(source.lookupId) ||
        typeof source.serverId !== "string" ||
        source.serverId.length === 0 ||
        typeof source.name !== "string" ||
        source.name.length === 0 ||
        (environment !== "development" &&
            environment !== "staging" &&
            environment !== "production") ||
        typeof source.secretDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(source.secretDigest) ||
        revokedAt === undefined ||
        lastSeenAt === undefined
    ) {
        return null;
    }
    return {
        lookupId: source.lookupId,
        serverId: source.serverId,
        name: source.name,
        environment,
        secretDigest: source.secretDigest,
        revokedAt,
        lastSeenAt,
    };
}

function decodeDocument(value: unknown): TokenDocument {
    const source = record(value);
    if (source?.schemaVersion !== 1 || !Array.isArray(source.tokens)) {
        throw new Error("agent token store has an invalid document shape");
    }
    const tokens = source.tokens.map(decodeToken);
    if (tokens.some((token) => token === null)) {
        throw new Error("agent token store contains an invalid token record");
    }
    const loaded = tokens as AgentToken[];
    if (new Set(loaded.map((token) => token.lookupId)).size !== loaded.length) {
        throw new Error("agent token store contains duplicate lookup ids");
    }
    return { schemaVersion: 1, tokens: loaded };
}

export class AgentTokenStore {
    private readonly path: string | null;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(path: string | null) {
        this.path = path ? resolve(path) : null;
    }

    async load(): Promise<readonly AgentToken[]> {
        if (!this.path) return [];
        try {
            return decodeDocument(
                JSON.parse(await readFile(this.path, "utf8")) as unknown,
            ).tokens;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
    }

    save(tokens: readonly AgentToken[]): Promise<void> {
        if (!this.path) return Promise.resolve();
        const snapshot: TokenDocument = {
            schemaVersion: 1,
            tokens: tokens.map((token) => ({ ...token })),
        };
        const write = () => this.write(snapshot);
        this.writeQueue = this.writeQueue.then(write, write);
        return this.writeQueue;
    }

    private async write(document: TokenDocument): Promise<void> {
        const path = this.path!;
        const directory = dirname(path);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
        try {
            await writeFile(
                temporary,
                `${JSON.stringify(document, null, 2)}\n`,
                {
                    encoding: "utf8",
                    flag: "wx",
                    mode: 0o600,
                },
            );
            await rename(temporary, path);
            await chmod(path, 0o600);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRegistry } from "../src/agent-channel.js";
import { AgentTokenStore } from "../src/agent-token-store.js";

describe("AgentTokenStore", () => {
    let root: string;
    let path: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "itemerness-agent-tokens-"));
        path = join(root, "state", "tokens.json");
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("atomically persists only token digests and restores authentication", async () => {
        const registry = new AgentRegistry("test-pepper");
        const issued = registry.issueToken({
            serverId: "srv_test",
            name: "Test server",
            environment: "production",
        });
        const store = new AgentTokenStore(path);

        await store.save(registry.tokenSnapshot());

        const source = await readFile(path, "utf8");
        expect(source).not.toContain(issued.plaintext);
        const restored = new AgentRegistry("test-pepper", await store.load());
        expect(restored.authenticate(issued.plaintext)?.serverId).toBe(
            "srv_test",
        );
        if (process.platform !== "win32") {
            expect((await stat(path)).mode & 0o777).toBe(0o600);
        }
    });

    it("fails closed when the persisted document is malformed", async () => {
        const store = new AgentTokenStore(path);
        await store.save([]);
        await writeFile(path, '{"schemaVersion":1,"tokens":[{}]}', "utf8");

        await expect(store.load()).rejects.toThrow("invalid token record");
    });

    it("is an in-memory no-op when no persistence path is configured", async () => {
        const store = new AgentTokenStore(null);
        await expect(store.load()).resolves.toEqual([]);
        await expect(store.save([])).resolves.toBeUndefined();
    });
});

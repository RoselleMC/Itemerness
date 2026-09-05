import { describe, expect, it } from "vitest";
import { AgentRegistry, type AgentConnection } from "../src/agent-channel.js";

interface SocketProbe {
    readonly sent: string[];
    readonly closed: string[];
    readonly connection: AgentConnection;
}

function register(registry: AgentRegistry, serverId = "srv_test"): SocketProbe {
    const sent: string[] = [];
    const closed: string[] = [];
    const connection = registry.register(serverId, {
        send: (text) => sent.push(text),
        close: (_code, reason) => closed.push(reason ?? ""),
    });
    return { sent, closed, connection };
}

function response(
    request: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
): string {
    return JSON.stringify({
        ...request,
        kind: "response",
        payload: { ok: true, error: null, result: { accepted: true } },
        ...overrides,
    });
}

function hello(connection: AgentConnection, payload: unknown): string {
    return JSON.stringify({
        protocolVersion: 1,
        kind: "request",
        method: "agent.hello",
        requestId: "hello_1",
        serverId: connection.serverId,
        connectionGeneration: 0,
        sequence: 1,
        deadline: null,
        traceId: null,
        contentHash: null,
        payload,
    });
}

const capabilities = {
    schemaVersion: 1,
    agentVersion: "0.1.0",
    pluginVersion: "0.1.0",
    minecraftVersion: "26.1.2",
    javaVersion: "25.0.2+10",
    platform: "Folia",
    compilerDigest:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    supportedMethods: ["preview.compile"],
    activeArtifactDigest: null,
};

describe("AgentRegistry connection fencing", () => {
    it("restores a persisted token digest without retaining its plaintext", () => {
        const first = new AgentRegistry("test-pepper");
        const issued = first.issueToken({
            serverId: "srv_test",
            name: "Test server",
            environment: "production",
        });
        const restored = new AgentRegistry(
            "test-pepper",
            first.tokenSnapshot(),
        );

        expect(restored.authenticate(issued.plaintext)?.serverId).toBe(
            "srv_test",
        );
        expect(JSON.stringify(restored.tokenSnapshot())).not.toContain(
            issued.plaintext,
        );
    });

    it("can discard a token whose durable save failed", () => {
        const registry = new AgentRegistry("test-pepper");
        const issued = registry.issueToken({
            serverId: "srv_test",
            name: "Test server",
            environment: "production",
        });

        registry.discardToken(issued.token.lookupId);

        expect(registry.authenticate(issued.plaintext)).toBeNull();
        expect(registry.tokenSnapshot()).toEqual([]);
    });

    it("accepts only the JVM preview-only capability document during hello", () => {
        const registry = new AgentRegistry("test-pepper");
        const socket = register(registry);

        const reply = registry.handleMessage(
            socket.connection,
            hello(socket.connection, capabilities),
        );

        expect(JSON.parse(reply ?? "{}").payload.ok).toBe(true);
        expect(socket.connection.capabilities).toEqual(capabilities);
    });

    it("rejects a hello that advertises unsupported methods", () => {
        const registry = new AgentRegistry("test-pepper");
        const socket = register(registry);

        const reply = registry.handleMessage(
            socket.connection,
            hello(socket.connection, {
                ...capabilities,
                supportedMethods: ["preview.compile", "draft.validate"],
            }),
        );

        const payload = JSON.parse(reply ?? "{}").payload;
        expect(payload.ok).toBe(false);
        expect(payload.error.code).toBe("PROTOCOL.INVALID_CAPABILITIES");
        expect(socket.connection.capabilities).toBeNull();
    });

    it("accepts a response only from the request's exact connection generation", async () => {
        const registry = new AgentRegistry("test-pepper");
        const socket = register(registry);
        const pending = registry.request("srv_test", "preview.compile", {});
        const outbound = JSON.parse(socket.sent[0] ?? "{}") as Record<
            string,
            unknown
        >;

        registry.handleMessage(socket.connection, response(outbound));

        await expect(pending).resolves.toEqual({ accepted: true });
    });

    it("rejects pending work when a connection is superseded", async () => {
        const registry = new AgentRegistry("test-pepper");
        const first = register(registry);
        const pending = registry.request("srv_test", "preview.compile", {});
        const rejected = expect(pending).rejects.toThrow(
            "agent connection superseded",
        );

        register(registry);

        await rejected;
        expect(first.closed).toEqual(["superseded by a newer connection"]);
    });

    it("closes and rejects a response with mismatched envelope identity", async () => {
        const registry = new AgentRegistry("test-pepper");
        const socket = register(registry);
        const pending = registry.request("srv_test", "preview.compile", {});
        const rejected = expect(pending).rejects.toThrow(
            "did not match its request connection",
        );
        const outbound = JSON.parse(socket.sent[0] ?? "{}") as Record<
            string,
            unknown
        >;

        registry.handleMessage(
            socket.connection,
            response(outbound, { method: "agent.event" }),
        );

        await rejected;
        expect(socket.closed).toEqual(["invalid response envelope"]);
    });

    it("rejects pending work when the current socket closes", async () => {
        const registry = new AgentRegistry("test-pepper");
        const socket = register(registry);
        const pending = registry.request("srv_test", "preview.compile", {});
        const rejected = expect(pending).rejects.toThrow(
            "agent connection closed",
        );

        registry.unregister("srv_test", socket.connection.generation);

        await rejected;
    });
});

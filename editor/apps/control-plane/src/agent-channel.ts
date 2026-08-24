import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
    agentEnvelopeSchema,
    agentResponseSchema,
    capabilityDocumentSchema,
    type CapabilityDocument,
} from "@itemerness/protocol";

/**
 * The agent channel.
 *
 * Servers dial in over TLS and authenticate with an opaque token; the control plane never dials
 * out to a Minecraft server. Browsers do not get a socket to an agent at all — every browser
 * request is authorised here and relayed over an already-authenticated channel, so an editor who
 * can preview an item does not thereby gain RPC against a game server.
 */

export interface AgentToken {
    /** Public half, safe to log and to show in the UI. */
    readonly lookupId: string;
    readonly serverId: string;
    readonly name: string;
    readonly environment: "development" | "staging" | "production";
    /** Peppered digest of the secret half. The secret itself is never stored. */
    readonly secretDigest: string;
    revokedAt: string | null;
    lastSeenAt: string | null;
}

export interface AgentConnection {
    readonly serverId: string;
    readonly generation: number;
    readonly connectedAt: string;
    capabilities: CapabilityDocument | null;
    send(text: string): void;
    close(reason: string): void;
}

const PROTOCOL_VERSION = 1;
const MAXIMUM_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function digest(secret: string, pepper: string): string {
    return createHash("sha256").update(`${pepper}:${secret}`).digest("hex");
}

function constantTimeEquals(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    // timingSafeEqual throws on length mismatch, which would itself leak length information.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export class AgentRegistry {
    private readonly tokens = new Map<string, AgentToken>();
    private readonly connections = new Map<string, AgentConnection>();
    private readonly pending = new Map<
        string,
        {
            resolve: (value: unknown) => void;
            reject: (error: Error) => void;
            timer: NodeJS.Timeout;
            serverId: string;
            connectionGeneration: number;
            method: string;
        }
    >();
    private generationCounter = 0;
    private requestCounter = 0;

    constructor(private readonly pepper: string) {}

    /**
     * Issues a token. The plaintext is returned once and never stored; only a peppered digest is
     * kept, so a database copy cannot be replayed against a server.
     */
    issueToken(options: {
        serverId: string;
        name: string;
        environment: AgentToken["environment"];
    }): { token: AgentToken; plaintext: string } {
        const lookupId = `agt_${randomBytes(9).toString("base64url")}`;
        const secret = randomBytes(32).toString("base64url");
        const token: AgentToken = {
            lookupId,
            serverId: options.serverId,
            name: options.name,
            environment: options.environment,
            secretDigest: digest(secret, this.pepper),
            revokedAt: null,
            lastSeenAt: null,
        };
        this.tokens.set(lookupId, token);
        return { token, plaintext: `${lookupId}.${secret}` };
    }

    revokeToken(lookupId: string): boolean {
        const token = this.tokens.get(lookupId);
        if (!token) return false;
        token.revokedAt = new Date().toISOString();
        // A revoked token must not keep an existing session alive: the whole point of revoking is
        // that the holder stops being able to act, not that they stop being able to reconnect.
        const connection = this.connections.get(token.serverId);
        if (connection) {
            this.rejectPending(connection, "agent token revoked");
            connection.close("token revoked");
            this.connections.delete(token.serverId);
        }
        return true;
    }

    listTokens(): readonly Omit<AgentToken, "secretDigest">[] {
        return [...this.tokens.values()].map(
            ({ secretDigest: _ignored, ...rest }) => rest,
        );
    }

    authenticate(presented: string | undefined): AgentToken | null {
        if (!presented) return null;
        const separator = presented.indexOf(".");
        if (separator <= 0) return null;
        const token = this.tokens.get(presented.slice(0, separator));
        if (!token || token.revokedAt) return null;
        if (
            !constantTimeEquals(
                token.secretDigest,
                digest(presented.slice(separator + 1), this.pepper),
            )
        ) {
            return null;
        }
        token.lastSeenAt = new Date().toISOString();
        return token;
    }

    /** Registers a socket as the live connection for a server, superseding any earlier one. */
    register(
        serverId: string,
        socket: {
            send(text: string): void;
            close(code?: number, reason?: string): void;
        },
    ): AgentConnection {
        const previous = this.connections.get(serverId);
        if (previous) {
            // One live connection per server. The old generation is fenced so any request it was
            // still answering cannot land after the new session has taken over.
            this.rejectPending(previous, "agent connection superseded");
            previous.close("superseded by a newer connection");
        }
        this.generationCounter += 1;
        const connection: AgentConnection = {
            serverId,
            generation: this.generationCounter,
            connectedAt: new Date().toISOString(),
            capabilities: null,
            send: (text) => socket.send(text),
            close: (reason) => socket.close(1000, reason.slice(0, 120)),
        };
        this.connections.set(serverId, connection);
        return connection;
    }

    unregister(serverId: string, generation: number): void {
        const current = this.connections.get(serverId);
        // Only the current generation may unregister; a late close from a superseded socket must
        // not evict the connection that replaced it.
        if (current && current.generation === generation) {
            this.rejectPending(current, "agent connection closed");
            this.connections.delete(serverId);
        }
    }

    get(serverId: string): AgentConnection | undefined {
        const connection = this.connections.get(serverId);
        return connection?.capabilities ? connection : undefined;
    }

    list(): readonly AgentConnection[] {
        return [...this.connections.values()].filter(
            (connection) => connection.capabilities !== null,
        );
    }

    /** Sends a request to an agent and resolves with its response payload. */
    request(
        serverId: string,
        method: string,
        payload: unknown,
        timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<unknown> {
        const connection = this.connections.get(serverId);
        if (!connection)
            return Promise.reject(
                new Error(`no agent connected for ${serverId}`),
            );

        this.requestCounter += 1;
        const requestId = `req_${this.requestCounter}_${randomBytes(4).toString("hex")}`;
        const envelope = {
            protocolVersion: PROTOCOL_VERSION,
            kind: "request",
            method,
            requestId,
            serverId,
            connectionGeneration: connection.generation,
            sequence: this.requestCounter,
            // The agent discards a result produced after this instant rather than answering with a
            // preview for a draft the editor has already moved past.
            deadline: new Date(Date.now() + timeoutMs).toISOString(),
            traceId: null,
            contentHash: null,
            payload,
        };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`agent request ${method} timed out`));
            }, timeoutMs);
            this.pending.set(requestId, {
                resolve,
                reject,
                timer,
                serverId,
                connectionGeneration: connection.generation,
                method,
            });
            try {
                connection.send(JSON.stringify(envelope));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(error as Error);
            }
        });
    }

    /** Routes an inbound message. Returns a reply to send back, or null. */
    handleMessage(connection: AgentConnection, raw: string): string | null {
        if (Buffer.byteLength(raw, "utf8") > MAXIMUM_MESSAGE_BYTES) {
            connection.close("message too large");
            return null;
        }
        let decoded: unknown;
        try {
            decoded = JSON.parse(raw);
        } catch {
            return null;
        }
        const parsedEnvelope = agentEnvelopeSchema.safeParse(decoded);
        if (!parsedEnvelope.success) {
            connection.close("invalid message envelope");
            return null;
        }
        const envelope = parsedEnvelope.data;
        const kind = envelope.kind;
        const requestId =
            typeof envelope.requestId === "string" ? envelope.requestId : "";

        if (kind === "response") {
            const waiting = this.pending.get(requestId);
            if (!waiting) return null;
            const valid =
                envelope.protocolVersion === PROTOCOL_VERSION &&
                envelope.serverId === waiting.serverId &&
                envelope.connectionGeneration ===
                    waiting.connectionGeneration &&
                envelope.method === waiting.method &&
                connection.serverId === waiting.serverId &&
                connection.generation === waiting.connectionGeneration;
            if (!valid) {
                clearTimeout(waiting.timer);
                this.pending.delete(requestId);
                waiting.reject(
                    new Error(
                        "agent response did not match its request connection",
                    ),
                );
                connection.close("invalid response envelope");
                return null;
            }
            clearTimeout(waiting.timer);
            this.pending.delete(requestId);
            const payload = agentResponseSchema.safeParse(envelope.payload);
            if (!payload.success) {
                waiting.reject(
                    new Error("agent returned an invalid response payload"),
                );
                connection.close("invalid response payload");
            } else if (payload.data.ok) {
                waiting.resolve(payload.data.result ?? null);
            } else {
                waiting.reject(
                    new Error(
                        JSON.stringify(
                            payload.data.error ?? { code: "PROTOCOL.UNKNOWN" },
                        ),
                    ),
                );
            }
            return null;
        }

        if (kind === "request" && envelope.method === "agent.hello") {
            const version = envelope.protocolVersion;
            const capabilities = capabilityDocumentSchema.safeParse(
                envelope.payload,
            );
            const ok = version === PROTOCOL_VERSION && capabilities.success;
            if (ok) connection.capabilities = capabilities.data;
            return JSON.stringify({
                protocolVersion: PROTOCOL_VERSION,
                kind: "response",
                method: "agent.hello",
                requestId,
                serverId: connection.serverId,
                connectionGeneration: connection.generation,
                sequence: 0,
                deadline: null,
                traceId: null,
                contentHash: null,
                payload: ok
                    ? {
                          ok: true,
                          error: null,
                          result: {
                              connectionGeneration: connection.generation,
                              serverId: connection.serverId,
                          },
                      }
                    : {
                          ok: false,
                          error: {
                              code:
                                  version === PROTOCOL_VERSION
                                      ? "PROTOCOL.INVALID_CAPABILITIES"
                                      : "PROTOCOL.UNSUPPORTED_VERSION",
                              messageKey:
                                  version === PROTOCOL_VERSION
                                      ? "diagnostics.agent.invalid_capabilities"
                                      : "diagnostics.agent.unsupported_version",
                              params:
                                  version === PROTOCOL_VERSION
                                      ? {}
                                      : { version: String(version) },
                          },
                          result: null,
                      },
            });
        }

        // Events (heartbeats, runtime state) need no reply; unknown requests are ignored rather
        // than answered, because the control plane exposes no methods to an agent.
        return null;
    }

    private rejectPending(connection: AgentConnection, reason: string): void {
        for (const [requestId, waiting] of this.pending) {
            if (
                waiting.serverId !== connection.serverId ||
                waiting.connectionGeneration !== connection.generation
            ) {
                continue;
            }
            clearTimeout(waiting.timer);
            this.pending.delete(requestId);
            waiting.reject(new Error(reason));
        }
    }

    /** Fails every in-flight request, used when shutting down. */
    dispose(): void {
        for (const [, waiting] of this.pending) {
            clearTimeout(waiting.timer);
            waiting.reject(new Error("control plane shutting down"));
        }
        this.pending.clear();
        for (const connection of this.connections.values())
            connection.close("control plane shutting down");
        this.connections.clear();
    }
}

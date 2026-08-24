import { z } from "zod";
import { diagnosticSchema } from "./diagnostics.js";

/** Wire contract between the control plane and a target server's editor agent. */

export const AGENT_PROTOCOL_VERSION = 1;

export const agentMethodSchema = z.enum([
    "agent.hello",
    "agent.event",
    "preview.compile",
]);
export type AgentMethod = z.infer<typeof agentMethodSchema>;

/**
 * There is deliberately no `console.execute`, no `bukkit.invoke`, and no `script.upload`.
 * A project editor who can preview an item must not thereby gain arbitrary RPC against a
 * Minecraft server.
 */
export const agentEnvelopeSchema = z.object({
    protocolVersion: z.number().int().min(1).max(1_000),
    kind: z.enum(["request", "response", "event"]),
    method: agentMethodSchema,
    requestId: z.string().min(1).max(64),
    serverId: z.string().min(1).max(128),
    /** Fences mutations issued by a superseded connection. */
    connectionGeneration: z.number().int().min(0),
    sequence: z.number().int().min(0),
    deadline: z.string().datetime().nullable().default(null),
    traceId: z.string().max(64).nullable().default(null),
    contentHash: z.string().max(128).nullable().default(null),
    payload: z.unknown(),
});
export type AgentEnvelope = z.infer<typeof agentEnvelopeSchema>;

export const agentErrorSchema = z.object({
    code: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Z][A-Z0-9_]*(\.[A-Z][A-Z0-9_]*)*$/),
    messageKey: z.string().min(1).max(256),
    params: z
        .record(
            z.string().max(64),
            z.union([z.string().max(512), z.number(), z.boolean()]),
        )
        .default({}),
    traceId: z.string().max(64).nullable().default(null),
});
export type AgentError = z.infer<typeof agentErrorSchema>;

export const agentResponseSchema = z.object({
    ok: z.boolean(),
    error: agentErrorSchema.nullable().default(null),
    diagnostics: z.array(diagnosticSchema).max(512).default([]),
    result: z.unknown().nullable().default(null),
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;

/** Exact payload sent by the preview-only agent during `agent.hello`. */
export const capabilityDocumentSchema = z
    .object({
        schemaVersion: z.literal(1),
        agentVersion: z.string().max(64),
        pluginVersion: z.string().max(64),
        minecraftVersion: z.string().max(32),
        javaVersion: z.string().max(64),
        platform: z.string().min(1).max(64),
        compilerDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        supportedMethods: z.array(z.literal("preview.compile")).length(1),
        activeArtifactDigest: z.null(),
    })
    .strict();
export type CapabilityDocument = z.infer<typeof capabilityDocumentSchema>;

export const agentConnectionStateSchema = z.enum([
    "offline",
    "connecting",
    "handshaking",
    "ready",
    "degraded",
]);
export type AgentConnectionState = z.infer<typeof agentConnectionStateSchema>;

export const serverTargetSchema = z.object({
    serverId: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    environment: z.enum(["development", "staging", "production"]),
    state: agentConnectionStateSchema,
    connectionGeneration: z.number().int().min(0),
    capabilities: capabilityDocumentSchema.nullable(),
    lastSeenAt: z.string().datetime().nullable(),
});
export type ServerTarget = z.infer<typeof serverTargetSchema>;

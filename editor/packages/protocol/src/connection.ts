import { z } from "zod";
import { SUPPORTED_PROJECT_DOCUMENT_SCHEMA_VERSIONS } from "./document.js";

// API transport, authoring documents, and preview artifacts have independent versions.
export const EDITOR_PROTOCOL = { major: 2, minMinor: 0, maxMinor: 0 } as const;
export const handshakeSchema = z.object({
    product: z.literal("itemerness"),
    // Earlier API 2.0 plugins always required Bearer authentication and omitted this field.
    authentication: z.enum(["none", "bearer"]).default("bearer"),
    serverId: z.string().min(1).max(128),
    serverName: z.string().min(1).max(128).optional(),
    serverAlias: z.string().max(80).optional(),
    pluginVersion: z.string().min(1).max(64),
    minecraftVersion: z.string().min(1).max(32),
    platform: z.string().min(1).max(64),
    compilerDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    protocols: z
        .array(
            z
                .object({
                    major: z.number().int().min(1).max(1000),
                    minMinor: z.number().int().min(0).max(1000),
                    maxMinor: z.number().int().min(0).max(1000),
                })
                .refine((range) => range.minMinor <= range.maxMinor),
        )
        .max(16),
    documentSchemas: z.array(z.number().int().positive()).max(16),
    previewSchemas: z.array(z.number().int().positive()).max(16),
    capabilities: z.array(z.string().max(128)).max(128),
    /** Optional server data component ids, used only as editor suggestions. */
    dataComponentTypes: z.array(z.string().max(256)).max(1024).optional(),
    /** Byte limits the plugin applies; plugins before `transfer.limits` omit them and use 2 MiB. */
    limits: z
        .object({
            documentBytes: z.number().int().positive().max(1024 * 1024 * 1024),
            requestBytes: z.number().int().positive().max(1024 * 1024 * 1024),
            responseBytes: z.number().int().positive().max(1024 * 1024 * 1024),
        })
        .optional(),
});
export type Handshake = z.infer<typeof handshakeSchema>;

export interface TransferLimits {
    /** UTF-8 bytes of one serialized document. */
    readonly documentBytes: number;
    /** UTF-8 bytes of a request body, a document plus its envelope. */
    readonly requestBytes: number;
    /** UTF-8 bytes of a response body. */
    readonly responseBytes: number;
}

/** What every plugin accepted before the limits were advertised. */
export const LEGACY_TRANSFER_LIMITS: TransferLimits = {
    documentBytes: 2 * 1024 * 1024,
    requestBytes: 2 * 1024 * 1024,
    responseBytes: 2 * 1024 * 1024,
};

/**
 * The most this editor sends or accepts whatever a plugin advertises. It matches the desktop transport
 * ceiling, so a plugin with larger limits is met with this editor's own bound rather than a failure.
 */
export const EDITOR_TRANSFER_CEILING: TransferLimits = {
    documentBytes: 16 * 1024 * 1024,
    requestBytes: 17 * 1024 * 1024,
    responseBytes: 17 * 1024 * 1024,
};

/** Both peers apply the smaller of their limits, so neither accepts what the other must refuse. */
export function negotiateTransferLimits(
    handshake: Pick<Handshake, "limits">,
): TransferLimits {
    const advertised = handshake.limits ?? LEGACY_TRANSFER_LIMITS;
    return {
        documentBytes: Math.min(
            advertised.documentBytes,
            EDITOR_TRANSFER_CEILING.documentBytes,
        ),
        requestBytes: Math.min(
            advertised.requestBytes,
            EDITOR_TRANSFER_CEILING.requestBytes,
        ),
        responseBytes: Math.min(
            advertised.responseBytes,
            EDITOR_TRANSFER_CEILING.responseBytes,
        ),
    };
}

export function negotiateProtocol(handshake: Handshake): string {
    const compatible = handshake.protocols.filter(
        (range) =>
            range.major === EDITOR_PROTOCOL.major &&
            range.minMinor <= EDITOR_PROTOCOL.maxMinor &&
            range.maxMinor >= EDITOR_PROTOCOL.minMinor,
    );
    if (
        !compatible.length ||
        !SUPPORTED_PROJECT_DOCUMENT_SCHEMA_VERSIONS.some((version) =>
            handshake.documentSchemas.includes(version),
        ) ||
        !handshake.previewSchemas.includes(1) ||
        !["draft.read", "draft.write"].every((capability) =>
            handshake.capabilities.includes(capability),
        )
    ) {
        throw new Error("PROTOCOL_INCOMPATIBLE");
    }
    const minor = Math.max(
        ...compatible.map((range) =>
            Math.min(range.maxMinor, EDITOR_PROTOCOL.maxMinor),
        ),
    );
    return `${EDITOR_PROTOCOL.major}.${minor}`;
}

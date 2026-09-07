import { z } from "zod";

// API transport, authoring documents, and preview artifacts have independent versions.
export const EDITOR_PROTOCOL = { major: 2, minMinor: 0, maxMinor: 0 } as const;
export const handshakeSchema = z.object({
    product: z.literal("itemerness"),
    // Earlier API 2.0 plugins always required Bearer authentication and omitted this field.
    authentication: z.enum(["none", "bearer"]).default("bearer"),
    serverId: z.string().min(1).max(128),
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
});
export type Handshake = z.infer<typeof handshakeSchema>;

export function negotiateProtocol(handshake: Handshake): string {
    const compatible = handshake.protocols.filter(
        (range) =>
            range.major === EDITOR_PROTOCOL.major &&
            range.minMinor <= EDITOR_PROTOCOL.maxMinor &&
            range.maxMinor >= EDITOR_PROTOCOL.minMinor,
    );
    if (
        !compatible.length ||
        !handshake.documentSchemas.includes(1) ||
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

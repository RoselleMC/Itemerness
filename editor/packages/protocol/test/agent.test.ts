import { describe, expect, it } from "vitest";
import {
    capabilityDocumentSchema,
    previewArtifactSchema,
} from "../src/index.js";

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

describe("editor agent protocol", () => {
    it("accepts the exact preview-only capability document emitted by the JVM agent", () => {
        expect(capabilityDocumentSchema.parse(capabilities)).toEqual(
            capabilities,
        );
    });

    it("rejects capabilities that advertise an unimplemented method", () => {
        expect(
            capabilityDocumentSchema.safeParse({
                ...capabilities,
                supportedMethods: ["preview.compile", "draft.validate"],
            }).success,
        ).toBe(false);
    });

    it.each(["DECODE_FAILED", "SNAPSHOT_MISMATCH", "DOCUMENT_INVALID"])(
        "accepts the JVM %s preview refusal",
        (code) => {
            const parsed = previewArtifactSchema.safeParse({
                schemaVersion: 1,
                origin: "agent",
                itemId: "itemerness:test",
                viewer: { locale: "en_us" },
                display: null,
                fidelity: [],
                diagnostics: [],
                digests: { snapshot: "sha256:test" },
                compileMillis: 1,
                failure: {
                    code,
                    messageKey: "diagnostics.document.invalid",
                    params: {},
                },
            });
            expect(parsed.success).toBe(true);
        },
    );
});

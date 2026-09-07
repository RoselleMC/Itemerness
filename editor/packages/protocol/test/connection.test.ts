import { describe, expect, it } from "vitest";
import { handshakeSchema, negotiateProtocol } from "../src/connection.js";

export const handshake = {
    product: "itemerness",
    serverId: "test",
    pluginVersion: "0.1.0",
    minecraftVersion: "26.1.2",
    platform: "Folia",
    compilerDigest: "sha256:" + "0".repeat(64),
    protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
    documentSchemas: [1],
    previewSchemas: [1],
    capabilities: ["draft.read", "draft.write", "preview.compile"],
};

describe("plugin handshake", () => {
    it("defaults older API handshakes to bearer authentication and accepts explicit anonymous mode", () => {
        expect(handshakeSchema.parse(handshake).authentication).toBe("bearer");
        expect(
            handshakeSchema.parse({ ...handshake, authentication: "none" })
                .authentication,
        ).toBe("none");
        expect(
            handshakeSchema.safeParse({
                ...handshake,
                authentication: "unknown",
            }).success,
        ).toBe(false);
    });
    it("negotiates independently of product releases and tolerates additive capabilities", () => {
        const info = handshakeSchema.parse({
            ...handshake,
            pluginVersion: "99.0.0",
            future: true,
            capabilities: [...handshake.capabilities, "future"],
            protocols: [{ major: 2, minMinor: 0, maxMinor: 5 }],
        });
        expect(negotiateProtocol(info)).toBe("2.0");
    });
    it("fails closed for either side's incompatible protocol or schema update", () => {
        for (const update of [
            { protocols: [{ major: 1, minMinor: 0, maxMinor: 9 }] },
            { protocols: [{ major: 3, minMinor: 0, maxMinor: 0 }] },
            { protocols: [{ major: 2, minMinor: 1, maxMinor: 5 }] },
            { documentSchemas: [2] },
            { previewSchemas: [2] },
            { capabilities: ["draft.read"] },
        ])
            expect(() =>
                negotiateProtocol(
                    handshakeSchema.parse({ ...handshake, ...update }),
                ),
            ).toThrow("PROTOCOL_INCOMPATIBLE");
    });
    it("rejects a malformed range or unrelated API", () => {
        expect(
            handshakeSchema.safeParse({
                ...handshake,
                protocols: [{ major: 2, minMinor: 5, maxMinor: 0 }],
            }).success,
        ).toBe(false);
        expect(
            handshakeSchema.safeParse({ ...handshake, product: "other" })
                .success,
        ).toBe(false);
    });
});

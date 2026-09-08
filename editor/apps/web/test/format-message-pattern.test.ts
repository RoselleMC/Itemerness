import { describe, expect, it } from "vitest";
import type { FormatNode } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { formatError } from "../src/features/inspector/formatEditing.js";

describe("MESSAGE formatter patterns", () => {
    const format: Extract<FormatNode, { kind: "namespacedKey" }> = {
        uuid: "10000000-0000-4000-8000-000000000001",
        id: "test:key",
        kind: "namespacedKey",
        mode: "MESSAGE",
        messagePattern: "",
        missingValue: "PATH",
    };

    it.each(["PATH", "FULL_KEY"] as const)(
        "accepts an explicit empty pattern with %s fallback",
        (missingValue) => {
            expect(
                formatError(baselineDocument, { ...format, missingValue }),
            ).toBeNull();
        },
    );

    it("still distinguishes a missing pattern from an explicit empty string", () => {
        expect(
            formatError(baselineDocument, { ...format, messagePattern: null }),
        ).toBe("messagePattern");
        expect(
            formatError(baselineDocument, {
                ...format,
                messagePattern: undefined,
            } as unknown as FormatNode),
        ).toBe("messagePattern");
    });
});

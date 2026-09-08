import { describe, expect, it } from "vitest";
import { baselineDocument } from "../fixtures/baseline.js";
import { contentHash } from "../src/canonical.js";
import {
    SEGMENTED_FRAME_DECORATIONS_CAPABILITY,
    supportsSegmentedFrameDecorations,
    usesSegmentedFrameDecorations,
    EXTENDED_BASE_COMPONENTS_CAPABILITY,
    supportsExtendedBaseComponents,
    usesExtendedBaseComponents,
} from "../src/documentCapabilities.js";

function documentWithFrame() {
    const document = structuredClone(baselineDocument);
    const theme = document.themes.find((entry) => entry.segmentedFrame)!;
    return { document, theme, frame: theme.segmentedFrame! };
}

describe("extended base component capability", () => {
    it("detects all three component IDs including empty clears and disabled items without mutating the document", () => {
        expect(supportsExtendedBaseComponents(undefined)).toBe(false);
        expect(supportsExtendedBaseComponents([])).toBe(false);
        expect(
            supportsExtendedBaseComponents([
                SEGMENTED_FRAME_DECORATIONS_CAPABILITY,
            ]),
        ).toBe(false);
        expect(
            supportsExtendedBaseComponents([
                EXTENDED_BASE_COMPONENTS_CAPABILITY,
            ]),
        ).toBe(true);
        const document = structuredClone(baselineDocument);
        expect(usesExtendedBaseComponents(document)).toBe(false);
        document.items[0]!.enabled = false;
        for (const id of [
            "minecraft:attribute_modifiers",
            "minecraft:enchantments",
            "minecraft:stored_enchantments",
        ]) {
            document.items[0]!.definition.baseComponents = [
                {
                    id,
                    value:
                        id === "minecraft:attribute_modifiers"
                            ? { kind: "list", values: [] }
                            : { kind: "compound", entries: {} },
                },
            ];
            const hash = contentHash(document);
            expect(usesExtendedBaseComponents(document)).toBe(true);
            expect(contentHash(document)).toBe(hash);
        }
    });
});

describe("segmented frame document capability", () => {
    it("requires the exact capability, independently of all other peer metadata", () => {
        expect(supportsSegmentedFrameDecorations(undefined)).toBe(false);
        expect(supportsSegmentedFrameDecorations(null)).toBe(false);
        expect(supportsSegmentedFrameDecorations([])).toBe(false);
        expect(supportsSegmentedFrameDecorations(["preview.compile"])).toBe(
            false,
        );
        expect(
            supportsSegmentedFrameDecorations([
                SEGMENTED_FRAME_DECORATIONS_CAPABILITY,
            ]),
        ).toBe(true);
    });

    it("leaves legacy fields and the original CAS hash unchanged", () => {
        const { document } = documentWithFrame();
        const hash = contentHash(document);
        expect(usesSegmentedFrameDecorations(document)).toBe(false);
        expect(contentHash(document)).toBe(hash);
    });

    it.each(["top", "body", "connector", "bottom"] as const)(
        "detects %s decoration fields even when null or inactive",
        (row) => {
            for (const field of ["center", "kern"] as const) {
                for (const value of [null, "frame.decoration"]) {
                    const { document, theme, frame } = documentWithFrame();
                    frame[row]![field] = value;
                    const hash = contentHash(document);
                    expect(usesSegmentedFrameDecorations(document)).toBe(true);
                    expect(contentHash(document)).toBe(hash);
                    theme.renderer = "NATIVE_TOOLTIP_STYLE";
                    expect(usesSegmentedFrameDecorations(document)).toBe(true);
                }
            }
        },
    );

    it.each([false, true])("detects an explicit includeName of %s", (value) => {
        const { document, frame } = documentWithFrame();
        frame.includeName = value;
        expect(usesSegmentedFrameDecorations(document)).toBe(true);
    });

    it("requires the capability for a segmented tooltip style, not the legacy nullable field", () => {
        const { document, theme } = documentWithFrame();
        expect(theme.tooltipStyle).toBeNull();
        expect(usesSegmentedFrameDecorations(document)).toBe(false);
        theme.tooltipStyle = "example:custom";
        expect(usesSegmentedFrameDecorations(document)).toBe(true);
        theme.renderer = "NATIVE_TOOLTIP_STYLE";
        expect(usesSegmentedFrameDecorations(document)).toBe(false);
    });

    it("does not interpret editor extension payloads as submitted compiler fields", () => {
        const { document, theme } = documentWithFrame();
        theme.extensions = {
            editorRendererState: { includeName: false, center: null },
        };
        expect(usesSegmentedFrameDecorations(document)).toBe(false);
    });
});

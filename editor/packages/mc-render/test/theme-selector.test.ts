import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type {
    DataValue,
    PreviewViewer,
    ProjectDocument,
    ThemeSelectorNode,
} from "@itemerness/protocol";
import { PresentationFonts } from "../src/fonts.js";
import { composeLocalPreview, selectTheme } from "../src/compose.js";

const artifact = readFontMetricsArtifact(
    new Uint8Array(
        readFileSync(
            fileURLToPath(
                new URL(
                    "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm",
                    import.meta.url,
                ),
            ),
        ),
    ),
);
const fonts = new PresentationFonts({
    artifact,
    fonts: baselineDocument.fonts,
    glyphs: baselineDocument.glyphs,
    spacing: baselineDocument.spacing,
});
const viewer = (overrides: Partial<PreviewViewer> = {}): PreviewViewer => ({
    locale: "en_us",
    requestedTheme: null,
    assetProfile: null,
    capabilities: [],
    metricsRevision: null,
    resourcePackLoaded: false,
    managesVanillaTooltipLines: false,
    direction: "LEFT_TO_RIGHT",
    ...overrides,
});

const integer = (value: number): DataValue => ({
    kind: "integer",
    value: String(value),
});

// The same selector as the Kotlin ManagedDocumentValidationTest parity case, plus a fact case.
const selector: ThemeSelectorNode = {
    uuid: "8c7c4b1e-6a7e-4a55-9b8e-2f3c0b6d5a10",
    id: "example:charge-frame",
    cases: [
        {
            condition: {
                operator: "GREATER_THAN_OR_EQUAL",
                left: { kind: "data", key: "example:charges" },
                right: { kind: "literal", value: integer(3) },
            },
            theme: "itemerness:default",
        },
        {
            condition: {
                operator: "GREATER_THAN_OR_EQUAL",
                left: { kind: "fact", key: "example:level" },
                right: { kind: "literal", value: integer(10) },
            },
            theme: "itemerness:ember",
        },
    ],
    defaultTheme: "itemerness:vanilla-frame",
};

function document(charges: number, level?: number): ProjectDocument {
    const draft = structuredClone(baselineDocument);
    draft.themeSelectors = [selector];
    const item = draft.items[0]!;
    item.presentation.theme = selector.id;
    item.previewData = item.previewData.map((entry) =>
        entry.key === "example:charges"
            ? { ...entry, value: integer(charges) }
            : entry,
    );
    if (level !== undefined)
        draft.viewerFacts = draft.viewerFacts.map((fact) =>
            fact.id === "example:level"
                ? { ...fact, previewValue: integer(level) }
                : fact,
        );
    return draft;
}

const compose = (
    draft: ProjectDocument,
    overrides: Partial<PreviewViewer> = {},
) =>
    composeLocalPreview({
        document: draft,
        itemId: "itemerness:travel-token",
        viewer: viewer(overrides),
        fonts,
    }).display;

describe("local theme selector resolution", () => {
    it("selects from preview data like the production compiler", () => {
        const matched = compose(document(3));
        expect(matched.requestedTheme).toBe("itemerness:default");
        expect(matched.selectedTheme).toBe("itemerness:default");
        const unmatched = compose(document(2));
        expect(unmatched.requestedTheme).toBe("itemerness:vanilla-frame");
        expect(unmatched.selectedTheme).toBe("itemerness:vanilla-frame");
    });

    it("reads persona facts and still applies the chosen theme's fallback chain", () => {
        const display = compose(document(2, 12));
        expect(display.requestedTheme).toBe("itemerness:ember");
        // Ember needs a resource pack; without one its fallback renders.
        expect(display.selectedTheme).not.toBe("itemerness:ember");
        expect(display.fallbackReasons[0]).toMatchObject({
            theme: "itemerness:ember",
            code: "RESOURCE_PACK_UNAVAILABLE",
        });
    });

    it("lets a viewer override outrank the selector and evaluates a requested selector", () => {
        expect(
            compose(document(3), { requestedTheme: "itemerness:vanilla-frame" })
                .selectedTheme,
        ).toBe("itemerness:vanilla-frame");
        const plain = structuredClone(document(3));
        plain.items[0]!.presentation.theme = "itemerness:vanilla-frame";
        expect(
            compose(plain, { requestedTheme: selector.id }).selectedTheme,
        ).toBe("itemerness:default");
    });

    it("uses the first matching case, the default otherwise, and treats missing data as unmatched", () => {
        const both = new Map([["example:charges", integer(5)]]);
        const facts = new Map([["example:level", integer(50)]]);
        const draft = document(0);
        expect(selectTheme(draft, selector.id, both, facts)).toBe(
            "itemerness:default",
        );
        expect(selectTheme(draft, selector.id, new Map(), facts)).toBe(
            "itemerness:ember",
        );
        expect(selectTheme(draft, selector.id, new Map(), new Map())).toBe(
            "itemerness:vanilla-frame",
        );
        expect(
            selectTheme(draft, "itemerness:aurora-canvas", both, facts),
        ).toBe("itemerness:aurora-canvas");
        expect(
            selectTheme(
                { themeSelectors: [{ ...selector, cases: [] }] },
                selector.id,
                both,
                facts,
            ),
        ).toBe("itemerness:vanilla-frame");
    });
});

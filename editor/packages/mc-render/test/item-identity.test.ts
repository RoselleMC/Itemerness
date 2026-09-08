import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import type { PreviewViewer } from "@itemerness/protocol";
import { PresentationFonts } from "../src/fonts.js";
import { composeLocalPreview } from "../src/compose.js";

const fonts = new PresentationFonts({
    artifact: readFontMetricsArtifact(
        new Uint8Array(
            readFileSync(
                new URL(
                    "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm",
                    import.meta.url,
                ),
            ),
        ),
    ),
    fonts: baselineDocument.fonts,
    glyphs: baselineDocument.glyphs,
    spacing: baselineDocument.spacing,
});
const viewer: PreviewViewer = {
    locale: "en_us",
    requestedTheme: null,
    assetProfile: null,
    capabilities: [],
    metricsRevision: null,
    resourcePackLoaded: false,
    managesVanillaTooltipLines: false,
    direction: "LEFT_TO_RIGHT",
};

describe("local preview item identity", () => {
    it("recomputes inherited presentation defaults locally while leaving explicit items bound", () => {
        const document = structuredClone(baselineDocument);
        document.schemaVersion = 2;
        document.defaultLayout = "itemerness:plain";
        document.defaultTheme = "itemerness:default";
        document.items[0]!.presentation.layout = null;
        document.items[0]!.presentation.theme = null;
        const render = (itemId: string) =>
            composeLocalPreview({ document, itemId, viewer, fonts });
        expect(render("itemerness:travel-token").display.selectedTheme).toBe(
            "itemerness:default",
        );
        const explicit = render("itemerness:ember-blade").display;
        document.defaultTheme = "itemerness:vanilla-frame";
        expect(render("itemerness:travel-token").display.selectedTheme).toBe(
            "itemerness:vanilla-frame",
        );
        expect(render("itemerness:ember-blade").display).toEqual(explicit);
        expect(document.items[0]!.presentation.theme).toBeNull();
    });
    it("resolves qualified selections and nested item names independently of the root namespace", () => {
        const document = structuredClone(baselineDocument);
        document.items[0]!.id = "travel-token";
        document.items[1]!.id = "equipment:travel-token";
        const container = document.items[3]!;
        container.definition.contents = [
            { item: "itemerness:travel-token", amount: 1 },
            { item: "equipment:travel-token", amount: 2 },
        ];
        container.presentation.blocks = [
            {
                uuid: crypto.randomUUID(),
                type: "nestedItemList",
                style: "value",
                anchor: null,
            },
        ];
        const names = document.locales.find(
            (locale) => locale.locale === viewer.locale,
        )!.messages;
        names[document.items[0]!.presentation.nameMessage] = "Root token";
        names[document.items[1]!.presentation.nameMessage] = "Equipment token";
        const selected = composeLocalPreview({
            document,
            itemId: "equipment:travel-token",
            viewer,
            fonts,
        });
        expect(
            selected.display.displayName.runs.map((run) => run.text).join(""),
        ).toBe("Equipment token");
        const nested = composeLocalPreview({
            document,
            itemId: "itemerness:nested-satchel",
            viewer,
            fonts,
        });
        const lore = nested.display.lore
            .flatMap((line) => line.runs)
            .map((run) => run.text)
            .join(" ");
        expect(lore).toContain("Root token");
        expect(lore).toContain("Equipment token");
    });
});

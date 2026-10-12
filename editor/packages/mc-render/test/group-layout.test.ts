import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFontMetricsArtifact } from "@itemerness/mc-assets";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    projectDocumentSchema,
    type PreviewViewer,
    type ProjectDocument,
} from "@itemerness/protocol";
import { composeLocalPreview } from "../src/compose.js";
import { PresentationFonts } from "../src/fonts.js";

const artifact = readFontMetricsArtifact(
    new Uint8Array(
        readFileSync(
            new URL(
                "../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm",
                import.meta.url,
            ),
        ),
    ),
);
const cases = JSON.parse(
    readFileSync(
        new URL(
            "../../protocol/fixtures/group-layout-cases.json",
            import.meta.url,
        ),
        "utf8",
    ),
) as Array<{
    name: string;
    theme: string;
    changes: Array<{ path: Array<string | number>; value: unknown }>;
}>;
const golden = JSON.parse(
    readFileSync(
        new URL(
            "../../protocol/fixtures/group-layout-golden.json",
            import.meta.url,
        ),
        "utf8",
    ),
) as Record<string, unknown>;

function apply(changes: (typeof cases)[number]["changes"]): ProjectDocument {
    const document = structuredClone(baselineDocument);
    for (const change of changes) {
        let target = document as unknown as Record<string | number, unknown>;
        for (const segment of change.path.slice(0, -1))
            target = target[segment] as Record<string | number, unknown>;
        target[change.path.at(-1)!] = structuredClone(change.value);
    }
    // The fixture must be a document the editor itself would accept and send.
    return projectDocumentSchema.parse(document);
}

function render(document: ProjectDocument, theme: string) {
    const viewer: PreviewViewer = {
        locale: "en_us",
        requestedTheme: theme,
        assetProfile: "itemerness:example-pack-v1",
        metricsRevision: "itemerness:example-pack-v1",
        capabilities: [
            "itemerness:native-tooltip-style-v1",
            "itemerness:segmented-frame-v1",
            "itemerness:signed-advance-v1",
            "itemerness:bitmap-canvas-v1",
        ],
        resourcePackLoaded: true,
        managesVanillaTooltipLines: true,
        direction: "LEFT_TO_RIGHT",
    };
    return composeLocalPreview({
        document,
        itemId: "itemerness:nested-satchel",
        viewer,
        fonts: new PresentationFonts({
            artifact,
            fonts: document.fonts,
            glyphs: document.glyphs,
            spacing: document.spacing,
        }),
    });
}

describe("local group paint parity with the production compiler", () => {
    it.each(cases)(
        "matches the production Kotlin golden: $name",
        ({ name, theme, changes }) => {
            const { display } = render(apply(changes), theme);
            expect({
                displayName: display.displayName,
                lore: display.lore,
                renderer: display.renderer,
                selectedTheme: display.selectedTheme,
                tooltipStyle: display.tooltipStyle,
                fallbackReasons: display.fallbackReasons,
            }).toEqual(golden[name]);
        },
    );

    it("attributes decorated rows to their own blocks and gap lines to none", () => {
        const tree = cases.find((entry) => entry.name === "gapped-layout")!;
        const document = apply(tree.changes);
        const { lineOrigins, display } = render(document, tree.theme);
        const group = document.items[3]!.presentation.blocks[0]!;
        if (group.type !== "group") throw new Error("Expected a group");
        expect(lineOrigins[0]).toBe(group.children[0]!.uuid);
        expect(lineOrigins[1]).toBeNull();
        expect(display.lore[1]!.runs.map((run) => run.text).join("")).toContain(
            "│",
        );
    });
});

import { baselineDocument } from "./baseline.js";
import fixture from "./segmented-frame-fixture.json" with { type: "json" };
import type { ProjectDocument, ThemeNode } from "../src/document.js";

export function segmentedFrameDocument(): ProjectDocument {
    const document = structuredClone(baselineDocument);
    document.glyphs.push(...structuredClone(fixture.glyphs));
    const theme = document.themes.find(
        (entry) => entry.renderer === "SEGMENTED_FRAME",
    )!;
    theme.segmentedFrame = structuredClone(fixture.frame);
    theme.tooltipStyle = "itemerness:transparent-canvas";
    theme.styles.frame = {
        color: "white",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    };
    document.items[0]!.presentation.theme = theme.id;
    for (const locale of document.locales) {
        locale.messages[document.items[0]!.presentation.nameMessage] = "Name";
        locale.messages["item.travel-token.description"] = "Body";
    }
    return document;
}

export const segmentedFrameCases = fixture.cases as Array<{
    name: string;
    frame: Partial<NonNullable<ThemeNode["segmentedFrame"]>>;
}>;

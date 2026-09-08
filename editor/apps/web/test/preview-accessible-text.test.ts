import { describe, expect, it } from "vitest";
import type { PreviewLine, PreviewRun } from "@itemerness/protocol";
import { previewAccessibleText } from "../src/features/stage/previewAccessibleText.js";

function run(text: string, kind: PreviewRun["kind"]): PreviewRun {
    return {
        text,
        kind,
        unbreakable: false,
        style: {
            color: null,
            font: null,
            bold: false,
            italic: false,
            underlined: false,
            strikethrough: false,
        },
    };
}
function line(runs: PreviewRun[]): PreviewLine {
    return {
        runs,
        logicalWidthPixels: 0,
        visualBounds: { left: 0, top: 0, right: 0, bottom: 0 },
    };
}

describe("preview accessible text", () => {
    it.each([
        "FRAME",
        "SPACING",
        "WIDTH_ANCHOR",
        "HEIGHT_ANCHOR",
        "BITMAP",
    ] as const)(
        "excludes %s layout runs even when their glyphs are ordinary letters",
        (kind) =>
            expect(
                previewAccessibleText(
                    line([
                        run("decorative", kind),
                        run("Actual value", "TEXT"),
                        run("\ue001".repeat(300), kind),
                    ]),
                ),
            ).toBe("Actual value"),
    );

    it("preserves private-use and supplementary characters in content and icons", () => {
        const content = line([
            run("\ue001", "ICON"),
            run(" Value \ue002\u{f0001}", "TEXT"),
        ]);
        const original = structuredClone(content);
        expect(previewAccessibleText(content)).toBe(
            "\ue001 Value \ue002\u{f0001}",
        );
        expect(content).toEqual(original);
    });

    it("preserves text order across styled runs and leaves empty lines for contextual fallback", () => {
        expect(
            previewAccessibleText(
                line([
                    run(" Attack", "TEXT"),
                    run("\ue101", "SPACING"),
                    run(": 10 ", "TEXT"),
                ]),
            ),
        ).toBe("Attack: 10");
        expect(
            previewAccessibleText(
                line([run("\ue002", "FRAME"), run(" ", "TEXT")]),
            ),
        ).toBe("");
        expect(previewAccessibleText(undefined)).toBe("");
    });
});

import type { PreviewLine } from "@itemerness/protocol";

/** Use semantic run kinds, never Unicode ranges, to leave layout glyphs out of accessible names. */
export function previewAccessibleText(line: PreviewLine | undefined): string {
    return (
        line?.runs
            .filter((run) => run.kind === "TEXT" || run.kind === "ICON")
            .map((run) => run.text)
            .join("")
            .trim() ?? ""
    );
}

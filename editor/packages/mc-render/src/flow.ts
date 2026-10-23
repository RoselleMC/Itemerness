import type {
    LayoutNode,
    MarkerPiece as ThemePiece,
    PreviewLine,
    PreviewRun,
    ProjectDocument,
    ThemeNode,
} from "@itemerness/protocol";
import type { PresentationFonts } from "./fonts.js";
import { parseColor } from "./colors.js";
import { measureLine } from "./measure.js";
import { LayoutOverflowError, ellipsizeLine, wrapRuns } from "./wrap.js";

/** One container level's contribution to a line prefix; blank pieces are equal-width padding. */
export type MarkerPiece =
    | "BULLET"
    | "BULLET_BLANK"
    | "TREE_BRANCH"
    | "TREE_LAST"
    | "TREE_VERTICAL"
    | "TREE_BLANK";

const BLANK_PIECES: ReadonlySet<MarkerPiece> = new Set([
    "BULLET_BLANK",
    "TREE_BLANK",
]);

export interface FlowBlock {
    runs: PreviewRun[];
    origin: string;
    kind: "field" | "description" | "generic" | "row" | "rule";
    /** A row's right region, aligned to the far content edge; `runs` holds its left region. */
    right?: PreviewRun[];
    wrapping: string | null;
    fieldValueIndex: number | null;
    /** Mirrors the compiler's section boundary: a frame divider precedes this row. */
    boundaryBefore?: boolean;
    /** Marker pieces, outermost first, for the row's first line, later lines, and gaps above it. */
    firstPrefix?: readonly MarkerPiece[];
    continuationPrefix?: readonly MarkerPiece[];
    gapPrefix?: readonly MarkerPiece[];
    gapBeforeLines?: number;
}
export interface ComposedLine {
    line: PreviewLine;
    origin: string | null;
}
export interface FlowResult {
    lines: ComposedLine[];
    boundaries: Set<number>;
    targetWidth: number;
}

export function themeStyle(
    theme: ThemeNode,
    role: string,
    fontRole = "text",
): PreviewRun["style"] {
    const source = theme.styles[role];
    const color =
        role === "label"
            ? "gray"
            : role === "description" || role === "rule"
              ? "dark_gray"
              : role === "requirement-met"
                ? "green"
                : role === "requirement-unmet"
                  ? "red"
                  : "white";
    return {
        color: parseColor(source?.color ?? color),
        font: theme.fonts[fontRole] ?? theme.fonts.text ?? "minecraft:default",
        bold: source?.bold ?? false,
        italic: source?.italic ?? false,
        underlined: source?.underlined ?? false,
        strikethrough: source?.strikethrough ?? false,
    };
}

export function lineOf(
    runs: readonly PreviewRun[],
    fonts: PresentationFonts,
): PreviewLine {
    const measured = measureLine(runs, fonts, { lenient: true });
    return {
        runs: [...runs],
        logicalWidthPixels: measured.logicalWidthPixels,
        visualBounds: measured.visualBounds,
    };
}

/** Local port of PresentationEngine's flow and frame layout, using the existing font/wrap engine. */
export class FlowComposer {
    constructor(
        private readonly document: ProjectDocument,
        private readonly theme: ThemeNode,
        private readonly layout: LayoutNode,
        private readonly fonts: PresentationFonts,
    ) {}
    private line(runs: readonly PreviewRun[]) {
        return lineOf(runs, this.fonts);
    }
    private width(runs: readonly PreviewRun[]) {
        return this.line(runs).logicalWidthPixels;
    }
    private run(
        text: string,
        style: PreviewRun["style"],
        kind: PreviewRun["kind"] = "TEXT",
        unbreakable = true,
    ): PreviewRun {
        return { text, style, kind, unbreakable };
    }
    private plainStyle(style = themeStyle(this.theme, "value")) {
        return { ...style, bold: false, italic: false };
    }
    private spacing(
        pixels: number,
        kind: PreviewRun["kind"] = "SPACING",
    ): PreviewRun[] {
        const provider = this.document.spacing;
        if (!provider)
            throw new LayoutOverflowError("Signed spacing is unavailable");
        const output: PreviewRun[] = [];
        let remaining = pixels;
        while (remaining !== 0) {
            const part =
                remaining > 0
                    ? Math.min(
                          remaining,
                          provider.positive.maximumAdvancePixels,
                      )
                    : Math.max(
                          remaining,
                          provider.negative.minimumAdvancePixels,
                      );
            const cp = this.fonts.spacingCodePoint(part);
            if (!part || cp === null || output.length >= 128)
                throw new LayoutOverflowError("Spacing is not representable");
            output.push(
                this.run(
                    String.fromCodePoint(cp),
                    {
                        color: null,
                        font: provider.font,
                        bold: false,
                        italic: false,
                        underlined: false,
                        strikethrough: false,
                    },
                    kind,
                ),
            );
            remaining -= part;
        }
        return output;
    }
    private padding(
        pixels: number,
        style: PreviewRun["style"],
        bounded = false,
    ): PreviewRun[] {
        if (pixels <= 0) return [];
        if (this.theme.requiresResourcePack && this.document.spacing)
            return this.spacing(pixels);
        const space = this.run(" ", this.plainStyle(style));
        const count = pixels / Math.max(1, this.width([space]));
        return [
            {
                ...space,
                text: " ".repeat(
                    bounded ? Math.floor(count) : Math.ceil(count),
                ),
            },
        ];
    }
    private anchor(pixels: number, style: PreviewRun["style"]): PreviewRun[] {
        if (pixels <= 0) return [];
        if (this.theme.requiresResourcePack && this.document.spacing)
            return this.spacing(pixels, "WIDTH_ANCHOR");
        const unit = this.run(
            "\u200c",
            {
                ...style,
                bold: true,
                italic: false,
                underlined: false,
                strikethrough: false,
            },
            "WIDTH_ANCHOR",
        );
        if (this.width([unit]) !== 1)
            throw new LayoutOverflowError(
                "The one-pixel width anchor is unavailable",
            );
        return [{ ...unit, text: unit.text.repeat(pixels) }];
    }
    private readonly markerCache = new Map<MarkerPiece, PreviewRun[]>();
    private get markerRole(): string {
        return this.theme.markers?.style ?? "label";
    }
    private markerStyle(): PreviewRun["style"] {
        return themeStyle(this.theme, this.markerRole);
    }
    /** The theme's art for one piece, or the built-in default; blank pieces have none. */
    private markerArt(piece: MarkerPiece): PreviewRun[] {
        const markers = this.theme.markers;
        const source =
            piece === "BULLET"
                ? (markers?.bullet ?? {
                      kind: "text" as const,
                      text: "\u2022 ",
                  })
                : piece === "TREE_BRANCH"
                  ? (markers?.tree?.branch ?? {
                        kind: "text" as const,
                        text: "\u251c\u2500 ",
                    })
                  : piece === "TREE_LAST"
                    ? (markers?.tree?.last ?? {
                          kind: "text" as const,
                          text: "\u2514\u2500 ",
                      })
                    : piece === "TREE_VERTICAL"
                      ? (markers?.tree?.vertical ?? {
                            kind: "text" as const,
                            text: "\u2502  ",
                        })
                      : null;
        if (!source) return [];
        if (source.kind === "text")
            return [this.run(source.text, this.markerStyle())];
        const glyph = this.document.glyphs.find(
            (entry) => entry.id === source.glyph,
        );
        if (!glyph)
            throw new LayoutOverflowError("Marker glyph is not declared");
        return [
            this.run(String.fromCodePoint(glyph.codePoint), {
                ...this.markerStyle(),
                font: glyph.font,
                bold: false,
                italic: false,
            }),
        ];
    }
    private slotWidth(piece: MarkerPiece): number {
        const gap = this.theme.markers?.gapPixels ?? 0;
        if (piece === "BULLET" || piece === "BULLET_BLANK")
            return gap + this.width(this.markerArt("BULLET"));
        return (
            gap +
            Math.max(
                ...(["TREE_BRANCH", "TREE_LAST", "TREE_VERTICAL"] as const).map(
                    (entry) => this.width(this.markerArt(entry)),
                ),
            )
        );
    }
    private markerPadding(pixels: number): PreviewRun[] {
        return this.exactPadding(pixels, this.markerStyle());
    }
    /** Exact-width padding: signed spacing in pack themes, else spaces plus one-pixel anchors. */
    exactPadding(pixels: number, style: PreviewRun["style"]): PreviewRun[] {
        if (pixels <= 0) return [];
        if (this.theme.requiresResourcePack && this.document.spacing)
            return this.spacing(pixels);
        const plain = {
            ...style,
            bold: false,
            italic: false,
            underlined: false,
            strikethrough: false,
        };
        const space = this.run(" ", plain);
        const count = Math.floor(pixels / Math.max(1, this.width([space])));
        const spaces = count > 0 ? [{ ...space, text: " ".repeat(count) }] : [];
        return [...spaces, ...this.anchor(pixels - this.width(spaces), plain)];
    }
    /** One authored text or glyph piece in a role's style. */
    private pieceRuns(source: ThemePiece, role: string): PreviewRun[] {
        if (source.kind === "text")
            return [this.run(source.text, themeStyle(this.theme, role))];
        const glyph = this.document.glyphs.find(
            (entry) => entry.id === source.glyph,
        );
        if (!glyph)
            throw new LayoutOverflowError("Piece glyph is not declared");
        return [
            this.run(String.fromCodePoint(glyph.codePoint), {
                ...themeStyle(this.theme, role),
                font: glyph.font,
                bold: false,
                italic: false,
            }),
        ];
    }
    private get ruleRole(): string {
        return this.theme.rules?.style ?? "rule";
    }
    private ruleFill(): PreviewRun[] {
        return this.pieceRuns(
            this.theme.rules?.fill ?? { kind: "text", text: "─" },
            this.ruleRole,
        );
    }
    private ruleCaps(): { left: PreviewRun[]; right: PreviewRun[] } {
        const rules = this.theme.rules;
        return {
            left: rules?.left ? this.pieceRuns(rules.left, this.ruleRole) : [],
            right: rules?.right
                ? this.pieceRuns(rules.right, this.ruleRole)
                : [],
        };
    }
    private ruleGap(): number {
        return this.theme.rules?.titleGapPixels ?? 4;
    }
    /** A titled rule needs room for its title and one fill unit on each side; a bare rule stretches. */
    private ruleWidth(block: FlowBlock): number | null {
        const title = this.explicit(block.runs).flat();
        if (!title.length) return null;
        const caps = this.ruleCaps();
        return (
            this.width([...caps.left, ...caps.right]) +
            this.width(title) +
            2 * this.ruleGap() +
            2 * this.width(this.ruleFill())
        );
    }
    /**
     * A horizontal rule across the available width. Fill units repeat whole; the remainder is
     * exact padding beside the title, or at the end of an untitled rule.
     */
    private renderRule(block: FlowBlock, available: number): PreviewRun[] {
        const fill = this.ruleFill()[0]!;
        const fillWidth = this.width([fill]);
        if (fillWidth <= 0)
            throw new LayoutOverflowError(
                "Rule fill must have a positive advance",
            );
        const { left, right } = this.ruleCaps();
        const caps = this.width([...left, ...right]);
        const paddingStyle = themeStyle(this.theme, this.ruleRole);
        const fillRuns = (count: number) =>
            count <= 0 ? [] : [{ ...fill, text: fill.text.repeat(count) }];
        const title = this.explicit(block.runs).flat();
        if (!title.length) {
            const space = available - caps;
            if (space < fillWidth)
                throw new LayoutOverflowError("Rule has no room for its fill");
            const count = Math.floor(space / fillWidth);
            return [
                ...left,
                ...fillRuns(count),
                ...right,
                ...this.exactPadding(space - count * fillWidth, paddingStyle),
            ];
        }
        const gap = this.ruleGap();
        const titleRoom = available - caps - 2 * gap - 2 * fillWidth;
        if (titleRoom <= 0)
            throw new LayoutOverflowError("Rule has no room for its title");
        const fitted = ellipsizeLine(title, this.fonts, titleRoom);
        const space = available - caps - 2 * gap - fitted.logicalWidthPixels;
        const leading = Math.floor(Math.floor(space / 2) / fillWidth);
        const trailing = Math.floor((space - leading * fillWidth) / fillWidth);
        const remainder = space - (leading + trailing) * fillWidth;
        const before = Math.floor(remainder / 2);
        return [
            ...left,
            ...fillRuns(leading),
            ...this.exactPadding(gap + before, paddingStyle),
            ...fitted.runs,
            ...this.exactPadding(gap + remainder - before, paddingStyle),
            ...fillRuns(trailing),
            ...right,
        ];
    }
    /** A row's left lines and its flattened right region. */
    private rowRegions(block: FlowBlock): {
        left: PreviewRun[][];
        right: PreviewRun[];
    } {
        return {
            left: this.explicit(block.runs).filter((line) => line.length),
            right: this.explicit(block.right ?? []).flat(),
        };
    }
    private rowGap(right: readonly PreviewRun[]): number {
        return this.width([
            this.run(" ", { ...right[0]!.style, bold: false, italic: false }),
        ]);
    }
    private markerRuns(piece: MarkerPiece): PreviewRun[] {
        let runs = this.markerCache.get(piece);
        if (!runs) {
            const art = this.markerArt(piece);
            runs = [
                ...art,
                ...this.markerPadding(this.slotWidth(piece) - this.width(art)),
            ];
            this.markerCache.set(piece, runs);
        }
        return runs;
    }
    private prefixRuns(
        prefix: readonly MarkerPiece[] | undefined,
    ): PreviewRun[] {
        return (prefix ?? []).flatMap((piece) => this.markerRuns(piece));
    }
    private prefixWidth(block: FlowBlock): number {
        if (!block.firstPrefix?.length && !block.continuationPrefix?.length)
            return 0;
        return Math.max(
            this.width(this.prefixRuns(block.firstPrefix)),
            this.width(this.prefixRuns(block.continuationPrefix)),
        );
    }
    /** An empty line that keeps the connectors of decorated ancestors continuous. */
    private gapLine(prefix: readonly MarkerPiece[] | undefined): PreviewLine {
        const visible = [...(prefix ?? [])];
        while (visible.length && BLANK_PIECES.has(visible.at(-1)!))
            visible.pop();
        if (!visible.length) return this.line([]);
        return this.line([
            ...this.padding(
                this.theme.content?.leftPaddingPixels ?? 0,
                this.markerStyle(),
            ),
            ...this.prefixRuns(visible),
        ]);
    }
    private explicit(runs: readonly PreviewRun[]): PreviewRun[][] {
        const lines: PreviewRun[][] = [[]];
        for (const run of runs)
            run.text.split("\n").forEach((part, i) => {
                if (i) lines.push([]);
                if (part) lines.at(-1)!.push({ ...run, text: part });
            });
        return lines;
    }
    flow(blocks: readonly FlowBlock[], maximum: number): FlowResult {
        if (maximum < 1)
            throw new LayoutOverflowError(
                "Padding consumes the available width",
            );
        const layout = this.layout.kind === "flow" ? this.layout : null;
        const requestedMinimum = Math.max(
            layout?.minimumWidthPixels ?? 1,
            this.theme.content?.minimumWidthPixels ?? 1,
        );
        if (blocks.length && requestedMinimum > maximum)
            throw new LayoutOverflowError(
                "Minimum width exceeds the available width",
            );
        const minimum = Math.min(maximum, requestedMinimum);
        const themeLeft = this.theme.content?.leftPaddingPixels ?? 0;
        const themeRight = this.theme.content?.rightPaddingPixels ?? 0;
        // Rules span the whole content width; an icon row uses field padding.
        const sectionPadding = (block: FlowBlock) => {
            if (!layout || block.kind === "rule") return { left: 0, right: 0 };
            const icon = this.explicit(block.runs)[0]?.some(
                (run) => run.kind === "ICON",
            );
            return block.kind === "description" && !icon
                ? {
                      left: layout.descriptionLeftPaddingPixels,
                      right: layout.descriptionRightPaddingPixels,
                  }
                : { left: layout.fieldLeftPaddingPixels, right: 0 };
        };
        const padding = (block: FlowBlock) => {
            const section = sectionPadding(block);
            return {
                left: themeLeft + section.left,
                right: themeRight + section.right,
            };
        };
        const textFont = this.theme.fonts.text ?? "minecraft:default";
        const iconGap = (runs: readonly PreviewRun[]) => {
            if (!layout || runs[0]?.kind !== "ICON") return [...runs];
            const first = runs[0];
            // A fixed icon slot pads narrower icons so every label starts in the same column.
            const slot =
                layout.fieldIconSlotPixels === undefined
                    ? []
                    : this.exactPadding(
                          layout.fieldIconSlotPixels - this.width([first]),
                          { ...first.style, font: textFont },
                      );
            return [
                first,
                ...slot,
                ...this.padding(layout.fieldIconGapPixels, first.style),
                ...runs.slice(1),
            ];
        };
        const policyFor = (block: FlowBlock) =>
            (block.wrapping && this.layout.wrapping[block.wrapping]) ||
            this.layout.wrapping.body ||
            Object.values(this.layout.wrapping)[0];
        const rowWidth = (block: FlowBlock): number | null => {
            const { left, right } = this.rowRegions(block);
            if (!left.length && !right.length) return null;
            const leftWidth = left.length
                ? Math.max(...left.map((line) => this.width(iconGap(line))))
                : 0;
            if (!right.length) return leftWidth;
            const rightWidth = this.width(right);
            if (!left.length) return rightWidth;
            return leftWidth + this.rowGap(right) + rightWidth;
        };
        const natural = (block: FlowBlock): number | null =>
            block.kind === "row"
                ? rowWidth(block)
                : block.kind === "rule"
                  ? this.ruleWidth(block)
                  : Math.max(
                        ...this.explicit(block.runs).map((runs) =>
                            this.width(iconGap(runs)),
                        ),
                    );
        const target = Math.min(
            maximum,
            Math.max(
                minimum,
                ...blocks.map((block) => {
                    const width = natural(block);
                    if (width === null) return 0;
                    const pads = padding(block);
                    const contribution =
                        width +
                        pads.left +
                        pads.right +
                        this.prefixWidth(block);
                    // A wrapping width bounds the block's own lines, so it must not widen the tooltip past it.
                    const bound = policyFor(block)?.widthPixels;
                    return bound == null
                        ? contribution
                        : Math.min(contribution, bound);
                }),
            ),
        );
        const lines: ComposedLine[] = [];
        const boundaries = new Set<number>();
        const gap = (pixels: number, prefix?: readonly MarkerPiece[]) => {
            for (let i = 0; i < Math.floor(pixels / 10); i++)
                lines.push({ line: this.gapLine(prefix), origin: null });
        };
        blocks.forEach((block, blockIndex) => {
            if ((block.boundaryBefore ?? true) && lines.length)
                boundaries.add(lines.length);
            for (let i = 0; i < (block.gapBeforeLines ?? 0); i++)
                lines.push({
                    line: this.gapLine(block.gapPrefix),
                    origin: null,
                });
            if (block.kind === "description" && lines.length)
                gap(layout?.descriptionGapBeforePixels ?? 0, block.gapPrefix);
            const policy = policyFor(block);
            const pads = padding(block);
            const sectionLeft = sectionPadding(block).left;
            const indent = policy?.continuationIndentPixels ?? 0;
            // Marker prefixes are measured runs, so the text beside them wraps in what remains.
            const available =
                Math.min(policy?.widthPixels ?? target, target) -
                pads.left -
                pads.right -
                this.prefixWidth(block);
            if (available < 1)
                throw new LayoutOverflowError(
                    "Section padding consumes the available width",
                );
            let emitted = 0;
            const wrap = (runs: readonly PreviewRun[]) => {
                const remaining = (policy?.maximumLines ?? 16) - emitted;
                if (remaining < 1)
                    throw new LayoutOverflowError(
                        "Block exceeds its line budget",
                    );
                return wrapRuns(runs, this.fonts, {
                    widthPixels: available,
                    maximumLines: remaining,
                    overflow: policy?.overflow ?? "ELLIPSIS",
                    preserveExplicitLines: false,
                    continuationIndentPixels: indent,
                });
            };
            const emit = (
                wrapped: ReadonlyArray<{ runs: readonly PreviewRun[] }>,
                continuationIndent: number,
            ) => {
                wrapped.forEach((line, i) => {
                    const style =
                        line.runs[0]?.style ?? themeStyle(this.theme, "value");
                    const prefix =
                        emitted === 0 && i === 0
                            ? block.firstPrefix
                            : block.continuationPrefix;
                    const continuation = i ? continuationIndent : 0;
                    if (prefix?.length) {
                        const decorated = [
                            ...this.padding(themeLeft, style),
                            ...this.prefixRuns(prefix),
                            ...this.padding(sectionLeft + continuation, style),
                            ...line.runs,
                        ];
                        lines.push({
                            line: this.line([
                                ...decorated,
                                ...this.padding(
                                    pads.right,
                                    decorated.at(-1)?.style ?? style,
                                ),
                            ]),
                            origin: block.origin,
                        });
                        return;
                    }
                    lines.push({
                        line: this.line([
                            ...this.padding(pads.left + continuation, style),
                            ...line.runs,
                            ...this.padding(
                                pads.right,
                                line.runs.at(-1)?.style ?? style,
                            ),
                        ]),
                        origin: block.origin,
                    });
                });
                emitted += wrapped.length;
            };
            const join = (explicit: PreviewRun[][]) =>
                explicit.flatMap((line, i) =>
                    i
                        ? [
                              this.run(
                                  " ",
                                  line[0]?.style ??
                                      themeStyle(this.theme, "value"),
                                  "TEXT",
                                  false,
                              ),
                              ...line,
                          ]
                        : line,
                );
            if (block.kind === "rule") {
                emit([{ runs: this.renderRule(block, available) }], 0);
            } else if (block.kind === "row") {
                this.renderRow(
                    block,
                    available,
                    policy?.preserveExplicitLines !== false,
                    indent,
                    iconGap,
                    join,
                    wrap,
                    emit,
                );
            } else {
                const value =
                    block.fieldValueIndex === null
                        ? undefined
                        : block.runs[block.fieldValueIndex];
                const explicit = this.explicit(block.runs);
                const paragraphs =
                    policy?.preserveExplicitLines === false
                        ? [join(explicit)]
                        : explicit;
                for (const paragraph of paragraphs) {
                    let runs = iconGap(paragraph);
                    const valueIndex = value
                        ? runs.findIndex((run) => run.style === value.style)
                        : -1;
                    if (
                        layout?.fieldValueAlignment === "RIGHT" &&
                        block.kind === "field" &&
                        valueIndex > 0
                    ) {
                        runs = [
                            ...runs.slice(0, valueIndex),
                            ...this.padding(
                                available - this.width(runs),
                                this.plainStyle(value!.style),
                                true,
                            ),
                            ...runs.slice(valueIndex),
                        ];
                    }
                    emit(wrap(runs), indent);
                }
            }
            if (blockIndex < blocks.length - 1)
                gap(
                    layout?.blockGapAfterPixels ?? 0,
                    blocks[blockIndex + 1]!.gapPrefix,
                );
        });
        if (lines.length > this.document.budgets.maximumLines)
            throw new LayoutOverflowError("Lore exceeds its line budget", {
                capacity: true,
            });
        return {
            lines,
            boundaries,
            targetWidth: Math.min(
                maximum,
                Math.max(
                    target,
                    ...lines.map(({ line }) => line.logicalWidthPixels),
                ),
            ),
        };
    }
    /**
     * A row's right region ends exactly at the content edge. When both regions cannot share one
     * line, the left region wraps and the right region takes its own line, still right-aligned.
     */
    private renderRow(
        block: FlowBlock,
        available: number,
        preserveExplicitLines: boolean,
        indent: number,
        iconGap: (runs: readonly PreviewRun[]) => PreviewRun[],
        join: (lines: PreviewRun[][]) => PreviewRun[],
        wrap: (runs: readonly PreviewRun[]) => ReadonlyArray<{
            runs: readonly PreviewRun[];
        }>,
        emit: (
            lines: ReadonlyArray<{ runs: readonly PreviewRun[] }>,
            continuationIndent: number,
        ) => void,
    ): void {
        const { left, right } = this.rowRegions(block);
        const logical = preserveExplicitLines
            ? left
            : left.length
              ? [join(left)]
              : [];
        const leftRuns = logical.map(iconGap);
        const rightWidth = this.width(right);
        if (logical.length <= 1) {
            const single = leftRuns[0];
            const leftWidth = single ? this.width(single) : 0;
            const gap = single && right.length ? this.rowGap(right) : 0;
            if (leftWidth + gap + rightWidth <= available) {
                const runs = [
                    ...(single ?? []),
                    ...(right.length
                        ? [
                              ...this.exactPadding(
                                  available - leftWidth - rightWidth,
                                  right[0]!.style,
                              ),
                              ...right,
                          ]
                        : []),
                ];
                emit(wrap(runs), 0);
                return;
            }
        }
        leftRuns.forEach((runs) => emit(wrap(runs), indent));
        if (!right.length) return;
        const aligned =
            rightWidth <= available
                ? [
                      ...this.exactPadding(
                          available - rightWidth,
                          right[0]!.style,
                      ),
                      ...right,
                  ]
                : right;
        emit(wrap(aligned), indent);
    }
    anchorFlow(
        name: PreviewLine,
        flow: FlowResult,
    ): { name: PreviewLine; lines: ComposedLine[] } {
        const widest = flow.lines.reduce(
            (best, entry, i) =>
                best < 0 ||
                entry.line.logicalWidthPixels >
                    flow.lines[best]!.line.logicalWidthPixels
                    ? i
                    : best,
            -1,
        );
        const useName =
            widest < 0 ||
            name.logicalWidthPixels >=
                flow.lines[widest]!.line.logicalWidthPixels;
        const line = useName ? name : flow.lines[widest]!.line;
        const anchored = this.line([
            ...line.runs,
            ...this.anchor(
                flow.targetWidth - line.logicalWidthPixels,
                line.runs.at(-1)?.style ?? themeStyle(this.theme, "value"),
            ),
        ]);
        return {
            name: useName ? anchored : name,
            lines: useName
                ? flow.lines
                : flow.lines.map((entry, i) =>
                      i === widest ? { ...entry, line: anchored } : entry,
                  ),
        };
    }
    characterFrame(flow: FlowResult): ComposedLine[] {
        const frame = this.theme.characterFrame;
        if (!frame)
            throw new LayoutOverflowError(
                "Character frame configuration is missing",
            );
        if (flow.lines.length > frame.maximumLines)
            throw new LayoutOverflowError(
                "Character frame line count exceeded",
                { capacity: true },
            );
        const chars = {
            UNICODE_SINGLE: [
                "\u250c",
                "\u2500",
                "\u2510",
                "\u2502",
                "\u2514",
                "\u2518",
                "\u251c",
                "\u2524",
            ],
            UNICODE_DOUBLE: [
                "\u2554",
                "\u2550",
                "\u2557",
                "\u2551",
                "\u255a",
                "\u255d",
                "\u2560",
                "\u2563",
            ],
            ASCII_SAFE: ["+", "-", "+", "|", "+", "+", "+", "+"],
            BRACKETED_SECTION: ["[", "-", "]", "[", "[", "]", "[", "]"],
            SEPARATOR_ONLY: ["", "\u2500", "", "", "", "", "", ""],
        }[frame.preset]!;
        const style = this.plainStyle(themeStyle(this.theme, "frame", "frame"));
        const border = (
            left: string,
            right: string,
            target: number,
        ): ComposedLine => {
            const l = this.run(left, style, "FRAME"),
                r = this.run(right, style, "FRAME"),
                fill = this.run(chars[1]!, style, "FRAME");
            const count = Math.max(
                1,
                Math.ceil(
                    Math.max(0, target - this.width([l, r])) /
                        Math.max(1, this.width([fill])),
                ),
            );
            return {
                line: this.line([
                    l,
                    { ...fill, text: fill.text.repeat(count) },
                    r,
                ]),
                origin: null,
            };
        };
        if (frame.preset === "SEPARATOR_ONLY") {
            const separator = border("", "", flow.targetWidth);
            return [separator, ...flow.lines, separator];
        }
        const top = border(
            chars[0]!,
            chars[2]!,
            Math.max(
                frame.minimumWidthPixels,
                flow.targetWidth +
                    frame.leftPaddingPixels +
                    frame.rightPaddingPixels +
                    4,
            ),
        );
        const target = top.line.logicalWidthPixels;
        const edge = this.run(chars[3]!, style, "FRAME");
        const result: ComposedLine[] = [top];
        flow.lines.forEach(({ line, origin }, i) => {
            if (flow.boundaries.has(i))
                result.push(border(chars[6]!, chars[7]!, target));
            const padStyle = this.plainStyle({
                ...themeStyle(this.theme, "value"),
                font:
                    line.runs[0]?.style.font ??
                    this.theme.fonts.text ??
                    "minecraft:default",
            });
            const space = this.run(" ", padStyle);
            const unit = Math.max(1, this.width([space]));
            const base = [
                edge,
                {
                    ...space,
                    text: " ".repeat(Math.ceil(frame.leftPaddingPixels / unit)),
                },
                ...line.runs,
            ];
            const right = Math.ceil(
                Math.max(
                    frame.rightPaddingPixels,
                    target - this.width([...base, edge]),
                ) / unit,
            );
            const framed = this.line([
                ...base,
                { ...space, text: " ".repeat(right) },
                edge,
            ]);
            if (
                Math.abs(framed.logicalWidthPixels - target) >
                frame.alignmentTolerancePixels
            )
                throw new LayoutOverflowError(
                    "Character frame cannot meet its alignment tolerance",
                );
            result.push({ line: framed, origin });
        });
        result.push(border(chars[4]!, chars[5]!, target));
        return result;
    }
    segmentedFrame(flow: FlowResult): ComposedLine[] {
        const frame = this.theme.segmentedFrame;
        if (!frame)
            throw new LayoutOverflowError(
                "Segmented frame configuration is missing",
            );
        const target = Math.max(
            frame.minimumWidthPixels,
            flow.targetWidth +
                frame.leftPaddingPixels +
                frame.rightPaddingPixels +
                8,
        );
        if (target > frame.maximumWidthPixels)
            throw new LayoutOverflowError("Segmented frame width exceeded");
        const asset = (id: string): PreviewRun => {
            const glyph = this.document.glyphs.find((entry) => entry.id === id);
            if (!glyph)
                throw new LayoutOverflowError("Frame glyph is not declared");
            return this.run(
                String.fromCodePoint(glyph.codePoint),
                this.plainStyle({
                    ...themeStyle(this.theme, "frame"),
                    font: glyph.font,
                }),
                "FRAME",
            );
        };
        const row = (source: typeof frame.top) => [
            asset(source.left),
            asset(source.fill),
            asset(source.right),
        ];
        const border = (source: typeof frame.top): ComposedLine => {
            const [l, fill, r] = row(source) as [
                PreviewRun,
                PreviewRun,
                PreviewRun,
            ];
            const line = this.line([
                l,
                {
                    ...fill,
                    text: fill.text.repeat(
                        Math.max(
                            0,
                            Math.ceil(
                                (target - this.width([l, r])) /
                                    Math.max(1, this.width([fill])),
                            ),
                        ),
                    ),
                },
                r,
            ]);
            if (line.logicalWidthPixels > frame.maximumWidthPixels)
                throw new LayoutOverflowError(
                    "Segmented border width exceeded",
                );
            return { line, origin: null };
        };
        const output: ComposedLine[] = [border(frame.top)];
        flow.lines.forEach(({ line, origin }, i) => {
            if (flow.boundaries.has(i) && frame.connector)
                output.push(border(frame.connector));
            const [l, fill, r] = row(frame.body) as [
                PreviewRun,
                PreviewRun,
                PreviewRun,
            ];
            const interior = target - this.width([l]) - this.width([r]);
            const fillWidth = Math.max(1, this.width([fill]));
            const remaining =
                interior - frame.leftPaddingPixels - line.logicalWidthPixels;
            if (
                interior < 0 ||
                interior % fillWidth !== 0 ||
                remaining < frame.rightPaddingPixels
            )
                throw new LayoutOverflowError(
                    "Segmented body cannot contain its content",
                );
            const framed = this.line([
                l,
                { ...fill, text: fill.text.repeat(interior / fillWidth) },
                ...this.spacing(-interior),
                ...this.spacing(frame.leftPaddingPixels),
                ...line.runs,
                ...this.spacing(remaining, "WIDTH_ANCHOR"),
                r,
            ]);
            if (framed.logicalWidthPixels !== target)
                throw new LayoutOverflowError(
                    "Segmented body width did not match",
                );
            output.push({ line: framed, origin });
        });
        output.push(border(frame.bottom));
        return output;
    }
}

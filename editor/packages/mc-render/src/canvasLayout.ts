import type {
    LayoutNode,
    PreviewLine,
    PreviewRun,
    ProjectDocument,
    ThemeNode,
    VisualBounds,
    Wrapping,
} from "@itemerness/protocol";
import type { PresentationFonts } from "./fonts.js";
import { themeStyle, type ComposedLine, type FlowBlock } from "./flow.js";
import { measureLine, MissingGlyphError } from "./measure.js";
import { LayoutOverflowError, wrapRuns } from "./wrap.js";

export interface CanvasBlock extends FlowBlock {
    anchor: string | null;
}

export interface CanvasElementOrigin {
    readonly origin: string;
    readonly anchor: string;
    readonly baselineLine: number;
    readonly x: number;
    readonly visualBounds: VisualBounds;
}

interface CanvasElement {
    x: number;
    drawOrder: number;
    runs: readonly PreviewRun[];
    origin: string | null;
}

const DEFAULT_WRAPPING: Wrapping = {
    widthPixels: null,
    maximumLines: 16,
    overflow: "ELLIPSIS",
    preserveExplicitLines: true,
    continuationIndentPixels: 0,
    lineHeightPixels: 10,
};

function explicitLines(runs: readonly PreviewRun[]): PreviewRun[][] {
    const lines: PreviewRun[][] = [[]];
    for (const run of runs) {
        run.text.split("\n").forEach((text, index) => {
            if (index > 0) lines.push([]);
            if (text.length > 0) lines.at(-1)!.push({ ...run, text });
        });
    }
    return lines;
}

function joinLines(lines: readonly PreviewRun[][]): PreviewRun[] {
    const result: PreviewRun[] = [];
    lines.forEach((line, index) => {
        if (index > 0) {
            const style = result.at(-1)?.style ??
                line[0]?.style ?? {
                    color: null,
                    font: null,
                    bold: false,
                    italic: false,
                    underlined: false,
                    strikethrough: false,
                };
            result.push({ text: " ", kind: "TEXT", unbreakable: false, style });
        }
        result.push(...line);
    });
    return result;
}

/** The fixed-baseline canvas algorithm in PresentationEngine.renderCanvas. */
export class CanvasComposer {
    constructor(
        private readonly document: ProjectDocument,
        private readonly theme: ThemeNode,
        private readonly layout: LayoutNode,
        private readonly fonts: PresentationFonts,
    ) {}

    private line(runs: readonly PreviewRun[]): PreviewLine {
        try {
            const measured = measureLine(runs, this.fonts);
            if (measured.advanceSum < 0)
                throw new LayoutOverflowError("Negative line advance");
            return {
                runs: [...runs],
                logicalWidthPixels: measured.logicalWidthPixels,
                visualBounds: measured.visualBounds,
            };
        } catch (error) {
            if (error instanceof MissingGlyphError)
                throw new LayoutOverflowError(error.message);
            throw error;
        }
    }

    private spacing(pixels: number, kind: PreviewRun["kind"]): PreviewRun[] {
        const output: PreviewRun[] = [];
        const provider = this.document.spacing;
        let remaining = pixels;
        while (remaining !== 0) {
            if (!provider)
                throw new LayoutOverflowError("Signed spacing is unavailable");
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
            if (part === 0 || cp === null || output.length >= 4096)
                throw new LayoutOverflowError(
                    "Spacing is not representable within the output budget",
                );
            output.push({
                text: String.fromCodePoint(cp),
                kind,
                unbreakable: true,
                style: {
                    color: null,
                    font: provider.font,
                    bold: false,
                    italic: false,
                    underlined: false,
                    strikethrough: false,
                },
            });
            remaining -= part;
        }
        return output;
    }

    private indent(line: PreviewLine, pixels: number): PreviewLine {
        if (pixels <= 0) return line;
        if (this.theme.requiresResourcePack && this.document.spacing)
            return this.line([
                ...this.spacing(pixels, "SPACING"),
                ...line.runs,
            ]);
        const style = line.runs[0]?.style ?? themeStyle(this.theme, "value");
        const space: PreviewRun = {
            text: " ",
            kind: "TEXT",
            unbreakable: true,
            style: { ...style, bold: false, italic: false },
        };
        const count = Math.ceil(
            pixels / Math.max(1, this.line([space]).logicalWidthPixels),
        );
        return this.line([{ ...space, text: " ".repeat(count) }, ...line.runs]);
    }

    compose(
        blocks: readonly CanvasBlock[],
        name?: PreviewLine,
    ): { lines: ComposedLine[]; elements: CanvasElementOrigin[] } {
        const canvas = this.theme.canvas;
        const layout = this.layout;
        if (
            !canvas ||
            layout.kind !== "canvas" ||
            layout.widthPixels !== canvas.widthPixels ||
            layout.heightPixels !== canvas.heightPixels ||
            layout.reserveTooltipLines !== canvas.reserveTooltipLines
        )
            throw new LayoutOverflowError(
                "Canvas layout and theme dimensions differ",
            );
        const elements: CanvasElement[][] = Array.from(
            { length: canvas.reserveTooltipLines },
            () => [],
        );
        const origins: CanvasElementOrigin[] = [];
        const layerBounds = canvas.layers.map((layer) => {
            if (!elements[layer.baselineLine])
                throw new LayoutOverflowError(
                    "Canvas layer baseline is outside its reserved lines",
                );
            const glyph = this.document.glyphs.find(
                (entry) => entry.id === layer.asset,
            );
            const bitmap = this.document.bitmaps.find(
                (entry) => entry.id === glyph?.bitmap,
            );
            if (!glyph || !bitmap)
                throw new LayoutOverflowError(
                    "Canvas layer has no declared bitmap",
                );
            const x =
                layer.anchor === "TOP_RIGHT"
                    ? canvas.widthPixels +
                      layer.xPixels -
                      bitmap.renderWidthPixels
                    : layer.xPixels;
            const runs: PreviewRun[] = [
                {
                    text: String.fromCodePoint(glyph.codePoint),
                    kind: "BITMAP",
                    unbreakable: true,
                    style: {
                        ...themeStyle(this.theme, "frame"),
                        font: glyph.font,
                        bold: false,
                        italic: false,
                    },
                },
            ];
            const measured = this.line(runs);
            elements[layer.baselineLine]!.push({
                x,
                drawOrder: layer.drawOrder,
                runs,
                origin: null,
            });
            return {
                left: x + measured.visualBounds.left,
                right: x + measured.visualBounds.right,
                top: layer.baselineLine * 10 + measured.visualBounds.top,
                bottom: layer.baselineLine * 10 + measured.visualBounds.bottom,
            };
        });
        const visualOriginY =
            canvas.normalizeVisualOrigin && layerBounds.length > 0
                ? Math.min(...layerBounds.map((entry) => entry.top))
                : 0;
        if (
            canvas.rejectOutOfBoundsLayer &&
            layerBounds.some(
                (bounds) =>
                    bounds.left < 0 ||
                    bounds.right > canvas.widthPixels ||
                    bounds.top - visualOriginY < 0 ||
                    bounds.bottom - visualOriginY > canvas.heightPixels,
            )
        )
            throw new LayoutOverflowError(
                "Canvas layer exceeds its absolute bounds",
            );

        const usedAnchorLines = new Map<string, number>();
        let drawOrder = 10_000;
        for (const block of blocks) {
            const anchorName = block.anchor;
            const anchor =
                anchorName === null ? undefined : layout.anchors[anchorName];
            if (!anchor || anchorName === null)
                throw new LayoutOverflowError(
                    "Every canvas block must name an existing anchor",
                );
            const policy =
                (block.wrapping === null
                    ? undefined
                    : layout.wrapping[block.wrapping]) ??
                layout.wrapping.body ??
                Object.values(layout.wrapping)[0] ??
                DEFAULT_WRAPPING;
            const consumed = usedAnchorLines.get(anchorName) ?? 0;
            const remaining =
                Math.min(
                    Math.ceil(anchor.height / policy.lineHeightPixels),
                    policy.maximumLines,
                ) - consumed;
            if (remaining <= 0)
                throw new LayoutOverflowError(
                    `Canvas anchor ${anchorName} has no remaining line capacity`,
                );
            const paragraphs = explicitLines(block.runs);
            const logicalLines = policy.preserveExplicitLines
                ? paragraphs
                : [joinLines(paragraphs)];
            const lines: PreviewLine[] = [];
            for (const runs of logicalLines) {
                const available = remaining - lines.length;
                if (available <= 0)
                    throw new LayoutOverflowError(
                        `Canvas anchor ${anchorName} exceeded its line capacity`,
                    );
                this.line(runs);
                const width = Math.min(
                    anchor.width,
                    policy.widthPixels ?? anchor.width,
                );
                if (policy.continuationIndentPixels >= width)
                    throw new LayoutOverflowError(
                        "Continuation indent consumes its wrapping width",
                    );
                const wrapped = wrapRuns(runs, this.fonts, {
                    widthPixels: width,
                    maximumLines: available,
                    overflow: anchor.overflow,
                    preserveExplicitLines: false,
                    continuationIndentPixels: policy.continuationIndentPixels,
                });
                lines.push(...wrapped.map((line) => this.line(line.runs)));
            }
            lines.forEach((line, index) => {
                const positioned = this.indent(
                    line,
                    index > 0 ? policy.continuationIndentPixels : 0,
                );
                const desiredTop =
                    anchor.y + (consumed + index) * policy.lineHeightPixels;
                const baseline = Math.ceil(
                    (visualOriginY + desiredTop - positioned.visualBounds.top) /
                        10,
                );
                if (!elements[baseline])
                    throw new LayoutOverflowError(
                        "Canvas content exceeds reserved tooltip lines",
                    );
                const x =
                    anchor.x +
                    Math.max(0, Math.ceil(-positioned.visualBounds.left));
                const bounds = {
                    left: x + positioned.visualBounds.left,
                    right: x + positioned.visualBounds.right,
                    top: baseline * 10 + positioned.visualBounds.top,
                    bottom: baseline * 10 + positioned.visualBounds.bottom,
                };
                if (
                    bounds.left < anchor.x ||
                    bounds.right > anchor.x + anchor.width ||
                    bounds.top - visualOriginY < anchor.y ||
                    bounds.bottom - visualOriginY > anchor.y + anchor.height
                )
                    throw new LayoutOverflowError(
                        `Canvas content exceeds anchor ${anchorName}`,
                    );
                elements[baseline]!.push({
                    x,
                    drawOrder: drawOrder++,
                    runs: positioned.runs,
                    origin: block.origin,
                });
                origins.push({
                    origin: block.origin,
                    anchor: anchorName,
                    baselineLine: baseline,
                    x,
                    visualBounds: bounds,
                });
            });
            usedAnchorLines.set(anchorName, consumed + lines.length);
        }

        let glyphCount = 0;
        let componentCount = 0;
        let minimumVisualY = Infinity;
        let maximumVisualY = -Infinity;
        const output = elements.map((entries, index): ComposedLine => {
            const runs: PreviewRun[] = [];
            let cursor = 0;
            for (const entry of entries.sort(
                (a, b) => a.drawOrder - b.drawOrder || a.x - b.x,
            )) {
                runs.push(
                    ...this.spacing(entry.x - cursor, "SPACING"),
                    ...entry.runs,
                );
                cursor = entry.x + this.line(entry.runs).logicalWidthPixels;
            }
            const finalAdvance = canvas.finalTooltipWidthPixels - cursor;
            if (canvas.rejectNegativeFinalAdvance && finalAdvance < 0)
                throw new LayoutOverflowError(
                    "Canvas has negative final advance",
                );
            runs.push(...this.spacing(finalAdvance, "WIDTH_ANCHOR"));
            glyphCount += runs.reduce(
                (sum, run) => sum + [...run.text].length,
                0,
            );
            componentCount += runs.length;
            if (
                glyphCount > this.document.budgets.maximumEmittedGlyphs ||
                componentCount > canvas.maximumEmittedComponents
            )
                throw new LayoutOverflowError(
                    "Canvas emitted more than its output budget",
                );
            const line = this.line(runs);
            if (
                line.logicalWidthPixels !== canvas.finalTooltipWidthPixels ||
                line.logicalWidthPixels !== canvas.measuredAdvancePixels
            )
                throw new LayoutOverflowError(
                    "Canvas width anchor did not produce the declared width",
                );
            if (
                canvas.rejectOutOfBoundsLayer &&
                (line.visualBounds.left < 0 ||
                    line.visualBounds.right > canvas.widthPixels)
            )
                throw new LayoutOverflowError(
                    "Canvas ink exceeds its horizontal bounds",
                );
            if (line.visualBounds.bottom > line.visualBounds.top) {
                minimumVisualY = Math.min(
                    minimumVisualY,
                    index * 10 + line.visualBounds.top - visualOriginY,
                );
                maximumVisualY = Math.max(
                    maximumVisualY,
                    index * 10 + line.visualBounds.bottom - visualOriginY,
                );
            }
            const owners = new Set(
                entries.flatMap((entry) =>
                    entry.origin === null ? [] : [entry.origin],
                ),
            );
            return { line, origin: owners.size === 1 ? [...owners][0]! : null };
        });
        if (
            Number.isFinite(minimumVisualY) &&
            (minimumVisualY < 0 ||
                maximumVisualY > canvas.heightPixels ||
                maximumVisualY - minimumVisualY > canvas.maximumHeightPixels)
        )
            throw new LayoutOverflowError(
                "Canvas ink exceeds its vertical bounds",
            );
        this.validateOutput(
            name,
            output.map((entry) => entry.line),
        );
        return { lines: output, elements: origins };
    }

    private validateOutput(
        name: PreviewLine | undefined,
        lore: readonly PreviewLine[],
    ) {
        const all = name ? [this.line(name.runs), ...lore] : lore;
        const budgets = this.document.budgets;
        const runs = all.flatMap((line) => line.runs);
        if (
            lore.length > budgets.maximumLines ||
            all.some(
                (line) =>
                    line.logicalWidthPixels > budgets.maximumWidthPixels ||
                    line.visualBounds.right - line.visualBounds.left >
                        budgets.maximumWidthPixels ||
                    line.runs.length > 256 ||
                    line.runs.reduce((sum, run) => sum + run.text.length, 0) >
                        8192,
            ) ||
            runs.length > Math.min(budgets.maximumRuns, 4096) ||
            runs.reduce((sum, run) => sum + [...run.text].length, 0) >
                budgets.maximumTextCodePoints ||
            runs.reduce((sum, run) => sum + run.text.length, 0) > 131072
        )
            throw new LayoutOverflowError(
                "Canvas display exceeds the serialized output budget",
            );
        let top = Infinity;
        let bottom = -Infinity;
        all.forEach((line, index) => {
            if (line.visualBounds.bottom <= line.visualBounds.top) return;
            const baseline = index * 10 + (index === 0 ? 0 : 2);
            top = Math.min(top, baseline + line.visualBounds.top);
            bottom = Math.max(bottom, baseline + line.visualBounds.bottom);
        });
        const structural = all.length === 1 ? 8 : all.length * 10;
        if (
            Math.max(
                structural,
                Number.isFinite(top) ? Math.ceil(bottom - top) : 0,
            ) > budgets.maximumHeightPixels
        )
            throw new LayoutOverflowError(
                "Canvas display exceeds its height budget",
            );
    }
}

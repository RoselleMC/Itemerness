import type {
    PreviewLine,
    PreviewRun,
    ProjectDocument,
    ThemeNode,
} from "@itemerness/protocol";
import type { PresentationFonts } from "./fonts.js";
import { measureLine } from "./measure.js";
import { themeStyle, type FlowResult, type ComposedLine } from "./flow.js";
import { ellipsizeLine, LayoutOverflowError } from "./wrap.js";
import { componentTop, contentHeight } from "./tooltip.js";

type Frame = NonNullable<ThemeNode["segmentedFrame"]>;
interface Strip {
    left: PreviewRun;
    fill: PreviewRun;
    right: PreviewRun;
    center: PreviewRun | null;
    leftWidth: number;
    rightWidth: number;
    centerWidth: number;
    fillWidth: number;
    fixed: number;
}

export function usesDecoratedFrame(frame: Frame): boolean {
    return (
        !!frame.includeName ||
        [frame.top, frame.body, frame.connector, frame.bottom].some(
            (row) => row?.center != null || row?.kern != null,
        )
    );
}

function sameStyle(
    left: PreviewRun["style"],
    right: PreviewRun["style"],
): boolean {
    return (
        left.font === right.font &&
        left.color === right.color &&
        left.bold === right.bold &&
        left.italic === right.italic &&
        left.underlined === right.underlined &&
        left.strikethrough === right.strikethrough
    );
}

/** Optional exact-width frame composition; legacy three-piece themes keep their original path. */
export class SegmentedFrameComposer {
    constructor(
        private readonly document: ProjectDocument,
        private readonly theme: ThemeNode,
        private readonly fonts: PresentationFonts,
    ) {}

    private line(runs: readonly PreviewRun[]): PreviewLine {
        const measured = measureLine(runs, this.fonts, { lenient: true });
        if (measured.missingMetrics)
            throw new LayoutOverflowError("Frame metrics are unavailable");
        return {
            runs: [...runs],
            logicalWidthPixels: measured.logicalWidthPixels,
            visualBounds: measured.visualBounds,
        };
    }

    private asset(id: string): PreviewRun {
        const glyph = this.document.glyphs.find((entry) => entry.id === id);
        if (!glyph) throw new LayoutOverflowError(`Unknown frame glyph ${id}`);
        return {
            text: String.fromCodePoint(glyph.codePoint),
            kind: "FRAME",
            unbreakable: true,
            style: {
                ...themeStyle(this.theme, "frame"),
                font: glyph.font,
                bold: false,
                italic: false,
            },
        };
    }

    private strip(row: Frame["top"]): Strip {
        const kern = row.kern ? this.asset(row.kern) : null;
        if (kern) {
            const glyph = this.document.glyphs.find(
                (entry) => entry.id === row.kern,
            )!;
            if (
                glyph.advancePixels >= 0 ||
                glyph.visualBounds.right > glyph.visualBounds.left ||
                glyph.visualBounds.bottom > glyph.visualBounds.top
            )
                throw new LayoutOverflowError(
                    "A frame kern must have negative advance and no visual ink",
                );
        }
        const piece = (id: string) => {
            const run = this.asset(id);
            if (!kern) return run;
            if (!sameStyle(run.style, kern.style))
                throw new LayoutOverflowError(
                    "Frame pieces and kern must share a font and style",
                );
            return { ...run, text: run.text + kern.text };
        };
        const left = piece(row.left),
            fill = piece(row.fill),
            right = piece(row.right),
            center = row.center ? piece(row.center) : null;
        const width = (run: PreviewRun) => {
            const measured = this.line([run]).logicalWidthPixels;
            if (measured <= 0)
                throw new LayoutOverflowError(
                    "Frame pieces must have positive net advance",
                );
            return measured;
        };
        const leftWidth = width(left),
            rightWidth = width(right),
            centerWidth = center ? width(center) : 0,
            fillWidth = width(fill);
        return {
            left,
            fill,
            right,
            center,
            leftWidth,
            rightWidth,
            centerWidth,
            fillWidth,
            fixed: leftWidth + rightWidth + centerWidth,
        };
    }

    private fits(strip: Strip, width: number): boolean {
        return (
            width >= strip.fixed &&
            (width - strip.fixed) % strip.fillWidth === 0
        );
    }

    private stripRuns(strip: Strip, target: number): PreviewRun[] {
        if (!this.fits(strip, target))
            throw new LayoutOverflowError(
                "Frame pieces cannot exactly cover the target width",
            );
        const count = (target - strip.fixed) / strip.fillWidth;
        if (
            count * [...strip.fill.text].length >
                this.document.budgets.maximumTextCodePoints ||
            count * strip.fill.text.length > 8192
        )
            throw new LayoutOverflowError("Frame fill exceeds the text budget");
        const leading = !strip.center
            ? count
            : Math.max(
                  0,
                  Math.min(
                      count,
                      Math.round(
                          ((target - strip.centerWidth) / 2 - strip.leftWidth) /
                              strip.fillWidth,
                      ),
                  ),
              );
        return [
            strip.left,
            ...(leading
                ? [{ ...strip.fill, text: strip.fill.text.repeat(leading) }]
                : []),
            ...(strip.center ? [strip.center] : []),
            ...(count > leading
                ? [
                      {
                          ...strip.fill,
                          text: strip.fill.text.repeat(count - leading),
                      },
                  ]
                : []),
            strip.right,
        ];
    }

    private spacing(
        pixels: number,
        kind: PreviewRun["kind"] = "SPACING",
    ): PreviewRun[] {
        const provider = this.document.spacing;
        if (!provider)
            throw new LayoutOverflowError("Signed spacing is unavailable");
        const runs: PreviewRun[] = [];
        while (pixels !== 0) {
            const part =
                pixels > 0
                    ? Math.min(pixels, provider.positive.maximumAdvancePixels)
                    : Math.max(pixels, provider.negative.minimumAdvancePixels);
            const codePoint = this.fonts.spacingCodePoint(part);
            if (!part || codePoint === null || runs.length >= 128)
                throw new LayoutOverflowError("Spacing is not representable");
            runs.push({
                text: String.fromCodePoint(codePoint),
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
            pixels -= part;
        }
        return runs;
    }

    private row(
        strip: Strip,
        target: number,
        content: PreviewLine | null,
        frame: Frame,
        contentStrip = strip,
    ): PreviewLine {
        const background = this.stripRuns(strip, target);
        let runs = background;
        if (content) {
            const interior =
                target - contentStrip.leftWidth - contentStrip.rightWidth;
            const remaining =
                interior - frame.leftPaddingPixels - content.logicalWidthPixels;
            if (remaining < frame.rightPaddingPixels)
                throw new LayoutOverflowError(
                    "Segmented content exceeds its frame",
                );
            runs = [
                ...background,
                ...this.spacing(
                    contentStrip.leftWidth + frame.leftPaddingPixels - target,
                ),
                ...content.runs,
                ...this.spacing(
                    remaining + contentStrip.rightWidth,
                    "WIDTH_ANCHOR",
                ),
            ];
        }
        const line = this.line(runs);
        if (line.logicalWidthPixels !== target)
            throw new LayoutOverflowError(
                "Frame did not preserve its exact target width",
            );
        return line;
    }

    compose(
        flowFor: (maximum: number) => FlowResult,
        name: PreviewLine,
    ): { name: PreviewLine; lines: ComposedLine[] } {
        const frame = this.theme.segmentedFrame;
        if (!frame)
            throw new LayoutOverflowError(
                "Segmented frame configuration is missing",
            );
        const top = this.strip(frame.top),
            body = this.strip(frame.body),
            bottom = this.strip(frame.bottom),
            connector = frame.connector ? this.strip(frame.connector) : null;
        const strips = [top, body, bottom, ...(connector ? [connector] : [])];
        let maximumTarget = Math.min(
            frame.maximumWidthPixels,
            this.document.budgets.maximumWidthPixels,
        );
        while (
            maximumTarget >= frame.minimumWidthPixels &&
            !strips.every((strip) => this.fits(strip, maximumTarget))
        )
            maximumTarget--;
        if (maximumTarget < frame.minimumWidthPixels)
            throw new LayoutOverflowError(
                "Frame rows have no common exact width within their bounds",
            );
        const padding = frame.leftPaddingPixels + frame.rightPaddingPixels;
        const available = (strip: Strip) => {
            const result =
                maximumTarget - strip.leftWidth - strip.rightWidth - padding;
            if (result < 1)
                throw new LayoutOverflowError("Frame has no space for text");
            return result;
        };
        const flow = flowFor(available(body));
        const fittedName = frame.includeName
            ? this.line(
                  ellipsizeLine(name.runs, this.fonts, available(body)).runs,
              )
            : name;
        let target = Math.max(
            frame.minimumWidthPixels,
            flow.targetWidth + body.leftWidth + body.rightWidth + padding,
            frame.includeName
                ? fittedName.logicalWidthPixels +
                      body.leftWidth +
                      body.rightWidth +
                      padding
                : 0,
        );
        while (
            target <= maximumTarget &&
            !strips.every((strip) => this.fits(strip, target))
        )
            target++;
        if (target > maximumTarget)
            throw new LayoutOverflowError(
                "Frame rows have no common exact width for their content",
            );
        const framedName = frame.includeName
            ? this.row(top, target, fittedName, frame, body)
            : name;
        const lines: ComposedLine[] = frame.includeName
            ? []
            : [{ line: this.row(top, target, null, frame), origin: null }];
        flow.lines.forEach(({ line, origin }, index) => {
            if (connector && flow.boundaries.has(index))
                lines.push({
                    line: this.row(connector, target, null, frame),
                    origin: null,
                });
            lines.push({ line: this.row(body, target, line, frame), origin });
        });
        lines.push({
            line: this.row(bottom, target, null, frame),
            origin: null,
        });
        this.validate(framedName, lines);
        return { name: framedName, lines };
    }

    private validate(name: PreviewLine, lines: ComposedLine[]) {
        const all = [name, ...lines.map((entry) => entry.line)],
            budgets = this.document.budgets;
        const runs = all.flatMap((line) => line.runs),
            ink = all.flatMap((line, index) =>
                line.visualBounds.bottom > line.visualBounds.top
                    ? [
                          {
                              top: componentTop(index) + line.visualBounds.top,
                              bottom:
                                  componentTop(index) +
                                  line.visualBounds.bottom,
                          },
                      ]
                    : [],
            );
        const height = ink.length
            ? Math.ceil(
                  Math.max(...ink.map((entry) => entry.bottom)) -
                      Math.min(...ink.map((entry) => entry.top)),
              )
            : 0;
        if (
            lines.length > budgets.maximumLines ||
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
            runs.reduce((sum, run) => sum + run.text.length, 0) > 131072 ||
            Math.max(height, contentHeight(all.length)) >
                budgets.maximumHeightPixels
        )
            throw new LayoutOverflowError(
                "Segmented frame exceeds the display budget",
            );
    }
}

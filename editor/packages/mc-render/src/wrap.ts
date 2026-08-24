import type { OverflowPolicy, PreviewRun } from "@itemerness/protocol";
import type { PresentationFonts } from "./fonts.js";
import { measureLine, type MeasuredLine } from "./measure.js";

/**
 * Optimistic line breaking for the browser's `local` preview.
 *
 * This mirrors `PixelTextLayouter` in `itemerness-core`: grapheme clusters are the atoms, breaks
 * are legal at whitespace, hyphens, and between CJK ideographs subject to the usual prohibitions
 * on leading closing punctuation, and fitting is greedy on measured pixels.
 *
 * It is deliberately *not* the authority. When an agent artifact arrives the browser rasterizes
 * the server's geometry and never re-wraps, because a second wrapping implementation that agrees
 * ninety-nine percent of the time is a worse tool than one that is honestly labelled. What this
 * gives is sub-100ms feedback while typing, marked `local`.
 */

interface Atom {
    readonly run: PreviewRun;
    readonly whitespace: boolean;
    readonly mandatoryBreak: boolean;
    readonly firstCodePoint: number | null;
    readonly lastCodePoint: number | null;
}

const OPENING_PUNCTUATION = new Set([
    0x28, 0x5b, 0x7b, 0x2018, 0x201c, 0x3008, 0x300a, 0x300c, 0x300e, 0x3010,
]);
const CLOSING_PUNCTUATION = new Set([
    0x29, 0x5d, 0x7d, 0x2c, 0x2e, 0x21, 0x3f, 0x3001, 0x3002, 0xff0c, 0xff01,
    0xff1f, 0x2019, 0x201d, 0x3009, 0x300b, 0x300d, 0x300f, 0x3011,
]);

function isCjk(codePoint: number): boolean {
    return (
        (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0x20000 && codePoint <= 0x323af)
    );
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function mandatoryAtom(style: PreviewRun["style"]): Atom {
    return {
        run: { text: "", kind: "TEXT", unbreakable: false, style },
        whitespace: false,
        mandatoryBreak: true,
        firstCodePoint: null,
        lastCodePoint: null,
    };
}

function atomize(
    runs: readonly PreviewRun[],
    preserveExplicitLines: boolean,
): Atom[] {
    const output: Atom[] = [];
    for (const run of runs) {
        if (run.unbreakable || run.kind !== "TEXT") {
            output.push({
                run,
                whitespace: false,
                mandatoryBreak: false,
                firstCodePoint:
                    run.text.length > 0 ? run.text.codePointAt(0)! : null,
                lastCodePoint:
                    run.text.length > 0
                        ? [...run.text].at(-1)!.codePointAt(0)!
                        : null,
            });
            continue;
        }
        for (const [index, segment] of run.text.split("\n").entries()) {
            if (index > 0 && preserveExplicitLines)
                output.push(mandatoryAtom(run.style));
            for (const cluster of segmenter.segment(segment)) {
                const text = cluster.segment;
                output.push({
                    run: { ...run, text },
                    whitespace: [...text].every((character) =>
                        /\s/u.test(character),
                    ),
                    mandatoryBreak: false,
                    firstCodePoint: text.codePointAt(0)!,
                    lastCodePoint: [...text].at(-1)!.codePointAt(0)!,
                });
            }
        }
    }
    return output;
}

function mergeAtoms(atoms: readonly Atom[]): PreviewRun[] {
    const output: PreviewRun[] = [];
    for (const atom of atoms) {
        if (atom.mandatoryBreak) continue;
        const previous = output.at(-1);
        if (
            previous &&
            previous.kind === atom.run.kind &&
            previous.unbreakable === atom.run.unbreakable &&
            sameStyle(previous.style, atom.run.style)
        ) {
            output[output.length - 1] = {
                ...previous,
                text: previous.text + atom.run.text,
            };
        } else {
            output.push({ ...atom.run });
        }
    }
    return output;
}

function sameStyle(
    left: PreviewRun["style"],
    right: PreviewRun["style"],
): boolean {
    return (
        left.color === right.color &&
        left.font === right.font &&
        left.bold === right.bold &&
        left.italic === right.italic &&
        left.underlined === right.underlined &&
        left.strikethrough === right.strikethrough
    );
}

function trimTrailingWhitespace(atoms: readonly Atom[]): Atom[] {
    let end = atoms.length;
    while (end > 0 && atoms[end - 1]!.whitespace) end -= 1;
    return atoms.slice(0, end);
}

function legalBreakAfter(atoms: readonly Atom[], index: number): boolean {
    const current = atoms[index]!;
    if (current.mandatoryBreak || current.whitespace) return true;
    if (current.lastCodePoint === 0x2d || current.lastCodePoint === 0x2010)
        return true;
    const next = atoms[index + 1];
    if (!next) return true;
    const left = current.lastCodePoint;
    const right = next.firstCodePoint;
    if (left === null || right === null) return false;
    return (
        isCjk(left) &&
        isCjk(right) &&
        !OPENING_PUNCTUATION.has(left) &&
        !CLOSING_PUNCTUATION.has(right)
    );
}

export interface WrapOptions {
    readonly widthPixels: number;
    readonly maximumLines: number;
    readonly overflow: OverflowPolicy;
    readonly preserveExplicitLines?: boolean;
    readonly continuationIndentPixels?: number;
}

export class LayoutOverflowError extends Error {}

export function wrapRuns(
    runs: readonly PreviewRun[],
    fonts: PresentationFonts,
    options: WrapOptions,
): MeasuredLine[] {
    const { widthPixels, maximumLines, overflow } = options;
    if (widthPixels <= 0)
        throw new LayoutOverflowError("Wrapping width must be positive");
    const continuationIndent = options.continuationIndentPixels ?? 0;
    const measure = (candidates: readonly PreviewRun[]) =>
        measureLine(candidates, fonts, { lenient: true });

    let remaining = atomize(runs, options.preserveExplicitLines ?? true);
    if (remaining.length === 0) return [];
    const output: MeasuredLine[] = [];

    while (remaining.length > 0) {
        const activeWidth =
            widthPixels - (output.length === 0 ? 0 : continuationIndent);
        if (output.length === maximumLines) {
            if (overflow === "ERROR") {
                throw new LayoutOverflowError(
                    `Text exceeds ${maximumLines} lines`,
                );
            }
            if (overflow === "ELLIPSIS") {
                const last = output.at(-1);
                const style =
                    last?.runs.at(-1)?.style ?? remaining[0]!.run.style;
                const source = last ? atomize(last.runs, false) : [];
                output[Math.max(0, output.length - 1)] = ellipsize(
                    source,
                    style,
                    activeWidth,
                    measure,
                );
                return output;
            }
        }

        const forced = remaining.findIndex((atom) => atom.mandatoryBreak);
        const paragraphEnd = forced < 0 ? remaining.length : forced;
        if (paragraphEnd === 0) {
            output.push(measure([]));
            remaining = remaining.slice(1);
            continue;
        }

        const paragraph = remaining.slice(0, paragraphEnd);
        const split = fitLine(paragraph, activeWidth, overflow, measure);
        const fittedAtoms = trimTrailingWhitespace(paragraph.slice(0, split));
        const fittedRuns = mergeAtoms(fittedAtoms);
        const fitted = measure(fittedRuns);
        output.push(
            fitted.logicalWidthPixels > activeWidth && overflow === "ELLIPSIS"
                ? ellipsize(
                      fittedAtoms,
                      fittedRuns.at(-1)?.style ?? paragraph[0]!.run.style,
                      activeWidth,
                      measure,
                  )
                : fitted,
        );

        let consumed = split;
        while (consumed < paragraph.length && paragraph[consumed]!.whitespace)
            consumed += 1;
        if (consumed < paragraph.length) {
            remaining = [
                ...paragraph.slice(consumed),
                ...remaining.slice(paragraphEnd),
            ];
        } else if (forced >= 0) {
            remaining = remaining.slice(paragraphEnd + 1);
        } else {
            remaining = [];
        }
    }

    if (output.length > maximumLines && overflow !== "ALLOW_OVERFLOW") {
        throw new LayoutOverflowError(`Text exceeds ${maximumLines} lines`);
    }
    return output;
}

function fitLine(
    atoms: readonly Atom[],
    widthPixels: number,
    overflow: OverflowPolicy,
    measure: (runs: readonly PreviewRun[]) => MeasuredLine,
): number {
    let lastBreak = -1;
    let index = 0;
    while (index < atoms.length) {
        const candidate = trimTrailingWhitespace(atoms.slice(0, index + 1));
        if (measure(mergeAtoms(candidate)).logicalWidthPixels <= widthPixels) {
            if (legalBreakAfter(atoms, index)) lastBreak = index + 1;
            index += 1;
            continue;
        }
        if (index === 0) {
            if (overflow === "ERROR") {
                throw new LayoutOverflowError(
                    `An atomic token exceeds ${widthPixels} pixels`,
                );
            }
            return 1;
        }
        return lastBreak > 0 ? lastBreak : index;
    }
    return atoms.length;
}

function ellipsize(
    atoms: readonly Atom[],
    style: PreviewRun["style"],
    widthPixels: number,
    measure: (runs: readonly PreviewRun[]) => MeasuredLine,
): MeasuredLine {
    const ellipsis: PreviewRun = {
        text: "…",
        kind: "TEXT",
        unbreakable: true,
        style,
    };
    if (measure([ellipsis]).logicalWidthPixels > widthPixels)
        return measure([]);
    const retained = atoms.filter((atom) => !atom.mandatoryBreak);
    for (let end = retained.length; end > 0; end -= 1) {
        const candidate = [
            ...mergeAtoms(trimTrailingWhitespace(retained.slice(0, end))),
            ellipsis,
        ];
        const line = measure(candidate);
        if (line.logicalWidthPixels <= widthPixels) return line;
    }
    return measure([ellipsis]);
}

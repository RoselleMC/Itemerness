import type {
    DataValue,
    Diagnostic,
    FormatNode,
    ItemNode,
    LayoutNode,
    PresentationBlock,
    PreviewDisplay,
    PreviewLine,
    PreviewRun,
    PreviewViewer,
    ProjectDocument,
    ThemeNode,
} from "@itemerness/protocol";
import { parseColor } from "./colors.js";
import type { PresentationFonts } from "./fonts.js";
import { measureLine } from "./measure.js";
import { wrapRuns } from "./wrap.js";

/**
 * The optimistic browser composer.
 *
 * It turns a draft document into preview lines so an editor sees the effect of a keystroke
 * immediately. It is intentionally a smaller thing than the Kotlin compiler: the same message
 * lookup, formatting, condition and theme-fallback rules, but none of the runtime data sources,
 * budgets, or NBT concerns.
 *
 * Everything it produces is `local`. When an agent artifact for the current snapshot arrives, the
 * UI replaces this output rather than merging with it, because two composers that agree most of
 * the time are indistinguishable from one composer that is occasionally wrong.
 */

export interface LocalPreview {
    readonly display: PreviewDisplay;
    readonly diagnostics: readonly Diagnostic[];
    /** Themes rejected on the way to the selected one, in order. */
    readonly themeChain: readonly string[];
    /**
     * For each lore line, the uuid of the presentation block that produced it, or null for
     * synthetic lines (spacers, canvas scaffolding). This is what lets the preview act as an
     * editing surface: a click on a rendered line resolves to the block behind it.
     */
    readonly lineOrigins: readonly (string | null)[];
}

function diagnostic(
    code: string,
    messageKey: string,
    params: Record<string, string | number | boolean>,
    severity: Diagnostic["severity"] = "WARNING",
    businessId: string | null = null,
): Diagnostic {
    return {
        code,
        severity,
        origin: "browser",
        messageKey,
        params,
        pointer: null,
        nodeUuid: null,
        businessId,
        targetServerId: null,
        fixKey: null,
    };
}

class MessageCatalog {
    constructor(
        private readonly document: ProjectDocument,
        private readonly locale: string,
        private readonly diagnostics: Diagnostic[],
    ) {}

    lookup(key: string): string {
        const seen = new Set<string>();
        let current: string | null = this.locale;
        while (current && !seen.has(current)) {
            seen.add(current);
            const node = this.document.locales.find(
                (entry) => entry.locale === current,
            );
            if (!node) break;
            const message = node.messages[key];
            if (message !== undefined) return message;
            current = node.fallback;
        }
        const fallbackNode = this.document.locales.find(
            (entry) => entry.locale === this.document.defaultLocale,
        );
        const fallbackMessage = fallbackNode?.messages[key];
        if (fallbackMessage !== undefined) {
            this.diagnostics.push(
                diagnostic(
                    "LOCALE.FALLBACK_USED",
                    "diagnostics.locale.fallback_used",
                    {
                        key,
                        locale: this.locale,
                        fallback: this.document.defaultLocale,
                    },
                ),
            );
            return fallbackMessage;
        }
        this.diagnostics.push(
            diagnostic(
                "LOCALE.MISSING_MESSAGE",
                "diagnostics.locale.missing_message",
                { key, locale: this.locale },
                "ERROR",
            ),
        );
        return key;
    }
}

function decimalPlaces(pattern: string): number {
    const dot = pattern.indexOf(".");
    return dot < 0 ? 0 : pattern.length - dot - 1;
}

function valueToNumber(value: DataValue): number | null {
    if (value.kind === "integer" || value.kind === "decimal")
        return Number(value.value);
    return null;
}

function formatValue(
    value: DataValue,
    format: FormatNode | undefined,
    formats: readonly FormatNode[],
    messages: MessageCatalog,
): string {
    if (value.kind === "null") return "";
    if (!format) {
        switch (value.kind) {
            case "string":
                return value.value;
            case "boolean":
                return String(value.value);
            case "integer":
            case "decimal":
                return value.value;
            case "list":
                return value.values
                    .map((entry) =>
                        formatValue(entry, undefined, formats, messages),
                    )
                    .join(", ");
            default:
                return "";
        }
    }
    switch (format.kind) {
        case "integer": {
            const numeric = valueToNumber(value);
            return numeric === null ? "" : String(Math.round(numeric));
        }
        case "decimal": {
            const numeric = valueToNumber(value);
            if (numeric === null) return "";
            const text = (numeric * format.multiply).toFixed(
                decimalPlaces(format.pattern),
            );
            return format.suffixMessage
                ? `${text}${messages.lookup(format.suffixMessage)}`
                : text;
        }
        case "boolean":
            return messages.lookup(
                value.kind === "boolean" && value.value
                    ? format.trueMessage
                    : format.falseMessage,
            );
        case "namespacedKey": {
            if (value.kind !== "string") return "";
            const [namespace, path] = value.value.includes(":")
                ? value.value.split(":", 2)
                : ["minecraft", value.value];
            if (format.mode === "PATH") return path ?? value.value;
            const key = (format.messagePattern ?? "value.{namespace}.{path}")
                .replace("{namespace}", namespace ?? "")
                .replace("{path}", path ?? "");
            const message = messages.lookup(key);
            if (message !== key) return message;
            return format.missingValue === "FULL_KEY"
                ? value.value
                : (path ?? value.value);
        }
        case "list": {
            if (value.kind !== "list") return "";
            const element = formats.find(
                (entry) => entry.id === format.elementFormat,
            );
            const separator = messages.lookup(format.separatorMessage);
            return value.values
                .map((entry) => formatValue(entry, element, formats, messages))
                .join(separator);
        }
        default:
            return "";
    }
}

function compare(
    operator: string,
    left: DataValue | null,
    right: DataValue | null,
): boolean {
    if (operator === "EXISTS") return left !== null && left.kind !== "null";
    if (left === null || right === null) return false;
    const leftNumber = valueToNumber(left);
    const rightNumber = valueToNumber(right);
    if (leftNumber !== null && rightNumber !== null) {
        switch (operator) {
            case "LESS_THAN":
                return leftNumber < rightNumber;
            case "LESS_THAN_OR_EQUAL":
                return leftNumber <= rightNumber;
            case "GREATER_THAN":
                return leftNumber > rightNumber;
            case "GREATER_THAN_OR_EQUAL":
                return leftNumber >= rightNumber;
            case "EQUALS":
                return leftNumber === rightNumber;
            case "NOT_EQUALS":
                return leftNumber !== rightNumber;
            default:
                return false;
        }
    }
    const equal = JSON.stringify(left) === JSON.stringify(right);
    if (operator === "EQUALS") return equal;
    if (operator === "NOT_EQUALS") return !equal;
    return false;
}

/** Walks the theme fallback chain, recording why each theme was rejected. */
export function resolveTheme(
    document: ProjectDocument,
    requestedId: string,
    viewer: PreviewViewer,
): {
    theme: ThemeNode | null;
    chain: string[];
    reasons: PreviewDisplay["fallbackReasons"];
} {
    const byId = new Map(document.themes.map((theme) => [theme.id, theme]));
    const chain: string[] = [];
    const reasons: PreviewDisplay["fallbackReasons"] = [];
    const capabilities = new Set(viewer.capabilities);
    let current: string | null = requestedId;
    const seen = new Set<string>();

    while (current && !seen.has(current)) {
        seen.add(current);
        chain.push(current);
        const theme = byId.get(current);
        if (!theme) {
            reasons.push({
                theme: current,
                code: "RENDER_FAILURE",
                detail: "theme is not declared",
            });
            return { theme: null, chain, reasons };
        }
        if (theme.requiresResourcePack && !viewer.resourcePackLoaded) {
            reasons.push({
                theme: theme.id,
                code: "RESOURCE_PACK_UNAVAILABLE",
                detail: "viewer has no accepted pack",
            });
            current = theme.fallback;
            continue;
        }
        const missing = theme.requiredCapabilities.filter(
            (capability) => !capabilities.has(capability),
        );
        if (missing.length > 0) {
            reasons.push({
                theme: theme.id,
                code: "CAPABILITY_MISSING",
                detail: missing.join(", "),
            });
            current = theme.fallback;
            continue;
        }
        if (
            theme.vanillaTooltipLines === "REQUIRE_MANAGED" &&
            !viewer.managesVanillaTooltipLines
        ) {
            reasons.push({
                theme: theme.id,
                code: "UNMANAGED_TOOLTIP_LINES",
                detail: "theme requires managed tooltip lines",
            });
            current = theme.fallback;
            continue;
        }
        return { theme, chain, reasons };
    }
    return { theme: null, chain, reasons };
}

interface ComposeContext {
    readonly document: ProjectDocument;
    readonly item: ItemNode;
    readonly theme: ThemeNode;
    readonly layout: LayoutNode;
    readonly messages: MessageCatalog;
    readonly data: Map<string, DataValue>;
    readonly facts: Map<string, DataValue>;
    readonly diagnostics: Diagnostic[];
    readonly fonts: PresentationFonts;
    readonly viewer: PreviewViewer;
}

type LocalBlockKind = "FIELD" | "DESCRIPTION" | "OTHER";

interface LocalBlockLine {
    readonly runs: PreviewRun[];
    readonly origin: string;
    readonly kind: LocalBlockKind;
    readonly fieldValueIndex: number | null;
    readonly wrapping: string | null;
}

function styleFor(
    context: ComposeContext,
    role: string,
    fontRole = "text",
): PreviewRun["style"] {
    const style = context.theme.styles[role];
    return {
        color: parseColor(style?.color ?? null),
        font:
            context.theme.fonts[fontRole] ??
            context.theme.fonts.text ??
            "minecraft:default",
        bold: style?.bold ?? false,
        italic: style?.italic ?? false,
        underlined: style?.underlined ?? false,
        strikethrough: style?.strikethrough ?? false,
    };
}

function iconRun(context: ComposeContext, icon: string | null): PreviewRun[] {
    if (!icon || !context.viewer.resourcePackLoaded) return [];
    const glyph = context.document.glyphs.find((entry) => entry.id === icon);
    if (!glyph) {
        context.diagnostics.push(
            diagnostic(
                "ASSETS.ICON_UNDECLARED",
                "diagnostics.assets.icon_undeclared",
                { icon },
                "ERROR",
                context.item.id,
            ),
        );
        return [];
    }
    return [
        {
            text: String.fromCodePoint(glyph.codePoint),
            kind: "ICON",
            unbreakable: true,
            style: { ...styleFor(context, "value", "icons"), font: glyph.font },
        },
    ];
}

function blockRuns(
    context: ComposeContext,
    block: PresentationBlock,
): LocalBlockLine[] {
    switch (block.type) {
        case "text": {
            const value = context.data.get(block.data);
            if (!value || value.kind === "null") {
                if (block.missingPolicy === "OMIT") return [];
                context.diagnostics.push(
                    diagnostic(
                        "DATA.MISSING",
                        "diagnostics.data.missing",
                        { key: block.data },
                        "ERROR",
                        context.item.id,
                    ),
                );
                return [];
            }
            return [
                {
                    origin: block.uuid,
                    kind: "OTHER",
                    fieldValueIndex: null,
                    wrapping: block.wrapping,
                    runs: [
                        {
                            text: formatValue(
                                value,
                                undefined,
                                context.document.formats,
                                context.messages,
                            ),
                            kind: "TEXT",
                            unbreakable: block.unbreakable,
                            style: styleFor(context, block.style ?? "value"),
                        },
                    ],
                },
            ];
        }
        case "field": {
            const value = context.data.get(block.data);
            if (!value || value.kind === "null") {
                if (block.missingPolicy === "OMIT") return [];
                context.diagnostics.push(
                    diagnostic(
                        "DATA.MISSING",
                        "diagnostics.data.missing",
                        { key: block.data },
                        "ERROR",
                        context.item.id,
                    ),
                );
                return [];
            }
            const format = context.document.formats.find(
                (entry) => entry.id === block.format,
            );
            const runs: PreviewRun[] = [
                ...iconRun(context, block.icon),
                {
                    text: `${context.messages.lookup(block.labelMessage)}: `,
                    kind: "TEXT",
                    unbreakable: true,
                    style: styleFor(context, block.style ?? "label"),
                },
                {
                    text: formatValue(
                        value,
                        format,
                        context.document.formats,
                        context.messages,
                    ),
                    kind: "TEXT",
                    unbreakable: false,
                    style: styleFor(context, block.style ?? "value"),
                },
            ];
            return [
                {
                    origin: block.uuid,
                    kind: "FIELD",
                    fieldValueIndex: runs.length - 1,
                    wrapping: block.wrapping,
                    runs,
                },
            ];
        }
        case "description":
            return [
                {
                    origin: block.uuid,
                    kind: "DESCRIPTION",
                    fieldValueIndex: null,
                    wrapping: block.wrapping,
                    runs: [
                        {
                            text: context.messages.lookup(block.message),
                            kind: "TEXT",
                            unbreakable: false,
                            style: styleFor(
                                context,
                                block.style ?? "description",
                            ),
                        },
                    ],
                },
            ];
        case "conditional": {
            const resolve = (reference: {
                kind: string;
                key?: string;
                value?: DataValue;
            }): DataValue | null => {
                if (reference.kind === "data")
                    return context.data.get(reference.key!) ?? null;
                if (reference.kind === "fact")
                    return context.facts.get(reference.key!) ?? null;
                return reference.value ?? null;
            };
            const matched = compare(
                block.condition.operator,
                resolve(block.condition.left),
                block.condition.right ? resolve(block.condition.right) : null,
            );
            const branch = matched ? block.thenBlocks : block.otherwiseBlocks;
            // Nested blocks keep their own uuids, so a click on a conditional's output selects the
            // nested row rather than the whole conditional.
            return branch.flatMap((nested) => blockRuns(context, nested));
        }
        case "repeat": {
            const value = context.data.get(block.data);
            if (!value || value.kind !== "list") {
                if (block.missingPolicy === "OMIT") return [];
                return [];
            }
            const format = context.document.formats.find(
                (entry) => entry.id === block.template.format,
            );
            return value.values
                .slice(0, block.maximumElements)
                .map((element) => {
                    const entry =
                        element.kind === "compound"
                            ? element.entries[block.template.valuePath]
                            : undefined;
                    const text =
                        entry && entry.kind !== "null"
                            ? formatValue(
                                  entry,
                                  format,
                                  context.document.formats,
                                  context.messages,
                              )
                            : context.messages.lookup(
                                  block.template.missingMessage,
                              );
                    const runs: PreviewRun[] = [
                        ...iconRun(context, block.template.icon),
                        {
                            text: `${context.messages.lookup(block.template.labelMessage)}: `,
                            kind: "TEXT",
                            unbreakable: true,
                            style: styleFor(context, block.style ?? "label"),
                        },
                        {
                            text,
                            kind: "TEXT",
                            unbreakable: false,
                            style: styleFor(context, block.style ?? "value"),
                        },
                    ];
                    return {
                        origin: block.uuid,
                        kind: "FIELD",
                        fieldValueIndex: runs.length - 1,
                        wrapping: null,
                        runs,
                    };
                });
        }
        case "nestedItemList": {
            return context.item.definition.contents.map((entry) => ({
                origin: block.uuid,
                kind: "OTHER" as const,
                fieldValueIndex: null,
                wrapping: null,
                runs: [
                    {
                        text: `${entry.amount}x ${entry.item}`,
                        kind: "TEXT" as const,
                        unbreakable: false,
                        style: styleFor(context, block.style ?? "value"),
                    },
                ],
            }));
        }
        default:
            return [];
    }
}

function toPreviewLine(
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

interface FlowLine {
    readonly line: PreviewLine;
    readonly origin: string | null;
}

interface FlowComposition {
    readonly lines: FlowLine[];
    readonly sectionBoundaries: ReadonlySet<number>;
    readonly targetWidthPixels: number;
}

function exactAdvanceRuns(
    context: ComposeContext,
    pixels: number,
    kind: PreviewRun["kind"],
    textStyle: PreviewRun["style"],
): PreviewRun[] {
    if (pixels <= 0) return [];
    const spacing = context.document.spacing;
    if (context.viewer.resourcePackLoaded && spacing) {
        const output: PreviewRun[] = [];
        let remaining = pixels;
        while (remaining > 0) {
            const part = Math.min(
                remaining,
                spacing.positive.maximumAdvancePixels,
            );
            const codePoint = context.fonts.spacingCodePoint(part);
            if (codePoint === null) break;
            output.push({
                text: String.fromCodePoint(codePoint),
                kind,
                unbreakable: true,
                style: {
                    color: null,
                    font: spacing.font,
                    bold: false,
                    italic: false,
                    underlined: false,
                    strikethrough: false,
                },
            });
            remaining -= part;
        }
        if (remaining === 0) return output;
        context.diagnostics.push(
            diagnostic(
                "LAYOUT.SPACING_UNREACHABLE",
                "diagnostics.canvas.spacing_unreachable",
                { pixels },
                "ERROR",
                context.item.id,
            ),
        );
    }

    return [
        {
            text: "\u200C".repeat(pixels),
            kind: kind === "SPACING" ? "TEXT" : kind,
            unbreakable: true,
            style: {
                ...textStyle,
                bold: true,
                italic: false,
                underlined: false,
                strikethrough: false,
            },
        },
    ];
}

function paddingRuns(
    context: ComposeContext,
    pixels: number,
    textStyle: PreviewRun["style"],
    bounded: boolean,
): PreviewRun[] {
    if (pixels <= 0) return [];
    if (context.viewer.resourcePackLoaded && context.document.spacing) {
        return exactAdvanceRuns(context, pixels, "SPACING", textStyle);
    }
    const style = {
        ...textStyle,
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    };
    const unit = measureLine(
        [{ text: " ", kind: "TEXT", unbreakable: true, style }],
        context.fonts,
        { lenient: true },
    ).logicalWidthPixels;
    const count = bounded
        ? Math.floor(pixels / Math.max(1, unit))
        : Math.ceil(pixels / Math.max(1, unit));
    return count === 0
        ? []
        : [
              {
                  text: " ".repeat(count),
                  kind: "TEXT",
                  unbreakable: true,
                  style,
              },
          ];
}

function addIconGap(
    context: ComposeContext,
    block: LocalBlockLine,
): { runs: PreviewRun[]; fieldValueIndex: number | null } {
    if (
        context.layout.kind !== "flow" ||
        block.runs[0]?.kind !== "ICON" ||
        context.layout.fieldIconGapPixels <= 0
    ) {
        return {
            runs: [...block.runs],
            fieldValueIndex: block.fieldValueIndex,
        };
    }
    const gap = exactAdvanceRuns(
        context,
        context.layout.fieldIconGapPixels,
        "SPACING",
        styleFor(context, "value"),
    );
    return {
        runs: [block.runs[0], ...gap, ...block.runs.slice(1)],
        fieldValueIndex:
            block.fieldValueIndex === null
                ? null
                : block.fieldValueIndex + gap.length,
    };
}

function flowInsets(
    context: ComposeContext,
    block: LocalBlockLine,
): { left: number; right: number } {
    if (context.layout.kind !== "flow") return { left: 0, right: 0 };
    const themeLeft = context.theme.content?.leftPaddingPixels ?? 0;
    const themeRight = context.theme.content?.rightPaddingPixels ?? 0;
    const sectionLeft =
        block.kind === "DESCRIPTION"
            ? context.layout.descriptionLeftPaddingPixels
            : context.layout.fieldLeftPaddingPixels;
    const sectionRight =
        block.kind === "DESCRIPTION"
            ? context.layout.descriptionRightPaddingPixels
            : 0;
    return {
        left: themeLeft + sectionLeft,
        right: themeRight + sectionRight,
    };
}

function wrappingFor(context: ComposeContext, block: LocalBlockLine) {
    const policy =
        (block.wrapping ? context.layout.wrapping[block.wrapping] : null) ??
        context.layout.wrapping.body ??
        Object.values(context.layout.wrapping)[0];
    if (!policy)
        throw new Error(`Layout ${context.layout.id} has no wrapping policy`);
    return policy;
}

function composeFlow(
    context: ComposeContext,
    blocks: readonly LocalBlockLine[],
    maximumWidthPixels: number,
): FlowComposition {
    const layout = context.layout;
    if (layout.kind !== "flow") {
        return {
            lines: blocks.map((block) => ({
                line: toPreviewLine(block.runs, context.fonts),
                origin: block.origin,
            })),
            sectionBoundaries: new Set(),
            targetWidthPixels: maximumWidthPixels,
        };
    }

    const minimumWidthPixels = Math.max(
        layout.minimumWidthPixels,
        context.theme.content?.minimumWidthPixels ?? 1,
    );
    const naturalWidthPixels = blocks.reduce((widest, block) => {
        const { runs } = addIconGap(context, block);
        const insets = flowInsets(context, block);
        return Math.max(
            widest,
            measureLine(runs, context.fonts, { lenient: true })
                .logicalWidthPixels +
                insets.left +
                insets.right,
        );
    }, 0);
    const targetWidthPixels = Math.min(
        maximumWidthPixels,
        Math.max(minimumWidthPixels, naturalWidthPixels),
    );
    const lines: FlowLine[] = [];
    const sectionBoundaries = new Set<number>();

    blocks.forEach((block, blockIndex) => {
        if (lines.length > 0) sectionBoundaries.add(lines.length);
        const policy = wrappingFor(context, block);
        const insets = flowInsets(context, block);
        if (
            block.kind === "DESCRIPTION" &&
            lines.length > 0 &&
            layout.descriptionGapBeforePixels > 0
        ) {
            const count = Math.floor(
                layout.descriptionGapBeforePixels / policy.lineHeightPixels,
            );
            for (let index = 0; index < count; index += 1) {
                lines.push({
                    line: toPreviewLine([], context.fonts),
                    origin: null,
                });
            }
        }

        const availableWidthPixels =
            Math.min(
                policy.widthPixels ?? targetWidthPixels,
                targetWidthPixels,
            ) -
            insets.left -
            insets.right;
        const withGap = addIconGap(context, block);
        let runs = withGap.runs;
        if (
            block.kind === "FIELD" &&
            layout.fieldValueAlignment === "RIGHT" &&
            withGap.fieldValueIndex !== null
        ) {
            const measured = measureLine(runs, context.fonts, {
                lenient: true,
            }).logicalWidthPixels;
            const deficit = availableWidthPixels - measured;
            if (deficit > 0) {
                const valueIndex = withGap.fieldValueIndex;
                const valueStyle = runs[valueIndex]!.style;
                runs = [
                    ...runs.slice(0, valueIndex),
                    ...paddingRuns(context, deficit, valueStyle, true),
                    ...runs.slice(valueIndex),
                ];
            }
        }

        const wrapped = wrapRuns(runs, context.fonts, {
            widthPixels: Math.max(1, availableWidthPixels),
            maximumLines: policy.maximumLines,
            overflow:
                policy.overflow === "ERROR" ? "ELLIPSIS" : policy.overflow,
            preserveExplicitLines: policy.preserveExplicitLines,
            continuationIndentPixels: policy.continuationIndentPixels,
        });
        wrapped.forEach((line, index) => {
            const continuation =
                index === 0 ? 0 : policy.continuationIndentPixels;
            const style = line.runs[0]?.style ?? styleFor(context, "value");
            const placed = [
                ...paddingRuns(
                    context,
                    insets.left + continuation,
                    style,
                    false,
                ),
                ...line.runs,
                ...paddingRuns(context, insets.right, style, false),
            ];
            lines.push({
                line: toPreviewLine(placed, context.fonts),
                origin: block.origin,
            });
        });

        if (blockIndex < blocks.length - 1 && layout.blockGapAfterPixels > 0) {
            const count = Math.floor(
                layout.blockGapAfterPixels / policy.lineHeightPixels,
            );
            for (let index = 0; index < count; index += 1) {
                lines.push({
                    line: toPreviewLine([], context.fonts),
                    origin: null,
                });
            }
        }
    });

    return { lines, sectionBoundaries, targetWidthPixels };
}

const FRAME_CHARACTERS = {
    UNICODE_SINGLE: ["┌", "─", "┐", "│", "└", "┘", "├", "┤"],
    UNICODE_DOUBLE: ["╔", "═", "╗", "║", "╚", "╝", "╠", "╣"],
    ASCII_SAFE: ["+", "-", "+", "|", "+", "+", "+", "+"],
    BRACKETED_SECTION: ["[", "-", "]", "[", "[", "]", "[", "]"],
    SEPARATOR_ONLY: ["", "─", "", "", "", "", "", ""],
} as const;

function composeCharacterFrame(
    context: ComposeContext,
    flow: FlowComposition,
): FlowLine[] {
    const frame = context.theme.characterFrame;
    if (!frame) return flow.lines;
    const characters = FRAME_CHARACTERS[frame.preset];
    const frameStyle = {
        ...styleFor(context, "frame", "frame"),
        bold: false,
        italic: false,
    };
    const border = (
        left: string,
        fill: string,
        right: string,
        target: number,
    ) => {
        const leftRun: PreviewRun = {
            text: left,
            kind: "FRAME",
            unbreakable: true,
            style: frameStyle,
        };
        const fillRun: PreviewRun = {
            text: fill,
            kind: "FRAME",
            unbreakable: true,
            style: frameStyle,
        };
        const rightRun: PreviewRun = {
            text: right,
            kind: "FRAME",
            unbreakable: true,
            style: frameStyle,
        };
        const fixed = measureLine([leftRun, rightRun], context.fonts, {
            lenient: true,
        }).logicalWidthPixels;
        const unit = Math.max(
            1,
            measureLine([fillRun], context.fonts, { lenient: true })
                .logicalWidthPixels,
        );
        const count = Math.max(
            1,
            Math.ceil(Math.max(0, target - fixed) / unit),
        );
        return toPreviewLine(
            [leftRun, { ...fillRun, text: fill.repeat(count) }, rightRun],
            context.fonts,
        );
    };

    if (frame.preset === "SEPARATOR_ONLY") {
        const separator = border("", characters[1], "", flow.targetWidthPixels);
        return [
            { line: separator, origin: null },
            ...flow.lines,
            { line: separator, origin: null },
        ];
    }

    const requestedWidth = Math.max(
        frame.minimumWidthPixels,
        flow.targetWidthPixels +
            frame.leftPaddingPixels +
            frame.rightPaddingPixels +
            4,
    );
    const top = border(
        characters[0],
        characters[1],
        characters[2],
        requestedWidth,
    );
    const bottom = border(
        characters[4],
        characters[1],
        characters[5],
        top.logicalWidthPixels,
    );
    const output: FlowLine[] = [{ line: top, origin: null }];
    flow.lines.forEach((entry, index) => {
        if (flow.sectionBoundaries.has(index)) {
            output.push({
                line: border(
                    characters[6],
                    characters[1],
                    characters[7],
                    top.logicalWidthPixels,
                ),
                origin: null,
            });
        }
        const edge: PreviewRun = {
            text: characters[3],
            kind: "FRAME",
            unbreakable: true,
            style: frameStyle,
        };
        const paddingStyle = styleFor(context, "value");
        const base = [
            edge,
            ...exactAdvanceRuns(
                context,
                frame.leftPaddingPixels,
                "SPACING",
                paddingStyle,
            ),
            ...entry.line.runs,
        ];
        const withoutRight = measureLine([...base, edge], context.fonts, {
            lenient: true,
        }).logicalWidthPixels;
        const rightNeed = Math.max(0, top.logicalWidthPixels - withoutRight);
        output.push({
            line: toPreviewLine(
                [
                    ...base,
                    ...exactAdvanceRuns(
                        context,
                        rightNeed,
                        "SPACING",
                        paddingStyle,
                    ),
                    edge,
                ],
                context.fonts,
            ),
            origin: entry.origin,
        });
    });
    output.push({ line: bottom, origin: null });
    return output;
}

type FrameRow = NonNullable<
    ComposeContext["theme"]["segmentedFrame"]
>["top"];

/**
 * Signed spacing runs.
 *
 * `exactAdvanceRuns` only walks forward. A segmented body has to rewind the cursor back over the
 * fill it just drew so the text lands on top of it, which needs the negative range too. Mirrors
 * `PresentationEngine.spacingRuns`.
 */
function signedAdvanceRuns(
    context: ComposeContext,
    pixels: number,
    kind: PreviewRun["kind"],
): PreviewRun[] {
    if (pixels === 0) return [];
    const spacing = context.document.spacing;
    if (!spacing || !context.viewer.resourcePackLoaded) {
        context.diagnostics.push(
            diagnostic(
                "LAYOUT.SPACING_UNREACHABLE",
                "diagnostics.canvas.spacing_unreachable",
                { pixels },
                "ERROR",
                context.item.id,
            ),
        );
        return [];
    }
    const output: PreviewRun[] = [];
    let remaining = pixels;
    while (remaining !== 0) {
        const part =
            remaining > 0
                ? Math.min(remaining, spacing.positive.maximumAdvancePixels)
                : Math.max(remaining, spacing.negative.minimumAdvancePixels);
        const codePoint = context.fonts.spacingCodePoint(part);
        if (codePoint === null) {
            context.diagnostics.push(
                diagnostic(
                    "LAYOUT.SPACING_UNREACHABLE",
                    "diagnostics.canvas.spacing_unreachable",
                    { pixels },
                    "ERROR",
                    context.item.id,
                ),
            );
            return output;
        }
        output.push({
            text: String.fromCodePoint(codePoint),
            kind,
            unbreakable: true,
            style: {
                color: null,
                font: spacing.font,
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

/**
 * One frame piece with its kern appended.
 *
 * A Minecraft bitmap glyph advances one pixel past its ink, so butting pieces together leaves a gap
 * at every seam — visible as a dashed break in the frame's highlight line. The kern cancels that
 * pixel. It has to live in the same font as the piece so the two share a style and a whole frame row
 * stays a single run.
 */
function framePieceRun(
    context: ComposeContext,
    id: string,
    kern: PreviewRun | null,
): PreviewRun | null {
    const glyph = context.document.glyphs.find((entry) => entry.id === id);
    if (!glyph) {
        context.diagnostics.push(
            diagnostic(
                "ASSETS.FRAME_UNDECLARED",
                "diagnostics.assets.frame_undeclared",
                { glyph: id },
                "ERROR",
                context.item.id,
            ),
        );
        return null;
    }
    const style = {
        ...styleFor(context, "frame", "frame"),
        font: glyph.font,
        bold: false,
        italic: false,
    };
    const text = String.fromCodePoint(glyph.codePoint);
    if (!kern) return { text, kind: "FRAME", unbreakable: true, style };
    if (kern.style.font !== style.font) {
        context.diagnostics.push(
            diagnostic(
                "ASSETS.FRAME_KERN_FONT",
                "diagnostics.assets.frame_kern_font",
                { glyph: id },
                "ERROR",
                context.item.id,
            ),
        );
        return null;
    }
    return {
        text: text + kern.text,
        kind: "FRAME",
        unbreakable: true,
        style,
    };
}

/**
 * Lays out a `SEGMENTED_FRAME` theme, name included.
 *
 * Each row is drawn from resource-pack pieces rather than box characters, so the frame tracks the
 * text width instead of being pinned to one glyph's width. A row is
 * `left + fill×⌈m/2⌉ + center + fill×⌊m/2⌋ + right`, collapsing to `left + fill + right` when the
 * row has no centre ornament.
 *
 * The name shares the top row rather than sitting above it — that is how Epic's own font is meant to
 * be used, and it is what keeps the name inside the frame. Leaving it out would strand it above the
 * border with nothing behind it, since a theme that paints its own panel also blanks vanilla's.
 *
 * Mirrors `PresentationEngine.renderSegmentedFrame` in itemerness-core. The two have to agree pixel
 * for pixel: the plugin composes what the client renders, and this composes what the editor
 * previews.
 */
function composeSegmentedFrame(
    context: ComposeContext,
    flow: FlowComposition,
    name: PreviewLine,
): { name: PreviewLine; lines: FlowLine[] } {
    const frame = context.theme.segmentedFrame;
    if (!frame) return { name, lines: flow.lines };

    const target = Math.max(
        frame.minimumWidthPixels,
        Math.max(flow.targetWidthPixels, name.logicalWidthPixels) +
            frame.leftPaddingPixels +
            frame.rightPaddingPixels +
            8,
    );
    if (target > frame.maximumWidthPixels) {
        context.diagnostics.push(
            diagnostic(
                "LAYOUT.SEGMENTED_OVERFLOW",
                "diagnostics.layout.segmented_overflow",
                { target, maximum: frame.maximumWidthPixels },
                "ERROR",
                context.item.id,
            ),
        );
        return { name, lines: flow.lines };
    }

    const width = (runs: PreviewRun[]) =>
        measureLine(runs, context.fonts, { lenient: true }).logicalWidthPixels;

    /**
     * The background of one frame row: the two caps with the fill tiled between them, split around a
     * centre ornament when the row has one.
     *
     * Border rows and body rows share this so a row's artwork cannot drift depending on whether it
     * carries text. `exact` is the difference: a body row's interior has to be covered to the pixel,
     * because the text is then drawn back over it.
     */
    const strip = (
        row: FrameRow,
        exact: boolean,
    ): { runs: PreviewRun[]; interior: number } | null => {
        const kern = row.kern ? framePieceRun(context, row.kern, null) : null;
        if (row.kern && !kern) return null;
        const left = framePieceRun(context, row.left, kern);
        const fill = framePieceRun(context, row.fill, kern);
        const right = framePieceRun(context, row.right, kern);
        const center = row.center
            ? framePieceRun(context, row.center, kern)
            : null;
        if (!left || !fill || !right) return null;
        if (row.center && !center) return null;

        const leftWidth = width([left]);
        const rightWidth = width([right]);
        const centerWidth = center ? width([center]) : 0;
        const unit = Math.max(1, width([fill]));
        const span = target - leftWidth - rightWidth - centerWidth;
        if (span < 0) {
            context.diagnostics.push(
                diagnostic(
                    "LAYOUT.SEGMENTED_CAPS_OVERFLOW",
                    "diagnostics.layout.segmented_caps_overflow",
                    { span },
                    "ERROR",
                    context.item.id,
                ),
            );
            return null;
        }
        if (exact && span % unit !== 0) {
            context.diagnostics.push(
                diagnostic(
                    "LAYOUT.SEGMENTED_FILL_INEXACT",
                    "diagnostics.layout.segmented_fill_inexact",
                    { span, unit },
                    "ERROR",
                    context.item.id,
                ),
            );
            return null;
        }
        const count = exact ? span / unit : Math.ceil(span / unit);
        // The odd pixel biases left so the ornament sits where a reader expects the centre.
        const leading = center ? Math.ceil(count / 2) : count;
        const runs = center
            ? [
                  left,
                  { ...fill, text: fill.text.repeat(leading) },
                  center,
                  { ...fill, text: fill.text.repeat(count - leading) },
                  right,
              ]
            : [left, { ...fill, text: fill.text.repeat(count) }, right];
        return { runs, interior: target - leftWidth - rightWidth };
    };

    const border = (row: FrameRow): PreviewLine | null => {
        const parts = strip(row, false);
        return parts ? toPreviewLine(parts.runs, context.fonts) : null;
    };

    const body = (row: FrameRow, content: PreviewLine): PreviewLine | null => {
        const parts = strip(row, true);
        if (!parts) return null;
        const { interior } = parts;
        const remaining =
            interior - frame.leftPaddingPixels - content.logicalWidthPixels;
        if (remaining < frame.rightPaddingPixels) {
            context.diagnostics.push(
                diagnostic(
                    "LAYOUT.SEGMENTED_CONTENT_OVERFLOW",
                    "diagnostics.layout.segmented_content_overflow",
                    { remaining },
                    "ERROR",
                    context.item.id,
                ),
            );
            return null;
        }
        // The strip is drawn first, then the cursor rewinds across the whole interior so the text
        // lands on top of it. An ornament rides in the strip and stays clear of the text vertically.
        return toPreviewLine(
            [
                ...parts.runs.slice(0, -1),
                ...signedAdvanceRuns(context, -interior, "SPACING"),
                ...signedAdvanceRuns(context, frame.leftPaddingPixels, "SPACING"),
                ...content.runs,
                ...signedAdvanceRuns(context, remaining, "WIDTH_ANCHOR"),
                parts.runs.at(-1)!,
            ],
            context.fonts,
        );
    };

    const framedName = body(frame.top, name);
    const bottom = border(frame.bottom);
    if (!framedName || !bottom) return { name, lines: flow.lines };

    const output: FlowLine[] = [];
    for (const [index, entry] of flow.lines.entries()) {
        if (flow.sectionBoundaries.has(index) && frame.connector) {
            const connector = border(frame.connector);
            if (!connector) return { name, lines: flow.lines };
            output.push({ line: connector, origin: null });
        }
        const line = body(frame.body, entry.line);
        if (!line) return { name, lines: flow.lines };
        output.push({ line, origin: entry.origin });
    }
    output.push({ line: bottom, origin: null });
    return { name: framedName, lines: output };
}

/**
 * Lays out a canvas theme's layers with signed spacing runs.
 *
 * This reproduces the shape of what the compiler emits — reserved height lines, a spacing run to
 * reach each layer's x, the layer glyph itself, a spacing run back, and a trailing width anchor —
 * so the annotation overlay has something real to point at. Exact layer ordering and the compiler's
 * bound checks remain the agent's job.
 */
function composeCanvas(
    context: ComposeContext,
    contentLines: Array<{ line: PreviewLine; origin: string | null }>,
): Array<{ line: PreviewLine; origin: string | null }> {
    const canvas = context.theme.canvas;
    if (!canvas) return contentLines;
    const lineHeight = 10;
    const reserved = Math.max(canvas.reserveTooltipLines, contentLines.length);
    const lines: PreviewRun[][] = Array.from({ length: reserved }, () => []);
    const origins: (string | null)[] = Array.from(
        { length: reserved },
        () => null,
    );
    const spacingFont = context.theme.fonts.spacing ?? "itemerness:spacing";
    const spacingStyle: PreviewRun["style"] = {
        color: null,
        font: spacingFont,
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    };

    const spacing = (
        pixels: number,
        kind: PreviewRun["kind"],
    ): PreviewRun[] => {
        if (pixels === 0) return [];
        const codePoint = context.fonts.spacingCodePoint(pixels);
        if (codePoint === null) {
            context.diagnostics.push(
                diagnostic(
                    "CANVAS.SPACING_UNREACHABLE",
                    "diagnostics.canvas.spacing_unreachable",
                    { pixels },
                    "ERROR",
                    context.item.id,
                ),
            );
            return [];
        }
        return [
            {
                text: String.fromCodePoint(codePoint),
                kind,
                unbreakable: true,
                style: spacingStyle,
            },
        ];
    };

    for (const layer of [...canvas.layers].sort(
        (left, right) => left.drawOrder - right.drawOrder,
    )) {
        const glyph = context.document.glyphs.find(
            (entry) => entry.id === layer.asset,
        );
        if (!glyph) {
            context.diagnostics.push(
                diagnostic(
                    "CANVAS.LAYER_UNDECLARED",
                    "diagnostics.canvas.layer_undeclared",
                    { asset: layer.asset },
                    "ERROR",
                    context.item.id,
                ),
            );
            continue;
        }
        const lineIndex = Math.min(
            reserved - 1,
            Math.max(0, layer.baselineLine),
        );
        const x =
            layer.anchor === "TOP_RIGHT"
                ? canvas.widthPixels + layer.xPixels
                : layer.xPixels;
        const target = lines[lineIndex]!;
        target.push(...spacing(x, "SPACING"));
        target.push({
            text: String.fromCodePoint(glyph.codePoint),
            kind: "BITMAP",
            unbreakable: true,
            style: { ...spacingStyle, font: glyph.font },
        });
        target.push(
            ...spacing(-(x + Math.round(glyph.advancePixels)), "SPACING"),
        );
    }

    const anchors =
        context.layout.kind === "canvas" ? context.layout.anchors : {};
    contentLines.forEach((content, index) => {
        const anchorName =
            Object.keys(anchors)[
                Math.min(index, Object.keys(anchors).length - 1)
            ];
        const anchor = anchorName ? anchors[anchorName] : undefined;
        const lineIndex = anchor
            ? Math.min(reserved - 1, Math.floor(anchor.y / lineHeight))
            : index;
        const x = anchor?.x ?? 0;
        const target = lines[lineIndex]!;
        target.push(...spacing(x, "SPACING"));
        target.push(...content.line.runs);
        target.push(
            ...spacing(-(x + content.line.logicalWidthPixels), "SPACING"),
        );
        origins[lineIndex] = content.origin;
    });

    // A canvas draws entirely through negative spacing, so without an explicit anchor the client
    // would measure the tooltip as zero pixels wide. The anchor is what gives the frame its width.
    const first = lines[0]!;
    const measured = measureLine(first, context.fonts, { lenient: true });
    first.push(
        ...spacing(
            canvas.finalTooltipWidthPixels - measured.logicalWidthPixels,
            "WIDTH_ANCHOR",
        ),
    );

    return lines.map((runs, index) => ({
        line: toPreviewLine(runs, context.fonts),
        origin: origins[index] ?? null,
    }));
}

export interface ComposeOptions {
    readonly document: ProjectDocument;
    readonly itemId: string;
    readonly viewer: PreviewViewer;
    readonly fonts: PresentationFonts;
}

export function composeLocalPreview(options: ComposeOptions): LocalPreview {
    const { document, viewer, fonts } = options;
    const diagnostics: Diagnostic[] = [];
    const item =
        document.items.find(
            (entry) => `${document.namespace}:${entry.id}` === options.itemId,
        ) ?? document.items.find((entry) => entry.id === options.itemId);
    if (!item) {
        return {
            display: emptyDisplay(options.itemId),
            diagnostics: [
                diagnostic(
                    "ITEM.UNKNOWN",
                    "diagnostics.item.unknown",
                    { item: options.itemId },
                    "ERROR",
                ),
            ],
            themeChain: [],
            lineOrigins: [],
        };
    }

    const requestedTheme = viewer.requestedTheme ?? item.presentation.theme;
    const { theme, chain, reasons } = resolveTheme(
        document,
        requestedTheme,
        viewer,
    );
    if (!theme) {
        return {
            display: emptyDisplay(options.itemId),
            diagnostics: [
                ...diagnostics,
                diagnostic(
                    "THEME.NO_SAFE_THEME",
                    "diagnostics.theme.no_safe_theme",
                    { requested: requestedTheme },
                    "ERROR",
                    item.id,
                ),
            ],
            themeChain: chain,
            lineOrigins: [],
        };
    }
    const layout = document.layouts.find(
        (entry) => entry.id === item.presentation.layout,
    );
    if (!layout) {
        return {
            display: emptyDisplay(options.itemId),
            diagnostics: [
                diagnostic(
                    "LAYOUT.UNKNOWN",
                    "diagnostics.layout.unknown",
                    { layout: item.presentation.layout },
                    "ERROR",
                    item.id,
                ),
            ],
            themeChain: chain,
            lineOrigins: [],
        };
    }

    const messages = new MessageCatalog(document, viewer.locale, diagnostics);
    const data = new Map<string, DataValue>();
    for (const assignment of item.definition.instance.defaults)
        data.set(assignment.key, assignment.value);
    for (const assignment of item.definition.definitionData)
        data.set(assignment.key, assignment.value);
    for (const assignment of item.previewData)
        data.set(assignment.key, assignment.value);
    const facts = new Map<string, DataValue>();
    for (const fact of document.viewerFacts) {
        const value = fact.previewValue ?? fact.defaultValue;
        if (value) facts.set(fact.id, value);
    }

    const context: ComposeContext = {
        document,
        item,
        theme,
        layout,
        messages,
        data,
        facts,
        diagnostics,
        fonts,
        viewer,
    };

    const nameRuns: PreviewRun[] = [
        {
            text: messages.lookup(item.presentation.nameMessage),
            kind: "TEXT",
            unbreakable: true,
            style: styleFor(context, "item-name"),
        },
    ];
    let nameLine = toPreviewLine(nameRuns, fonts);
    const semanticBlocks = item.presentation.blocks.flatMap((block) =>
        blockRuns(context, block),
    );
    let composed: FlowLine[];

    if (layout.kind === "flow") {
        let maximumWidth = Math.min(
            layout.maximumWidthPixels,
            theme.content?.maximumWidthPixels ?? layout.maximumWidthPixels,
        );
        if (theme.characterFrame) {
            maximumWidth = Math.min(
                maximumWidth,
                theme.characterFrame.maximumWidthPixels -
                    theme.characterFrame.leftPaddingPixels -
                    theme.characterFrame.rightPaddingPixels -
                    8,
            );
        }
        if (theme.segmentedFrame) {
            maximumWidth = Math.min(
                maximumWidth,
                theme.segmentedFrame.maximumWidthPixels -
                    theme.segmentedFrame.leftPaddingPixels -
                    theme.segmentedFrame.rightPaddingPixels -
                    8,
            );
        }
        const flow = composeFlow(context, semanticBlocks, maximumWidth);
        if (theme.renderer === "VANILLA_CHARACTER_FRAME") {
            composed = composeCharacterFrame(context, flow);
        } else if (theme.renderer === "SEGMENTED_FRAME") {
            const framed = composeSegmentedFrame(context, flow, nameLine);
            nameLine = framed.name;
            composed = framed.lines;
        } else {
            composed = [...flow.lines];
        }

        if (
            theme.renderer === "PLAIN" ||
            theme.renderer === "NATIVE_TOOLTIP_STYLE"
        ) {
            let widestLoreIndex = -1;
            composed.forEach((entry, index) => {
                if (
                    widestLoreIndex < 0 ||
                    entry.line.logicalWidthPixels >
                        composed[widestLoreIndex]!.line.logicalWidthPixels
                ) {
                    widestLoreIndex = index;
                }
            });
            const widestLore =
                widestLoreIndex < 0 ? null : composed[widestLoreIndex]!.line;
            const anchorName =
                widestLore === null ||
                nameLine.logicalWidthPixels >= widestLore.logicalWidthPixels;
            const anchor = anchorName ? nameLine : widestLore!;
            const deficit = flow.targetWidthPixels - anchor.logicalWidthPixels;
            if (deficit > 0) {
                const anchorStyle =
                    anchor.runs.at(-1)?.style ?? styleFor(context, "value");
                const anchored = toPreviewLine(
                    [
                        ...anchor.runs,
                        ...exactAdvanceRuns(
                            context,
                            deficit,
                            "WIDTH_ANCHOR",
                            anchorStyle,
                        ),
                    ],
                    fonts,
                );
                if (anchorName) nameLine = anchored;
                else {
                    composed[widestLoreIndex] = {
                        ...composed[widestLoreIndex]!,
                        line: anchored,
                    };
                }
            }
        }
    } else {
        const wrapping =
            layout.wrapping.body ?? Object.values(layout.wrapping)[0];
        const bodyLines: FlowLine[] = [];
        for (const block of semanticBlocks) {
            if (block.runs.length === 0) continue;
            const wrapped = wrapping
                ? wrapRuns(block.runs, fonts, {
                      widthPixels: layout.widthPixels,
                      maximumLines: wrapping.maximumLines,
                      overflow:
                          wrapping.overflow === "ERROR"
                              ? "ELLIPSIS"
                              : wrapping.overflow,
                      preserveExplicitLines: wrapping.preserveExplicitLines,
                      continuationIndentPixels:
                          wrapping.continuationIndentPixels,
                  })
                : [measureLine(block.runs, fonts, { lenient: true })];
            for (const line of wrapped) {
                bodyLines.push({
                    line: toPreviewLine(line.runs, fonts),
                    origin: block.origin,
                });
            }
        }
        composed = composeCanvas(context, bodyLines);
    }

    return {
        display: {
            displayName: nameLine,
            lore: composed.map((entry) => entry.line),
            // Only renderers that paint their own panel get their tooltip style honoured; for the
            // others vanilla's background is the panel. Mirrors ThemeRendererEngine.render.
            tooltipStyle:
                theme.renderer === "NATIVE_TOOLTIP_STYLE" ||
                theme.renderer === "SEGMENTED_FRAME" ||
                theme.renderer === "BITMAP_CANVAS"
                    ? theme.tooltipStyle
                    : null,
            renderer: theme.renderer,
            selectedTheme: theme.id,
            requestedTheme,
            catalogRevision: 0,
            fallbackReasons: reasons,
        },
        diagnostics,
        themeChain: chain,
        lineOrigins: composed.map((entry) => entry.origin),
    };
}

function emptyDisplay(itemId: string): PreviewDisplay {
    return {
        displayName: {
            runs: [],
            logicalWidthPixels: 0,
            visualBounds: { left: 0, right: 0, top: 0, bottom: 0 },
        },
        lore: [],
        tooltipStyle: null,
        renderer: "PLAIN",
        selectedTheme: itemId,
        requestedTheme: itemId,
        catalogRevision: 0,
        fallbackReasons: [],
    };
}

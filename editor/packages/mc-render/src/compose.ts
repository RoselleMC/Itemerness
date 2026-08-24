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
    if (!icon) return [];
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
        {
            text: " ",
            kind: "TEXT",
            unbreakable: false,
            style: styleFor(context, "value"),
        },
    ];
}

function blockRuns(
    context: ComposeContext,
    block: PresentationBlock,
): Array<{ runs: PreviewRun[]; origin: string }> {
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
            return [
                {
                    origin: block.uuid,
                    runs: [
                        ...iconRun(context, block.icon),
                        {
                            text: `${context.messages.lookup(block.labelMessage)} `,
                            kind: "TEXT",
                            unbreakable: false,
                            style: styleFor(context, "label"),
                        },
                        {
                            text: formatValue(
                                value,
                                format,
                                context.document.formats,
                                context.messages,
                            ),
                            kind: "TEXT",
                            unbreakable: true,
                            style: styleFor(context, block.style ?? "value"),
                        },
                    ],
                },
            ];
        }
        case "description":
            return [
                {
                    origin: block.uuid,
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
                    return {
                        origin: block.uuid,
                        runs: [
                            ...iconRun(context, block.template.icon),
                            {
                                text: `${context.messages.lookup(block.template.labelMessage)} `,
                                kind: "TEXT" as const,
                                unbreakable: false,
                                style: styleFor(context, "label"),
                            },
                            {
                                text,
                                kind: "TEXT" as const,
                                unbreakable: true,
                                style: styleFor(
                                    context,
                                    block.style ?? "value",
                                ),
                            },
                        ],
                    };
                });
        }
        case "nestedItemList": {
            return context.item.definition.contents.map((entry) => ({
                origin: block.uuid,
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
    };

    const maximumWidth =
        layout.kind === "flow"
            ? Math.min(
                  layout.maximumWidthPixels,
                  theme.content?.maximumWidthPixels ??
                      layout.maximumWidthPixels,
              )
            : layout.widthPixels;
    const wrapping = layout.wrapping.body ?? Object.values(layout.wrapping)[0];

    const nameRuns: PreviewRun[] = [
        {
            text: messages.lookup(item.presentation.nameMessage),
            kind: "TEXT",
            unbreakable: false,
            style: styleFor(context, "item-name"),
        },
    ];

    const bodyLines: Array<{ line: PreviewLine; origin: string | null }> = [];
    for (const block of item.presentation.blocks) {
        for (const { runs, origin } of blockRuns(context, block)) {
            if (runs.length === 0) continue;
            const measured = measureLine(runs, fonts, { lenient: true });
            if (measured.logicalWidthPixels <= maximumWidth || !wrapping) {
                bodyLines.push({ line: toPreviewLine(runs, fonts), origin });
                continue;
            }
            const wrapped = wrapRuns(runs, fonts, {
                widthPixels: maximumWidth,
                maximumLines: wrapping.maximumLines,
                overflow:
                    wrapping.overflow === "ERROR"
                        ? "ELLIPSIS"
                        : wrapping.overflow,
                preserveExplicitLines: wrapping.preserveExplicitLines,
                continuationIndentPixels: wrapping.continuationIndentPixels,
            });
            for (const line of wrapped)
                bodyLines.push({
                    line: toPreviewLine(line.runs, fonts),
                    origin,
                });
        }
    }

    const composed =
        theme.renderer === "BITMAP_CANVAS"
            ? composeCanvas(context, bodyLines)
            : bodyLines;

    return {
        display: {
            displayName: toPreviewLine(nameRuns, fonts),
            lore: composed.map((entry) => entry.line),
            tooltipStyle: theme.tooltipStyle,
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

import { itemKey, itemLayout, itemTheme } from "@itemerness/protocol";
import type {
    DataValue,
    DataTypeNode,
    Diagnostic,
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
import type { PresentationFonts } from "./fonts.js";
import { LayoutOverflowError, ellipsizeLine } from "./wrap.js";
import { LocalValueFormatter } from "./formatting.js";
import { LocalFormatError } from "./decimalFormat.js";
import {
    CanvasComposer,
    type CanvasBlock,
    type CanvasElementOrigin,
} from "./canvasLayout.js";
import { FlowComposer, lineOf as toPreviewLine, themeStyle } from "./flow.js";
import { SegmentedFrameComposer, usesDecoratedFrame } from "./segmentedFrame.js";

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
    /** Exact canvas content ownership; a baseline can contain several logical blocks. */
    readonly canvasElements?: readonly CanvasElementOrigin[];
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

    get effectiveLocale(): string {
        return this.document.locales.some(
            (entry) => entry.locale === this.locale,
        )
            ? this.locale
            : this.document.defaultLocale;
    }

    resolve(key: string): string | null {
        const seen = new Set<string>();
        // Match the compiler: unknown locales start at the default's full chain.
        let current: string | null = this.document.locales.some(
            (entry) => entry.locale === this.locale,
        )
            ? this.locale
            : this.document.defaultLocale;
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
        return null;
    }

    lookup(key: string): string {
        const message = this.resolve(key);
        if (message !== null) return message;
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

function valueToNumber(value: DataValue): number | null {
    if (value.kind === "integer" || value.kind === "decimal")
        return Number(value.value);
    return null;
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
    excluded: ReadonlySet<string> = new Set(),
): {
    theme: ThemeNode | null;
    chain: string[];
    reasons: PreviewDisplay["fallbackReasons"];
} {
    // The YAML loader reads only the selected renderer's frame geometry.
    const byId = new Map(
        document.themes.map((theme) => [
            theme.id,
            {
                ...theme,
                characterFrame:
                    theme.renderer === "VANILLA_CHARACTER_FRAME"
                        ? theme.characterFrame
                        : null,
                segmentedFrame:
                    theme.renderer === "SEGMENTED_FRAME"
                        ? theme.segmentedFrame
                        : null,
                canvas:
                    theme.renderer === "BITMAP_CANVAS" ? theme.canvas : null,
            },
        ]),
    );
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
        if (excluded.has(theme.id)) {
            reasons.push({
                theme: theme.id,
                code: "LAYOUT_OVERFLOW",
                detail: "local layout could not safely render this theme",
            });
            current = theme.fallback;
            continue;
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
    readonly formatter: LocalValueFormatter;
    readonly dataTypes: ReadonlyMap<string, DataTypeNode>;
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
    return themeStyle(context.theme, role, fontRole);
}

function iconRun(
    context: ComposeContext,
    icon: string | null,
    role = "value",
): PreviewRun[] {
    if (!icon || !context.theme.requiresResourcePack) return [];
    const glyph = context.document.glyphs.find((entry) => entry.id === icon);
    if (!glyph) {
        context.diagnostics.push(
            diagnostic(
                "ASSETS.ICON_UNDECLARED",
                "diagnostics.assets.icon_undeclared",
                { icon },
                "ERROR",
                itemKey(context.document, context.item),
            ),
        );
        return [];
    }
    return [
        {
            text: String.fromCodePoint(glyph.codePoint),
            kind: "ICON",
            unbreakable: true,
            style: {
                ...styleFor(context, role, "icons"),
                font: glyph.font,
                bold: false,
                italic: false,
            },
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
                        itemKey(context.document, context.item),
                    ),
                );
                return [];
            }
            return [
                {
                    origin: block.uuid,
                    runs: [
                        {
                            text: context.formatter.format(
                                value,
                                null,
                                context.dataTypes.get(block.data),
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
                        itemKey(context.document, context.item),
                    ),
                );
                return [];
            }
            return [
                {
                    origin: block.uuid,
                    runs: [
                        ...iconRun(context, block.icon, block.style ?? "value"),
                        {
                            text: `${context.messages.lookup(block.labelMessage)}: `,
                            kind: "TEXT",
                            unbreakable: true,
                            style: styleFor(context, block.style ?? "label"),
                        },
                        {
                            text: context.formatter.format(
                                value,
                                block.format,
                                context.dataTypes.get(block.data),
                            ),
                            kind: "TEXT",
                            unbreakable: false,
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
            return value.values
                .slice(0, block.maximumElements)
                .map((element) => {
                    let entry: DataValue | undefined = element;
                    const listType = context.dataTypes.get(block.data);
                    let entryType =
                        listType?.kind === "list"
                            ? listType.element
                            : undefined;
                    for (const segment of block.template.valuePath.split(".")) {
                        entry =
                            entry?.kind === "compound"
                                ? entry.entries[segment]
                                : undefined;
                        entryType =
                            entryType?.kind === "compound"
                                ? entryType.fields?.find(
                                      (field) => field.name === segment,
                                  )?.type
                                : undefined;
                    }
                    const text =
                        entry && entry.kind !== "null"
                            ? context.formatter.format(
                                  entry,
                                  block.template.format,
                                  entryType,
                              )
                            : context.formatter.requiredMessage(
                                  block.template.missingMessage,
                              );
                    return {
                        origin: block.uuid,
                        runs: [
                            ...iconRun(
                                context,
                                block.template.icon,
                                block.style ?? "value",
                            ),
                            {
                                text: `${context.messages.lookup(block.template.labelMessage)}: `,
                                kind: "TEXT" as const,
                                unbreakable: true,
                                style: styleFor(
                                    context,
                                    block.style ?? "label",
                                ),
                            },
                            {
                                text,
                                kind: "TEXT" as const,
                                unbreakable: false,
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
                        text: "\u2022 ",
                        kind: "TEXT" as const,
                        unbreakable: true,
                        style: styleFor(context, block.style ?? "label"),
                    },
                    {
                        text: (() => {
                            const nested = context.document.items.find(
                                (item) =>
                                    itemKey(context.document, item) ===
                                    entry.item,
                            );
                            return nested
                                ? context.messages.lookup(
                                      nested.presentation.nameMessage,
                                  )
                                : entry.item;
                        })(),
                        kind: "TEXT" as const,
                        unbreakable: false,
                        style: styleFor(context, block.style ?? "value"),
                    },
                    {
                        text: ` \u00d7${entry.amount}`,
                        kind: "TEXT" as const,
                        unbreakable: true,
                        style: styleFor(context, block.style ?? "value"),
                    },
                ],
            }));
        }
        default:
            return [];
    }
}

export interface ComposeOptions {
    readonly document: ProjectDocument;
    readonly itemId: string;
    readonly viewer: PreviewViewer;
    readonly fonts: PresentationFonts;
}

export function composeLocalPreview(options: ComposeOptions): LocalPreview {
    try {
        return composeAttempt(options, new Set());
    } catch (error) {
        if (!(error instanceof LocalFormatError)) throw error;
        return {
            display: emptyDisplay(options.itemId),
            themeChain: [],
            lineOrigins: [],
            diagnostics: [
                diagnostic(
                    error.unsupported
                        ? "FORMAT.UNSUPPORTED_LOCAL"
                        : "FORMAT.INVALID_VALUE",
                    error.unsupported
                        ? "diagnostics.format.unsupported_local"
                        : "diagnostics.format.invalid_value",
                    { detail: error.message },
                    "ERROR",
                    options.itemId,
                ),
            ],
        };
    }
}

function composeAttempt(
    options: ComposeOptions,
    excluded: ReadonlySet<string>,
): LocalPreview {
    const { document, viewer, fonts } = options;
    const diagnostics: Diagnostic[] = [];
    const item =
        document.items.find(
            (entry) => itemKey(document, entry) === options.itemId,
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

    const requestedTheme =
        viewer.requestedTheme ?? itemTheme(document, item) ?? "";
    const { theme, chain, reasons } = resolveTheme(
        document,
        requestedTheme,
        viewer,
        excluded,
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
                    itemKey(document, item),
                ),
            ],
            themeChain: chain,
            lineOrigins: [],
        };
    }
    const layout = document.layouts.find(
        (entry) => entry.id === itemLayout(document, item),
    );
    if (!layout) {
        return {
            display: emptyDisplay(options.itemId),
            diagnostics: [
                diagnostic(
                    "LAYOUT.UNKNOWN",
                    "diagnostics.layout.unknown",
                    { layout: itemLayout(document, item) ?? "" },
                    "ERROR",
                    itemKey(document, item),
                ),
            ],
            themeChain: chain,
            lineOrigins: [],
        };
    }

    const messages = new MessageCatalog(document, viewer.locale, diagnostics);
    const formatter = new LocalValueFormatter(document.formats, messages);
    const dataTypes = new Map<string, DataTypeNode>();
    const data = new Map<string, DataValue>();
    for (const reference of item.definition.instance.schemas) {
        const schema = document.dataSchemas.find(
            (entry) =>
                entry.id === reference.id &&
                entry.version === reference.version,
        );
        for (const key of schema?.keys ?? []) {
            dataTypes.set(key.id, key.type);
            if (key.defaultValue !== null) data.set(key.id, key.defaultValue);
        }
    }
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
        formatter,
        dataTypes,
        data,
        facts,
        diagnostics,
        fonts,
    };

    const maximumWidth = Math.min(
        layout.maximumWidthPixels,
        theme.content?.maximumWidthPixels ?? layout.maximumWidthPixels,
        theme.characterFrame?.maximumWidthPixels ?? layout.maximumWidthPixels,
        theme.segmentedFrame?.maximumWidthPixels ?? layout.maximumWidthPixels,
        theme.canvas?.maximumWidthPixels ?? layout.maximumWidthPixels,
        document.budgets.maximumWidthPixels,
    );

    const nameRuns: PreviewRun[] = [
        {
            text: messages.lookup(item.presentation.nameMessage),
            kind: "TEXT",
            unbreakable: true,
            style: styleFor(context, "item-name"),
        },
    ];

    const sources = new Map<string, PresentationBlock>();
    const collect = (blocks: readonly PresentationBlock[]) =>
        blocks.forEach((block) => {
            sources.set(block.uuid, block);
            if (block.type === "conditional") {
                collect(block.thenBlocks);
                collect(block.otherwiseBlocks);
            }
        });
    collect(item.presentation.blocks);
    const blocks: CanvasBlock[] = item.presentation.blocks
        .flatMap((block) => blockRuns(context, block))
        .map(({ runs, origin }) => {
            const source = sources.get(origin)!;
            const field = source.type === "field" || source.type === "repeat";
            return {
                runs,
                origin,
                kind: field
                    ? "field"
                    : source.type === "description"
                      ? "description"
                      : "generic",
                wrapping: "wrapping" in source ? source.wrapping : null,
                anchor: source.anchor,
                fieldValueIndex: field ? runs.length - 1 : null,
            };
        });
    let name = toPreviewLine(
        ellipsizeLine(nameRuns, fonts, maximumWidth).runs,
        fonts,
    );
    let composed: Array<{ line: PreviewLine; origin: string | null }>;
    let canvasElements: readonly CanvasElementOrigin[] | undefined;
    try {
        if (theme.renderer === "BITMAP_CANVAS") {
            const canvas = new CanvasComposer(
                document,
                theme,
                layout,
                fonts,
            ).compose(blocks, name);
            composed = canvas.lines;
            canvasElements = canvas.elements;
        } else {
            const engine = new FlowComposer(document, theme, layout, fonts);
            const frame =
                theme.renderer === "VANILLA_CHARACTER_FRAME"
                    ? theme.characterFrame
                    : theme.renderer === "SEGMENTED_FRAME"
                      ? theme.segmentedFrame
                      : null;
            const available = frame
                ? frame.maximumWidthPixels -
                  frame.leftPaddingPixels -
                  frame.rightPaddingPixels -
                  8
                : maximumWidth;
            if (theme.renderer === "SEGMENTED_FRAME" && theme.segmentedFrame && usesDecoratedFrame(theme.segmentedFrame)) {
                const framed = new SegmentedFrameComposer(document, theme, fonts).compose((maximum) => engine.flow(blocks, maximum), name);
                name = framed.name;
                composed = framed.lines;
            } else {
                const flow = engine.flow(blocks, available);
                if (theme.renderer === "VANILLA_CHARACTER_FRAME")
                    composed = engine.characterFrame(flow);
                else if (theme.renderer === "SEGMENTED_FRAME")
                    composed = engine.segmentedFrame(flow);
                else {
                    const anchored = engine.anchorFlow(name, flow);
                    name = anchored.name;
                    composed = anchored.lines;
                }
            }
        }
    } catch (error) {
        if (!(error instanceof LayoutOverflowError)) throw error;
        return composeAttempt(options, new Set([...excluded, theme.id]));
    }

    return {
        display: {
            displayName: name,
            lore: composed.map((entry) => entry.line),
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
        ...(canvasElements ? { canvasElements } : {}),
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

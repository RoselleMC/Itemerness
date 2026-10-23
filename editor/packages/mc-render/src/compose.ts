import { itemKey, itemLayout, itemTheme } from "@itemerness/protocol";
import type {
    DataValue,
    DataTypeNode,
    Diagnostic,
    FieldPartStyles,
    FieldSeparator,
    Fragment,
    GroupDividers,
    GroupMarker,
    HidingWeight,
    ItemNode,
    LayoutNode,
    PresentationBlock,
    PresentationCondition,
    PreviewDisplay,
    PreviewLine,
    PreviewRun,
    PreviewViewer,
    ProjectDocument,
    Summary,
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
import {
    FlowComposer,
    lineOf as toPreviewLine,
    themeStyle,
    type MarkerPiece,
} from "./flow.js";
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

type ConditionReference = PresentationCondition["left"];

function resolveReference(
    reference: ConditionReference,
    data: ReadonlyMap<string, DataValue>,
    facts: ReadonlyMap<string, DataValue>,
): DataValue | null {
    if (reference.kind === "data") return data.get(reference.key) ?? null;
    if (reference.kind === "fact") return facts.get(reference.key) ?? null;
    return reference.value;
}

/** The one local condition evaluation, shared by conditional blocks and theme selectors. */
export function conditionHolds(
    condition: PresentationCondition,
    data: ReadonlyMap<string, DataValue>,
    facts: ReadonlyMap<string, DataValue>,
): boolean {
    return compare(
        condition.operator,
        resolveReference(condition.left, data, facts),
        condition.right ? resolveReference(condition.right, data, facts) : null,
    );
}

/**
 * Resolves a theme binding to the concrete theme that starts the fallback chain, exactly like
 * the compiler: a selector picks its first matching case, otherwise its default theme. Any
 * other id is returned unchanged.
 */
export function selectTheme(
    document: Pick<ProjectDocument, "themeSelectors">,
    id: string,
    data: ReadonlyMap<string, DataValue>,
    facts: ReadonlyMap<string, DataValue>,
): string {
    const selector = document.themeSelectors?.find((entry) => entry.id === id);
    if (!selector) return id;
    return (
        selector.cases.find((entry) =>
            conditionHolds(entry.condition, data, facts),
        )?.theme ?? selector.defaultTheme
    );
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
    readonly hiding: HidingState;
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

/** The text between a label and its value: block, then layout, then the original colon. */
function separatorText(
    context: ComposeContext,
    separator: FieldSeparator | undefined,
): string {
    const effective =
        separator ??
        (context.layout.kind === "flow"
            ? context.layout.fieldSeparator
            : undefined);
    if (!effective) return ": ";
    if (effective.kind === "none") return "";
    return context.messages.lookup(effective.message);
}

/** A resolved run before theme styling, mirroring the compiler's semantic run. */
interface SemanticRun {
    text: string;
    role: string;
    unbreakable: boolean;
    /** A resource-pack glyph; dropped by themes without a pack. */
    glyph?: string;
}

/** Hiding state for one resolution pass, mirroring the compiler's resolution. */
interface HidingState {
    readonly excluded: ReadonlySet<string>;
    readonly slotEntries: ReadonlyMap<string, SemanticRun[][]>;
    readonly rows: RowRecord[];
    readonly summaries: Array<{ slot: string; order: number; runs: SemanticRun[] }>;
    order: number;
}

interface RowRecord {
    id: string;
    weight: HidingWeight | undefined;
    hostsSlot: boolean;
}

/** Whether the row at `path` is hidden; a hidden row leaves its summary in document order. */
function hide(
    context: ComposeContext,
    path: string,
    summary: Summary | undefined,
    runs: (summary: Summary) => SemanticRun[],
): boolean {
    const hiding = context.hiding;
    const position = hiding.order++;
    if (!hiding.excluded.has(path)) return false;
    if (summary) {
        const pieces = runs(summary);
        if (pieces.length)
            hiding.summaries.push({ slot: summary.slot, order: position, runs: pieces });
    }
    return true;
}

function styleSemantic(
    context: ComposeContext,
    run: SemanticRun,
    kind: PreviewRun["kind"] = "TEXT",
): PreviewRun[] {
    if (run.glyph === undefined)
        return [
            {
                text: run.text,
                kind,
                unbreakable: run.unbreakable,
                style: styleFor(context, run.role),
            },
        ];
    if (!context.theme.requiresResourcePack) return [];
    const glyph = context.document.glyphs.find((entry) => entry.id === run.glyph);
    if (!glyph) {
        context.diagnostics.push(
            diagnostic(
                "ASSETS.ICON_UNDECLARED",
                "diagnostics.assets.icon_undeclared",
                { icon: run.glyph },
                "ERROR",
                itemKey(context.document, context.item),
            ),
        );
        return [];
    }
    return [
        {
            text: String.fromCodePoint(glyph.codePoint),
            kind,
            unbreakable: true,
            style: {
                ...styleFor(context, run.role),
                font: glyph.font,
                bold: false,
                italic: false,
            },
        },
    ];
}

function styleAll(context: ComposeContext, runs: readonly SemanticRun[]): PreviewRun[] {
    return runs.flatMap((run) => styleSemantic(context, run));
}

/**
 * Resolves inline fragments in order. A fragment whose condition is false or whose data is
 * absent is omitted; `role` is the enclosing block's style, used when a fragment has none.
 */
function resolveFragments(
    context: ComposeContext,
    fragments: readonly Fragment[] | undefined,
    role: string | null | undefined,
): SemanticRun[] {
    const output: SemanticRun[] = [];
    for (const fragment of fragments ?? []) {
        if (
            fragment.condition &&
            !conditionHolds(fragment.condition, context.data, context.facts)
        )
            continue;
        switch (fragment.kind) {
            case "message":
                output.push({
                    text: context.messages.lookup(fragment.message),
                    role: fragment.style ?? role ?? "label",
                    unbreakable: false,
                });
                break;
            case "data": {
                const value = context.data.get(fragment.data);
                if (!value || value.kind === "null") break;
                output.push({
                    text: context.formatter.format(
                        value,
                        fragment.format ?? null,
                        context.dataTypes.get(fragment.data),
                    ),
                    role: fragment.style ?? role ?? "value",
                    unbreakable: false,
                });
                break;
            }
            case "glyph":
                output.push({
                    text: "",
                    role: fragment.style ?? role ?? "value",
                    unbreakable: true,
                    glyph: fragment.glyph,
                });
                break;
            case "literal":
                output.push({
                    text: fragment.text,
                    role: fragment.style ?? role ?? "label",
                    unbreakable: true,
                });
                break;
            case "slot":
                output.push(...slotRuns(context, fragment, role));
                break;
        }
    }
    return output;
}

/** A slot's entries with its decorations, or nothing when no hidden block named it. */
function slotRuns(
    context: ComposeContext,
    slot: Extract<Fragment, { kind: "slot" }>,
    role: string | null | undefined,
): SemanticRun[] {
    const entries = context.hiding.slotEntries.get(slot.id) ?? [];
    if (!entries.length) return [];
    const slotRole = slot.style ?? role ?? "label";
    const decoration = (piece: Fragment | undefined) =>
        piece ? resolveFragments(context, [piece], slotRole) : [];
    const shown =
        slot.maximumEntries === undefined
            ? entries
            : entries.slice(0, slot.maximumEntries);
    const remaining = entries.length - shown.length;
    const separator = decoration(slot.separator);
    const runs: SemanticRun[] = [...decoration(slot.prefix)];
    shown.forEach((entry, index) => {
        if (index > 0) runs.push(...separator);
        runs.push(...entry);
    });
    if (remaining > 0 && slot.overflowCountMessage !== undefined) {
        if (shown.length) runs.push(...separator);
        runs.push({
            text: context.messages
                .lookup(slot.overflowCountMessage)
                .replace(/\{count\}/g, String(remaining)),
            role: slotRole,
            unbreakable: true,
        });
    }
    runs.push(...decoration(slot.suffix));
    return runs;
}

function staticSummaryRuns(context: ComposeContext, summary: Summary): SemanticRun[] {
    return resolveFragments(
        context,
        summary.piece ? [summary.piece] : [],
        summary.style,
    );
}

/** A compound element's nested value and its schema type. */
function lookupElement(
    element: DataValue,
    path: string,
    listType: DataTypeNode | undefined,
): { value: DataValue | undefined; type: DataTypeNode | undefined } {
    let value: DataValue | undefined = element;
    let type = listType?.kind === "list" ? listType.element : undefined;
    for (const segment of path.split(".")) {
        value = value?.kind === "compound" ? value.entries[segment] : undefined;
        type =
            type?.kind === "compound"
                ? type.fields?.find((field) => field.name === segment)?.type
                : undefined;
    }
    return { value: value && value.kind !== "null" ? value : undefined, type };
}

function hostsSlot(block: PresentationBlock): boolean {
    if (block.type === "row")
        return [...block.left, ...block.right].some((entry) => entry.kind === "slot");
    if (block.type === "rule")
        return block.title.some((entry) => entry.kind === "slot");
    return false;
}

/** Label, separator and value runs shared by fields and repeat templates. */
function fieldRuns(
    context: ComposeContext,
    icon: string | null,
    label: string,
    separator: FieldSeparator | undefined,
    formatted: string,
    role: string | null,
    parts: FieldPartStyles | undefined,
): PreviewRun[] {
    const separatorValue = separatorText(context, separator);
    const labelRole = parts?.label ?? role ?? "label";
    const separatorRole = parts?.separator ?? role ?? "label";
    const text = (value: string, partRole: string, unbreakable = true): PreviewRun => ({
        text: value,
        kind: "TEXT",
        unbreakable,
        style: styleFor(context, partRole),
    });
    return [
        ...iconRun(context, icon, parts?.icon ?? role ?? "value"),
        ...(separatorValue && separatorRole !== labelRole
            ? [text(label, labelRole), text(separatorValue, separatorRole)]
            : [text(`${label}${separatorValue}`, labelRole)]),
        text(formatted, parts?.value ?? role ?? "value", false),
    ];
}

interface ResolvedEntry {
    runs: PreviewRun[];
    right?: PreviewRun[];
    origin: string;
    path: string;
}

/** A single-row block, or null when its data is absent and the block may be omitted. */
function leafRuns(
    context: ComposeContext,
    block: PresentationBlock,
    path: string,
): ResolvedEntry | null {
    switch (block.type) {
        case "text":
        case "field": {
            const value = context.data.get(block.data);
            if (!value || value.kind === "null") {
                if (block.missingPolicy === "OMIT") return null;
                context.diagnostics.push(
                    diagnostic(
                        "DATA.MISSING",
                        "diagnostics.data.missing",
                        { key: block.data },
                        "ERROR",
                        itemKey(context.document, context.item),
                    ),
                );
                return null;
            }
            if (block.type === "text")
                return {
                    origin: block.uuid,
                    path,
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
                };
            return {
                origin: block.uuid,
                path,
                runs: fieldRuns(
                    context,
                    block.icon,
                    context.messages.lookup(block.labelMessage),
                    block.separator,
                    context.formatter.format(
                        value,
                        block.format,
                        context.dataTypes.get(block.data),
                    ),
                    block.style,
                    block.partStyles,
                ),
            };
        }
        case "description":
            return {
                origin: block.uuid,
                path,
                runs: [
                    {
                        text: context.messages.lookup(block.message),
                        kind: "TEXT",
                        unbreakable: false,
                        style: styleFor(context, block.style ?? "description"),
                    },
                ],
            };
        case "row": {
            const left = resolveFragments(context, block.left, block.style);
            const right = resolveFragments(context, block.right, block.style);
            if (!left.length && !right.length) return null;
            // A leading glyph is the row's icon: it takes the layout's icon slot and gap like a field icon.
            const [first, ...rest] = left;
            const leftRuns =
                first?.glyph !== undefined
                    ? [...styleSemantic(context, first, "ICON"), ...styleAll(context, rest)]
                    : styleAll(context, left);
            return {
                origin: block.uuid,
                path,
                runs: leftRuns,
                right: styleAll(context, right),
            };
        }
        case "rule":
            return {
                origin: block.uuid,
                path,
                runs: styleAll(context, resolveFragments(context, block.title, block.style)),
            };
        default:
            return null;
    }
}

/** Resolves a single-row block unless it is hidden, recording it as a hiding candidate. */
function resolveRow(
    context: ComposeContext,
    block: PresentationBlock,
    path: string,
    weight: HidingWeight | undefined,
): ResolvedEntry | null {
    if (hide(context, path, block.summary, (summary) => staticSummaryRuns(context, summary)))
        return null;
    const entry = leafRuns(context, block, path);
    if (!entry) return null;
    context.hiding.rows.push({ id: path, weight, hostsSlot: hostsSlot(block) });
    return entry;
}

/** A rendered row with the decoration its containers give it, mirroring the compiler. */
interface ResolvedRow extends ResolvedEntry {
    boundaryBefore: boolean;
    firstPrefix: MarkerPiece[];
    continuationPrefix: MarkerPiece[];
    gapPrefix: MarkerPiece[];
    gapBeforeLines: number;
}

/** A leaf row, one repeat element, one nested item, or a whole child group. */
interface ResolvedUnit {
    rows: ResolvedRow[];
    gapBeforeLines: number;
}

function leafRow(entry: ResolvedEntry): ResolvedRow {
    return {
        ...entry,
        boundaryBefore: false,
        firstPrefix: [],
        continuationPrefix: [],
        gapPrefix: [],
        gapBeforeLines: 0,
    };
}

function collectUnits(
    context: ComposeContext,
    blocks: readonly PresentationBlock[],
    containerMarker: GroupMarker,
    units: ResolvedUnit[],
    path: string,
    inherited: HidingWeight | undefined,
): void {
    blocks.forEach((block, index) => {
        const blockPath = `${path}[${index}]`;
        const weight = block.weight ?? inherited;
        switch (block.type) {
            case "conditional": {
                // Transparent: the selected branch's blocks are units of this container.
                const matched = conditionHolds(
                    block.condition,
                    context.data,
                    context.facts,
                );
                collectUnits(
                    context,
                    matched ? block.thenBlocks : block.otherwiseBlocks,
                    containerMarker,
                    units,
                    `${blockPath}.${matched ? "then" : "otherwise"}`,
                    weight,
                );
                return;
            }
            case "group": {
                const rows = resolveGroup(context, block, blockPath, weight);
                if (rows) units.push({ rows, gapBeforeLines: block.gapBeforeLines ?? 0 });
                return;
            }
            case "repeat": {
                const value = context.data.get(block.data);
                if (!value || value.kind !== "list") return;
                const listType = context.dataTypes.get(block.data);
                value.values.slice(0, block.maximumElements).forEach((element, elementIndex) => {
                    const elementPath = `${blockPath}[#${elementIndex}]`;
                    if (
                        hide(context, elementPath, block.summary, (summary) => {
                            if (summary.valuePath === undefined)
                                return staticSummaryRuns(context, summary);
                            const nested = lookupElement(element, summary.valuePath, listType);
                            if (!nested.value) return [];
                            return [
                                {
                                    text: context.formatter.format(
                                        nested.value,
                                        summary.format ?? null,
                                        nested.type,
                                    ),
                                    role: summary.style ?? "label",
                                    unbreakable: true,
                                },
                            ];
                        })
                    )
                        return;
                    const entry = lookupElement(element, block.template.valuePath, listType);
                    const text = entry.value
                        ? context.formatter.format(entry.value, block.template.format, entry.type)
                        : context.formatter.requiredMessage(block.template.missingMessage);
                    context.hiding.rows.push({ id: elementPath, weight, hostsSlot: false });
                    units.push({
                        rows: [
                            leafRow({
                                origin: block.uuid,
                                path: elementPath,
                                runs: fieldRuns(
                                    context,
                                    block.template.icon,
                                    context.messages.lookup(block.template.labelMessage),
                                    block.template.separator,
                                    text,
                                    block.style,
                                    block.template.partStyles,
                                ),
                            }),
                        ],
                        gapBeforeLines: 0,
                    });
                });
                return;
            }
            case "nestedItemList": {
                context.item.definition.contents.forEach((entry, elementIndex) => {
                    const elementPath = `${blockPath}[#${elementIndex}]`;
                    if (
                        hide(context, elementPath, block.summary, (summary) =>
                            staticSummaryRuns(context, summary),
                        )
                    )
                        return;
                    context.hiding.rows.push({ id: elementPath, weight, hostsSlot: false });
                    const nested = context.document.items.find(
                        (item) => itemKey(context.document, item) === entry.item,
                    );
                    const value = styleFor(context, block.style ?? "value");
                    units.push({
                        rows: [
                            leafRow({
                                origin: block.uuid,
                                path: elementPath,
                                runs: [
                                    // A decorated container's marker replaces the built-in bullet.
                                    ...(containerMarker === "NONE"
                                        ? [
                                              {
                                                  text: "• ",
                                                  kind: "TEXT" as const,
                                                  unbreakable: true,
                                                  style: styleFor(context, block.style ?? "label"),
                                              },
                                          ]
                                        : []),
                                    {
                                        text: nested
                                            ? context.messages.lookup(nested.presentation.nameMessage)
                                            : entry.item,
                                        kind: "TEXT" as const,
                                        unbreakable: false,
                                        style: value,
                                    },
                                    {
                                        text: ` ×${entry.amount}`,
                                        kind: "TEXT" as const,
                                        unbreakable: true,
                                        style: styleFor(context, block.style ?? "value"),
                                    },
                                ],
                            }),
                        ],
                        gapBeforeLines: 0,
                    });
                });
                return;
            }
            default: {
                const entry = resolveRow(context, block, blockPath, weight);
                if (entry) units.push({ rows: [leafRow(entry)], gapBeforeLines: 0 });
            }
        }
    });
}

function resolveGroup(
    context: ComposeContext,
    group: Extract<PresentationBlock, { type: "group" }>,
    path: string,
    weight: HidingWeight | undefined,
): ResolvedRow[] | null {
    const header = group.header
        ? resolveRow(
              context,
              group.header,
              `${path}.header`,
              group.header.weight ?? weight,
          )
        : null;
    if (group.header && !header && (group.whenHeaderMissing ?? "HIDE") === "HIDE")
        return null;
    const children = resolveContainer(
        context,
        group.children,
        group.marker ?? "NONE",
        group.dividers ?? "NONE",
        `${path}.children`,
        weight,
    );
    if (children.length)
        return [...(header ? [leafRow(header)] : []), ...children];
    if (!header || (group.whenEmpty ?? "SHOW_HEADER") === "HIDE") return null;
    return [leafRow(header)];
}

/** Resolves every unit before decorating, because a connector depends on later siblings. */
function resolveContainer(
    context: ComposeContext,
    blocks: readonly PresentationBlock[],
    marker: GroupMarker,
    dividers: GroupDividers,
    path: string,
    inherited: HidingWeight | undefined,
): ResolvedRow[] {
    const units: ResolvedUnit[] = [];
    collectUnits(context, blocks, marker, units, path, inherited);
    const output: ResolvedRow[] = [];
    units.forEach((unit, unitIndex) => {
        const last = unitIndex === units.length - 1;
        const lead: MarkerPiece | null =
            marker === "BULLET"
                ? "BULLET"
                : marker === "TREE"
                  ? last
                      ? "TREE_LAST"
                      : "TREE_BRANCH"
                  : null;
        const continuation: MarkerPiece | null =
            marker === "BULLET"
                ? "BULLET_BLANK"
                : marker === "TREE"
                  ? last
                      ? "TREE_BLANK"
                      : "TREE_VERTICAL"
                  : null;
        const above: MarkerPiece | null =
            marker === "BULLET"
                ? "BULLET_BLANK"
                : marker === "TREE"
                  ? unitIndex === 0
                      ? "TREE_BLANK"
                      : "TREE_VERTICAL"
                  : null;
        const own = (piece: MarkerPiece | null) => (piece ? [piece] : []);
        unit.rows.forEach((row, rowIndex) => {
            if (rowIndex === 0)
                output.push({
                    ...row,
                    boundaryBefore:
                        unitIndex > 0 && dividers === "BETWEEN_CHILDREN",
                    gapBeforeLines:
                        row.gapBeforeLines +
                        (unitIndex > 0 ? unit.gapBeforeLines : 0),
                    firstPrefix: [...own(lead), ...row.firstPrefix],
                    continuationPrefix: [
                        ...own(continuation),
                        ...row.continuationPrefix,
                    ],
                    gapPrefix: [...own(above), ...row.gapPrefix],
                });
            else
                output.push({
                    ...row,
                    firstPrefix: [...own(continuation), ...row.firstPrefix],
                    continuationPrefix: [
                        ...own(continuation),
                        ...row.continuationPrefix,
                    ],
                    gapPrefix: [...own(continuation), ...row.gapPrefix],
                });
        });
    });
    return output;
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

    const { data, dataTypes } = previewData(document, item);
    const facts = previewFacts(document);
    // A viewer override outranks the item binding; either may name a selector.
    const requestedTheme = selectTheme(
        document,
        viewer.requestedTheme ?? itemTheme(document, item) ?? "",
        data,
        facts,
    );
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

    const sources = new Map<string, PresentationBlock>();
    const collect = (blocks: readonly PresentationBlock[]) =>
        blocks.forEach((block) => {
            sources.set(block.uuid, block);
            if (block.type === "conditional") {
                collect(block.thenBlocks);
                collect(block.otherwiseBlocks);
            }
            if (block.type === "group") {
                if (block.header) collect([block.header]);
                collect(block.children);
            }
        });
    collect(item.presentation.blocks);

    /** One resolution pass; `hidden` rows leave their summaries in the slots they name. */
    const resolvePass = (
        hidden: ReadonlySet<string>,
        slotEntries: ReadonlyMap<string, SemanticRun[][]>,
    ) => {
        const passDiagnostics: Diagnostic[] = [];
        const messages = new MessageCatalog(document, viewer.locale, passDiagnostics);
        const context: ComposeContext = {
            document,
            item,
            theme,
            layout,
            messages,
            formatter: new LocalValueFormatter(document.formats, messages),
            dataTypes,
            data,
            facts,
            diagnostics: passDiagnostics,
            fonts,
            hiding: {
                excluded: hidden,
                slotEntries,
                rows: [],
                summaries: [],
                order: 0,
            },
        };
        const name = styleAll(context, [
            ...resolveFragments(context, item.presentation.nameBefore, "item-name"),
            {
                text: messages.lookup(item.presentation.nameMessage),
                role: "item-name",
                unbreakable: true,
            },
            ...resolveFragments(context, item.presentation.nameAfter, "item-name"),
        ]);
        const blocks: CanvasBlock[] = resolveContainer(
            context,
            item.presentation.blocks,
            item.presentation.marker ?? "NONE",
            item.presentation.dividers ?? "BETWEEN_CHILDREN",
            "blocks",
            undefined,
        ).map((row) => {
            const source = sources.get(row.origin)!;
            const field = source.type === "field" || source.type === "repeat";
            return {
                runs: row.runs,
                ...(row.right ? { right: row.right } : {}),
                origin: row.origin,
                boundaryBefore: row.boundaryBefore,
                firstPrefix: row.firstPrefix,
                continuationPrefix: row.continuationPrefix,
                gapPrefix: row.gapPrefix,
                gapBeforeLines: row.gapBeforeLines,
                kind: field
                    ? "field"
                    : source.type === "description"
                      ? "description"
                      : source.type === "row" || source.type === "rule"
                        ? source.type
                        : "generic",
                wrapping: "wrapping" in source ? (source.wrapping ?? null) : null,
                anchor: source.anchor,
                fieldValueIndex: field ? row.runs.length - 1 : null,
            };
        });
        return { name, blocks, context, diagnostics: passDiagnostics };
    };
    /** Summaries are static, so one collecting pass followed by the real pass is always enough. */
    const resolveSemantic = (hidden: ReadonlySet<string>) => {
        const first = resolvePass(hidden, new Map());
        const summaries = first.context.hiding.summaries;
        if (!hidden.size || !summaries.length) return first;
        const entries = new Map<string, SemanticRun[][]>();
        [...summaries]
            .sort((left, right) => left.order - right.order)
            .forEach((summary) =>
                entries.set(summary.slot, [...(entries.get(summary.slot) ?? []), summary.runs]),
            );
        return resolvePass(hidden, entries);
    };

    const maximumWidth = Math.min(
        layout.maximumWidthPixels,
        theme.content?.maximumWidthPixels ?? layout.maximumWidthPixels,
        theme.characterFrame?.maximumWidthPixels ?? layout.maximumWidthPixels,
        theme.segmentedFrame?.maximumWidthPixels ?? layout.maximumWidthPixels,
        theme.canvas?.maximumWidthPixels ?? layout.maximumWidthPixels,
        document.budgets.maximumWidthPixels,
    );

    const render = (resolved: ReturnType<typeof resolveSemantic>) => {
        const engine = new FlowComposer(document, theme, layout, fonts);
        const inset = theme.nameInsetPixels ?? 0;
        if (maximumWidth - 2 * inset <= 0)
            throw new LayoutOverflowError("The name inset consumes the maximum width");
        let name = toPreviewLine(
            ellipsizeLine(resolved.name, fonts, maximumWidth - 2 * inset).runs,
            fonts,
        );
        if (inset > 0) {
            const nameStyle = themeStyle(theme, "item-name");
            name = toPreviewLine(
                [
                    ...engine.exactPadding(inset, nameStyle),
                    ...name.runs,
                    ...engine.exactPadding(inset, nameStyle),
                ],
                fonts,
            );
        }
        const blocks = resolved.blocks;
        let composed: Array<{ line: PreviewLine; origin: string | null }>;
        let canvasElements: readonly CanvasElementOrigin[] | undefined;
        if (theme.renderer === "BITMAP_CANVAS") {
            const canvas = new CanvasComposer(document, theme, layout, fonts).compose(
                blocks,
                name,
            );
            composed = canvas.lines;
            canvasElements = canvas.elements;
        } else {
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
            if (
                theme.renderer === "SEGMENTED_FRAME" &&
                theme.segmentedFrame &&
                usesDecoratedFrame(theme.segmentedFrame)
            ) {
                const framed = new SegmentedFrameComposer(document, theme, fonts).compose(
                    (maximum) => engine.flow(blocks, maximum),
                    name,
                );
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
        validateDisplay(document, name, composed.map((entry) => entry.line));
        return { name, composed, canvasElements };
    };

    const overflow =
        item.presentation.overflow ??
        (layout.kind === "flow" ? layout.overflow : undefined) ??
        "FALLBACK";
    let resolved = resolveSemantic(new Set());
    let hidden: string[] = [];
    let output: ReturnType<typeof render> | undefined;
    try {
        output = render(resolved);
    } catch (error) {
        if (!(error instanceof LayoutOverflowError)) throw error;
        if (!error.capacity || overflow !== "HIDE")
            return composeAttempt(options, new Set([...excluded, theme.id]));
        // The order depends only on the complete presentation, so the search always ends.
        const order = hidingOrder(resolved.context.hiding.rows);
        for (let count = 1; count <= Math.min(order.length, MAXIMUM_HIDING_STEPS); count++) {
            const attempt = resolveSemantic(new Set(order.slice(0, count)));
            try {
                output = render(attempt);
                resolved = attempt;
                hidden = order.slice(0, count);
                break;
            } catch (retry) {
                if (!(retry instanceof LayoutOverflowError)) throw retry;
                if (!retry.capacity)
                    return composeAttempt(options, new Set([...excluded, theme.id]));
            }
        }
        if (!output) return composeAttempt(options, new Set([...excluded, theme.id]));
    }

    return {
        display: {
            displayName: output.name,
            lore: output.composed.map((entry) => entry.line),
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
            hiddenElements: hidden,
        },
        diagnostics: [...diagnostics, ...resolved.diagnostics],
        themeChain: chain,
        lineOrigins: output.composed.map((entry) => entry.origin),
        ...(output.canvasElements ? { canvasElements: output.canvasElements } : {}),
    };
}

/** Each hiding step re-resolves and re-renders, so the search stays bounded. */
const MAXIMUM_HIDING_STEPS = 64;

/** Slot hosts last, unweighted rows after weighted ones, then lowest weight and latest row first. */
function hidingOrder(rows: readonly RowRecord[]): string[] {
    return rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.weight !== "never")
        .sort(
            (left, right) =>
                Number(left.row.hostsSlot) - Number(right.row.hostsSlot) ||
                Number(left.row.weight === undefined) -
                    Number(right.row.weight === undefined) ||
                ((left.row.weight as number | undefined) ?? 0) -
                    ((right.row.weight as number | undefined) ?? 0) ||
                right.index - left.index,
        )
        .map(({ row }) => row.id);
}

/** The compiler's output budgets; line-count and height overflows can be resolved by hiding. */
function validateDisplay(
    document: ProjectDocument,
    name: PreviewLine,
    lore: readonly PreviewLine[],
): void {
    const budgets = document.budgets;
    if (lore.length > budgets.maximumLines)
        throw new LayoutOverflowError("Lore line budget exceeded", { capacity: true });
    const all = [name, ...lore];
    const runs = all.flatMap((line) => line.runs);
    if (
        all.some(
            (line) =>
                line.logicalWidthPixels > budgets.maximumWidthPixels ||
                line.visualBounds.right - line.visualBounds.left >
                    budgets.maximumWidthPixels ||
                line.runs.length > 256 ||
                line.runs.reduce((sum, run) => sum + run.text.length, 0) > 8192,
        ) ||
        runs.length > Math.min(budgets.maximumRuns, 4096) ||
        runs.reduce((sum, run) => sum + [...run.text].length, 0) >
            budgets.maximumTextCodePoints ||
        runs.reduce((sum, run) => sum + run.text.length, 0) > 131072
    )
        throw new LayoutOverflowError("Display exceeds its output budget");
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
        Math.max(structural, Number.isFinite(top) ? Math.ceil(bottom - top) : 0) >
        budgets.maximumHeightPixels
    )
        throw new LayoutOverflowError("Display height budget exceeded", {
            capacity: true,
        });
}

/** The item data a local preview reads: schema and instance defaults, definition and preview data. */
function previewData(
    document: ProjectDocument,
    item: ItemNode,
): { data: Map<string, DataValue>; dataTypes: Map<string, DataTypeNode> } {
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
    return { data, dataTypes };
}

/** Persona preview values, falling back to each fact's declared default like the compiler. */
function previewFacts(document: ProjectDocument): Map<string, DataValue> {
    const facts = new Map<string, DataValue>();
    for (const fact of document.viewerFacts) {
        const value = fact.previewValue ?? fact.defaultValue;
        if (value) facts.set(fact.id, value);
    }
    return facts;
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
        hiddenElements: [],
    };
}

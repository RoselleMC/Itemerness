import { z } from "zod";
import {
    canvasLayerAnchorSchema,
    characterFramePresetSchema,
    conditionOperatorSchema,
    dataConstraintsSchema,
    dataScopeSchema,
    dataTypeSchema,
    dataValueSchema,
    decimalStringSchema,
    fieldValueAlignmentSchema,
    groupDividersSchema,
    groupEmptyPolicySchema,
    groupHeaderMissingPolicySchema,
    groupMarkerSchema,
    idPathSchema,
    MAXIMUM_GROUP_GAP_LINES,
    itemIdSchema,
    instanceIdGeneratorSchema,
    itemInstanceModeSchema,
    localeSchema,
    messageKeySchema,
    missingDataPolicySchema,
    missingKeyValueSchema,
    namespacedIdSchema,
    namespacedKeyFormatModeSchema,
    nestedContentComponentSchema,
    overflowPolicySchema,
    overflowStrategySchema,
    themeRendererSchema,
    uuidSchema,
    vanillaTooltipLinePolicySchema,
    viewerFactTypeSchema,
    visualBoundsSchema,
} from "./common.js";
import { itemKey } from "./itemKeys.js";

/**
 * The authoring document.
 *
 * Its shape mirrors the two parser-independent compiler inputs in `itemerness-core`:
 * `com.iroselle.itemerness.core.presentation.PresentationSource` and
 * `com.iroselle.itemerness.core.catalog.CatalogSource`. The agent deserializes this document
 * straight into those classes, so the authoritative compile path is identical to the one used by
 * local YAML installs and there is no second parser to keep in sync.
 *
 * Two deliberate deviations from the Kotlin inputs:
 *
 * 1. Fonts keep the authoring-level `metrics` selector (`builtin:` / `manifest:` / `explicit` /
 *    `space-provider`) instead of an inlined glyph table. A builtin table holds roughly 100k
 *    glyphs generated from the client jar; it is a build artifact, not authored content. The agent
 *    resolves the selector exactly as `PresentationSourceLoader` does.
 * 2. Asset nodes additionally carry renderer-facing metadata (`texture`, source dimensions,
 *    expected tooltip sprites). The Kotlin compiler ignores those fields, but the browser needs
 *    them to rasterize the same pixels the client would draw.
 */

/** Editor-side identity for collaboration and stable references. Never reused after a rename. */
const nodeIdentity = {
    /** Stable node identity. Moves and renames must not rely on array position. */
    uuid: uuidSchema,
    /**
     * Fields produced by a newer agent that this UI cannot safely edit. Preserved verbatim through
     * a round trip and surfaced as read-only.
     */
    extensions: z.record(z.string().max(128), z.unknown()).optional(),
};

/**
 * The tooltip height limit when a server does not configure one. Servers may raise or lower it
 * through `presentation.maximum-height-pixels`; documents carry the value they were made under.
 */
export const DEFAULT_MAXIMUM_HEIGHT_PIXELS = 180;

export const budgetsSchema = z.strictObject({
    maximumWidthPixels: z.number().int().min(1).max(4096).default(220),
    maximumHeightPixels: z
        .number()
        .int()
        .min(1)
        .max(4096)
        .default(DEFAULT_MAXIMUM_HEIGHT_PIXELS),
    maximumLines: z.number().int().min(1).max(256).default(64),
    maximumRuns: z.number().int().min(1).max(4096).default(512),
    maximumTextCodePoints: z.number().int().min(1).max(131_072).default(16_384),
    maximumBlocksPerItem: z.number().int().min(1).max(4096).default(128),
    maximumBlockDepth: z.number().int().min(1).max(64).default(16),
    maximumRepeatElements: z.number().int().min(1).max(4096).default(64),
    maximumCanvasLayers: z.number().int().min(1).max(1024).default(64),
    maximumEmittedGlyphs: z.number().int().min(1).max(65_536).default(1_024),
});
export type Budgets = z.infer<typeof budgetsSchema>;

// --- Formats -----------------------------------------------------------------------------------

export const formatNodeSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        ...nodeIdentity,
        kind: z.literal("integer"),
        id: namespacedIdSchema,
        pattern: z.string().default("0"),
    }),
    z.strictObject({
        ...nodeIdentity,
        kind: z.literal("decimal"),
        id: namespacedIdSchema,
        pattern: z.string(),
        multiply: z.number().finite().default(1),
        suffixMessage: messageKeySchema.nullable().default(null),
    }),
    z.strictObject({
        ...nodeIdentity,
        kind: z.literal("boolean"),
        id: namespacedIdSchema,
        trueMessage: messageKeySchema,
        falseMessage: messageKeySchema,
    }),
    z.strictObject({
        ...nodeIdentity,
        kind: z.literal("namespacedKey"),
        id: namespacedIdSchema,
        mode: namespacedKeyFormatModeSchema,
        messagePattern: z.string().nullable().default(null),
        missingValue: missingKeyValueSchema.default("PATH"),
    }),
    z.strictObject({
        ...nodeIdentity,
        kind: z.literal("list"),
        id: namespacedIdSchema,
        elementFormat: namespacedIdSchema,
        separatorMessage: messageKeySchema,
    }),
]);
export type FormatNode = z.infer<typeof formatNodeSchema>;

// --- Locales -----------------------------------------------------------------------------------

export const localeNodeSchema = z.strictObject({
    ...nodeIdentity,
    locale: localeSchema,
    fallback: localeSchema.nullable().default(null),
    messages: z.record(
        messageKeySchema,
        z
            .string()
            .refine(
                (text) => [...text].length <= 16_384,
                "Message exceeds 16384 code points",
            ),
    ),
});
export type LocaleNode = z.infer<typeof localeNodeSchema>;

// --- Assets ------------------------------------------------------------------------------------

/**
 * `metrics` selects where glyph advances come from:
 * `builtin:<revision>` resolves a generated vanilla table, `manifest:<id>` a validated pack
 * manifest, `explicit` the glyph entries declared in this document, and `space-provider` a signed
 * advance range.
 */
export const fontNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: namespacedIdSchema,
    metrics: z.union([
        z.enum(["explicit", "space-provider"]),
        namespacedIdSchema,
    ]),
    fallback: namespacedIdSchema.nullable().default(null),
    fallbackAdvancePixels: z.number().finite().nullable().default(null),
    /** Optional source metadata; YAML fixes the advance step at one pixel. */
    advances: z
        .strictObject({
            minimum: z.number().int().min(-2147483648).max(2147483647),
            maximum: z.number().int().min(-2147483648).max(2147483647),
        })
        .refine((range) => range.minimum < range.maximum, {
            path: ["maximum"],
            message: "Maximum advance must exceed minimum advance",
        })
        .nullable()
        .default(null),
});
export type FontNode = z.infer<typeof fontNodeSchema>;

export const glyphNodeSchema = z.strictObject({
    ...nodeIdentity,
    /** Semantic asset id such as `icon.attack`. Raw code points never leave this registry. */
    id: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][a-z0-9._-]*$/),
    font: namespacedIdSchema,
    codePoint: z.number().int().min(0).max(0x10ffff),
    advancePixels: z.number().finite(),
    visualBounds: visualBoundsSchema,
    bitmap: z.string().min(1).nullable().default(null),
});
export type GlyphNode = z.infer<typeof glyphNodeSchema>;

export const bitmapNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][a-z0-9._-]*$/),
    baselineVariant: z.string().nullable().default(null),
    /** Renderer-facing: the resource-pack texture this bitmap provider draws from. */
    texture: namespacedIdSchema.nullable().default(null),
    sourceWidthPixels: z
        .number()
        .int()
        .min(1)
        .max(2147483647)
        .nullable()
        .default(null),
    sourceHeightPixels: z
        .number()
        .int()
        .min(1)
        .max(2147483647)
        .nullable()
        .default(null),
    renderWidthPixels: z.number().int().min(1).max(4096),
    renderHeightPixels: z.number().int().min(1).max(4096),
    ascentPixels: z.number().int().min(-4096).max(4096),
    visualBounds: visualBoundsSchema,
});
export type BitmapNode = z.infer<typeof bitmapNodeSchema>;

export const assetProfileNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: namespacedIdSchema,
    capabilities: z.array(namespacedIdSchema),
    metricsRevision: namespacedIdSchema.nullable().default(null),
    fallback: namespacedIdSchema.nullable().default(null),
});
export type AssetProfileNode = z.infer<typeof assetProfileNodeSchema>;

export const resourcePackDeliverySchema = z.enum(["VERIFIED", "ASSUMED"]);
export type ResourcePackDelivery = z.infer<typeof resourcePackDeliverySchema>;

export const resourcePackBindingNodeSchema = z
    .strictObject({
        ...nodeIdentity,
        id: namespacedIdSchema,
        enabled: z.boolean(),
        packId: uuidSchema.nullable().default(null),
        sha1: z.string().nullable().default(null),
        assetProfile: namespacedIdSchema,
        /**
         * Absent means VERIFIED: active only once the client is observed or
         * reported loading this exact pack. ASSUMED treats every viewer as
         * having it. Kept absent when verified so existing hashes are stable.
         */
        delivery: resourcePackDeliverySchema.optional(),
    })
    .superRefine((binding, context) => {
        if (
            binding.enabled &&
            binding.sha1 !== null &&
            !/^[0-9a-fA-F]{40}$/.test(binding.sha1)
        )
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["sha1"],
                message: "Enabled binding requires a 40-character SHA-1",
            });
    });
export type ResourcePackBindingNode = z.infer<
    typeof resourcePackBindingNodeSchema
>;

export const tooltipStyleNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: namespacedIdSchema,
    /** Renderer-facing: sprite paths the client resolves for `minecraft:tooltip_style`. */
    expectedBackgroundSprite: namespacedIdSchema,
    expectedFrameSprite: namespacedIdSchema,
    scaling: z.enum(["nine-slice", "stretch"]),
});
export type TooltipStyleNode = z.infer<typeof tooltipStyleNodeSchema>;

const spacingRangeSchema = z.strictObject({
    firstCodePoint: z.number().int().min(0).max(0x10ffff),
    lastCodePoint: z.number().int().min(0).max(0x10ffff),
    minimumAdvancePixels: z.number().int().min(-2147483648).max(2147483647),
    maximumAdvancePixels: z.number().int().min(-2147483648).max(2147483647),
});

export const spacingNodeSchema = z.strictObject({
    font: namespacedIdSchema,
    negative: spacingRangeSchema,
    positive: spacingRangeSchema,
});
export type SpacingNode = z.infer<typeof spacingNodeSchema>;

// --- Viewer facts ------------------------------------------------------------------------------

export const viewerFactNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: namespacedIdSchema,
    type: viewerFactTypeSchema,
    providers: z.array(z.string().min(1)),
    defaultValue: dataValueSchema.nullable().default(null),
    nullable: z.boolean().default(false),
    cacheKey: z.boolean().default(true),
    /** Editor-only: the value used when previewing. Never published to the runtime. */
    previewValue: dataValueSchema.nullable().default(null),
});
export type ViewerFactNode = z.infer<typeof viewerFactNodeSchema>;

// --- Layouts -----------------------------------------------------------------------------------

export const wrappingSchema = z.strictObject({
    widthPixels: z.number().int().min(1).max(4096).nullable().default(null),
    maximumLines: z.number().int().min(1).max(256).default(16),
    overflow: overflowPolicySchema.default("ELLIPSIS"),
    preserveExplicitLines: z.boolean().default(true),
    continuationIndentPixels: z
        .number()
        .int()
        .min(0)
        .max(2147483647)
        .default(0),
    lineHeightPixels: z.number().int().min(1).max(4096).default(10),
});
export type Wrapping = z.infer<typeof wrappingSchema>;

/**
 * The run between a field label and its value. Absent inherits the layout default, whose absence
 * keeps the original ": ".
 */
export const fieldSeparatorSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({ kind: z.literal("message"), message: messageKeySchema }),
]);
export type FieldSeparator = z.infer<typeof fieldSeparatorSchema>;

const canvasAnchorSchema = z.strictObject({
    x: z.number().int().min(-4096).max(4096),
    y: z.number().int().min(-4096).max(4096),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    overflow: overflowPolicySchema,
});

export const layoutNodeSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        ...nodeIdentity,
        kind: z.literal("flow"),
        id: namespacedIdSchema,
        minimumWidthPixels: z.number().int().min(1).max(4096),
        maximumWidthPixels: z.number().int().min(1).max(4096),
        blockGapAfterPixels: z.number().int().min(0).max(2147483647).default(0),
        fieldLeftPaddingPixels: z
            .number()
            .int()
            .min(0)
            .max(2147483647)
            .default(0),
        fieldIconGapPixels: z.number().int().min(0).max(2147483647).default(0),
        fieldValueAlignment: fieldValueAlignmentSchema.default("LEFT"),
        descriptionLeftPaddingPixels: z
            .number()
            .int()
            .min(0)
            .max(2147483647)
            .default(0),
        descriptionRightPaddingPixels: z
            .number()
            .int()
            .min(0)
            .max(2147483647)
            .default(0),
        descriptionGapBeforePixels: z
            .number()
            .int()
            .min(0)
            .max(2147483647)
            .default(0),
        wrapping: z.record(z.string().min(1), wrappingSchema),
        /** Absent keeps the built-in colon so existing documents keep their hashes. */
        fieldSeparator: fieldSeparatorSchema.optional(),
        /** Fixed field icon width so labels align; absent keeps each icon's own width. */
        fieldIconSlotPixels: z.number().int().min(1).max(4096).optional(),
        /** Absent means FALLBACK, the behaviour before hiding existed. */
        overflow: overflowStrategySchema.optional(),
    }),
    z.strictObject({
        ...nodeIdentity,
        kind: z.literal("canvas"),
        id: namespacedIdSchema,
        widthPixels: z.number().int().min(1).max(4096),
        heightPixels: z.number().int().min(1).max(4096),
        maximumWidthPixels: z.number().int().min(1).max(4096),
        maximumHeightPixels: z.number().int().min(1).max(4096),
        reserveTooltipLines: z.number().int().min(0).max(256),
        anchors: z.record(z.string().min(1), canvasAnchorSchema),
        wrapping: z.record(z.string().min(1), wrappingSchema),
    }),
]);
export type LayoutNode = z.infer<typeof layoutNodeSchema>;

// --- Themes ------------------------------------------------------------------------------------

export const textStyleSchema = z.strictObject({
    color: z.string().max(32).nullable().default(null),
    bold: z.boolean().default(false),
    italic: z.boolean().default(false),
    underlined: z.boolean().default(false),
    strikethrough: z.boolean().default(false),
});

const frameRowSchema = z.strictObject({
    left: z.string().min(1),
    fill: z.string().min(1),
    right: z.string().min(1),
    center: z.string().min(1).nullable().optional(),
    kern: z.string().min(1).nullable().optional(),
});

/** Marker art: literal text, or a resource-pack glyph (requires `requiresResourcePack`). */
export const markerPieceSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        kind: z.literal("text"),
        text: z.string().min(1).max(64),
    }),
    z.strictObject({ kind: z.literal("glyph"), glyph: z.string().min(1) }),
]);
export type MarkerPiece = z.infer<typeof markerPieceSchema>;

export const themeMarkersSchema = z.strictObject({
    style: z.string().min(1).optional(),
    bullet: markerPieceSchema.optional(),
    tree: z
        .strictObject({
            branch: markerPieceSchema.optional(),
            last: markerPieceSchema.optional(),
            vertical: markerPieceSchema.optional(),
        })
        .optional(),
    /** Extra pixels between a marker and its row; absent means none. */
    gapPixels: z.number().int().min(0).max(4096).optional(),
});
export type ThemeMarkers = z.infer<typeof themeMarkersSchema>;

/** Rule art; every key is absent when it has its default value. */
export const themeRulesSchema = z.strictObject({
    style: z.string().min(1).optional(),
    fill: markerPieceSchema.optional(),
    left: markerPieceSchema.optional(),
    right: markerPieceSchema.optional(),
    /** Absent means the default 4 pixels around a title. */
    titleGapPixels: z.number().int().min(0).max(4096).optional(),
});
export type ThemeRules = z.infer<typeof themeRulesSchema>;

export const themeNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: namespacedIdSchema,
    renderer: themeRendererSchema,
    requiresResourcePack: z.boolean(),
    requiredCapabilities: z.array(namespacedIdSchema).default([]),
    vanillaTooltipLines: vanillaTooltipLinePolicySchema,
    fallback: namespacedIdSchema.nullable().default(null),
    /** Font role (`text`, `icons`, `frame`, `canvas`, `spacing`) to font id. */
    fonts: z.record(z.string().min(1), namespacedIdSchema),
    styles: z.record(z.string().min(1), textStyleSchema).default({}),
    tooltipStyle: namespacedIdSchema.nullable().default(null),
    requireExactFontMetrics: z.boolean().default(false),
    content: z
        .strictObject({
            minimumWidthPixels: z.number().int().min(1).max(4096),
            maximumWidthPixels: z.number().int().min(1).max(4096),
            leftPaddingPixels: z
                .number()
                .int()
                .min(0)
                .max(2147483647)
                .default(0),
            rightPaddingPixels: z
                .number()
                .int()
                .min(0)
                .max(2147483647)
                .default(0),
        })
        .nullable()
        .default(null),
    characterFrame: z
        .strictObject({
            preset: characterFramePresetSchema,
            minimumWidthPixels: z.number().int().min(1).max(4096),
            maximumWidthPixels: z.number().int().min(1).max(4096),
            leftPaddingPixels: z.number().int().min(0).max(2147483647),
            rightPaddingPixels: z.number().int().min(0).max(2147483647),
            alignmentTolerancePixels: z.number().int().min(0).max(256),
            maximumLines: z.number().int().min(1).max(256),
            fallbackBidirectionalText: z.boolean().default(true),
        })
        .nullable()
        .default(null),
    segmentedFrame: z
        .strictObject({
            minimumWidthPixels: z.number().int().min(1).max(4096),
            maximumWidthPixels: z.number().int().min(1).max(4096),
            leftPaddingPixels: z.number().int().min(0).max(2147483647),
            rightPaddingPixels: z.number().int().min(0).max(2147483647),
            top: frameRowSchema,
            body: frameRowSchema,
            connector: frameRowSchema.nullable().default(null),
            bottom: frameRowSchema,
            includeName: z.boolean().optional(),
        })
        .nullable()
        .default(null),
    canvas: z
        .strictObject({
            widthPixels: z.number().int().min(1).max(4096),
            heightPixels: z.number().int().min(1).max(4096),
            maximumWidthPixels: z.number().int().min(1).max(4096),
            maximumHeightPixels: z.number().int().min(1).max(4096),
            reserveTooltipLines: z.number().int().min(0).max(256),
            layers: z
                .array(
                    z.strictObject({
                        asset: z.string().min(1),
                        anchor: canvasLayerAnchorSchema.default("TOP_LEFT"),
                        xPixels: z
                            .number()
                            .int()
                            .min(-2147483648)
                            .max(2147483647),
                        baselineLine: z.number().int().min(0).max(256),
                        baselineVariant: z.string(),
                        drawOrder: z
                            .number()
                            .int()
                            .min(-2147483648)
                            .max(2147483647),
                    }),
                )
                .max(1024),
            measuredAdvancePixels: z.number().int().min(0).max(4096),
            finalTooltipWidthPixels: z.number().int().min(0).max(4096),
            rejectNegativeFinalAdvance: z.boolean().default(true),
            rejectOutOfBoundsLayer: z.boolean().default(true),
            maximumEmittedComponents: z
                .number()
                .int()
                .min(1)
                .max(4096)
                .default(256),
            normalizeVisualOrigin: z.boolean().default(true),
        })
        .nullable()
        .default(null),
    /** Group marker art; absent keeps the built-in pieces and the existing hash. */
    markers: themeMarkersSchema.optional(),
    /** Rule art; absent keeps the built-in dark grey line. */
    rules: themeRulesSchema.optional(),
    /** Padding on each side of the item name; absent means none. */
    nameInsetPixels: z.number().int().min(0).max(4096).optional(),
});
export type ThemeNode = z.infer<typeof themeNodeSchema>;

// --- Data schemas ------------------------------------------------------------------------------

export const dataReadSourceSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("catalogDefinition") }),
    z.strictObject({ kind: z.literal("canonicalNbt") }),
    z.strictObject({
        kind: z.literal("pdc"),
        key: namespacedIdSchema,
        mode: z.literal("FALLBACK_READ_ONLY"),
    }),
]);
export type DataReadSource = z.infer<typeof dataReadSourceSchema>;

export const dataKeyIntegrationSchema = z.strictObject({
    readSources: z.array(dataReadSourceSchema).min(1),
    access: z.strictObject({
        read: z.enum(["PUBLIC", "INTERNAL", "OWNER_ONLY"]),
        write: z
            .array(
                z
                    .string()
                    .regex(
                        /^(definition|internal|plugin:[A-Za-z0-9_.-]{1,64})$/,
                    ),
            )
            .min(1),
    }),
    placeholderApi: z.strictObject({
        exposed: z.boolean(),
        formatter: namespacedIdSchema.nullable(),
    }),
});
export type DataKeyIntegration = z.infer<typeof dataKeyIntegrationSchema>;

export const dataKeyNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: namespacedIdSchema,
    type: dataTypeSchema,
    scope: dataScopeSchema,
    nullable: z.boolean().default(false),
    defaultValue: dataValueSchema.nullable().default(null),
    affectsStacking: z.boolean().default(true),
    presentationReadable: z.boolean().default(false),
    /** Required in schema 2. Legacy documents keep this absent until explicitly upgraded. */
    integration: dataKeyIntegrationSchema.optional(),
    constraints: dataConstraintsSchema.default({}),
});
export type DataKeyNode = z.infer<typeof dataKeyNodeSchema>;

export const sourceLayoutSchema = z.strictObject({
    /** Catalog source hash at import; a different hash at export means the YAML changed since. */
    sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    files: z.record(uuidSchema, z.string().min(1).max(256)),
    measurement: z.string().min(1).max(256).optional(),
    spacing: z.string().min(1).max(256).optional(),
});
export type SourceLayout = z.infer<typeof sourceLayoutSchema>;

export const schemaOwnerSchema = z
    .string()
    .regex(/^plugin:[A-Za-z0-9_.-]{1,64}$/, "expected plugin:<Name>");

export const dataSchemaNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: namespacedIdSchema,
    /** Business schema version persisted in canonical item data. */
    version: z.number().int().min(1).max(2_147_483_647),
    /** Authoring-only declaration that a plugin owns this contract; absent when unowned. */
    owner: schemaOwnerSchema.optional(),
    keys: z.array(dataKeyNodeSchema),
});
export type DataSchemaNode = z.infer<typeof dataSchemaNodeSchema>;

// --- Presentation blocks -----------------------------------------------------------------------

const valueReferenceSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("data"), key: namespacedIdSchema }),
    z.strictObject({ kind: z.literal("fact"), key: namespacedIdSchema }),
    z.strictObject({ kind: z.literal("literal"), value: dataValueSchema }),
]);

const conditionSchema = z.strictObject({
    operator: conditionOperatorSchema,
    left: valueReferenceSchema,
    right: valueReferenceSchema.nullable().default(null),
});
export type PresentationCondition = z.infer<typeof conditionSchema>;

/** Mirrors the compiler's per-selector bound; every case is evaluated on each render. */
export const MAXIMUM_THEME_SELECTOR_CASES = 64;

export const themeSelectorCaseSchema = z.strictObject({
    condition: conditionSchema,
    /** A concrete theme; selectors never choose another selector. */
    theme: namespacedIdSchema,
});
export type ThemeSelectorCase = z.infer<typeof themeSelectorCaseSchema>;

/**
 * A reusable, data-driven theme choice. Its id shares the theme id space, so items and the
 * document default theme may reference it. The first matching case wins, otherwise
 * `defaultTheme` applies. The compiler enforces the case budget as a diagnostic.
 */
export const themeSelectorNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: namespacedIdSchema,
    cases: z.array(themeSelectorCaseSchema),
    defaultTheme: namespacedIdSchema,
});
export type ThemeSelectorNode = z.infer<typeof themeSelectorNodeSchema>;

/** Styles for the parts of a field row; absent parts use the block style. */
export const fieldPartStylesSchema = z.strictObject({
    icon: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    separator: z.string().min(1).optional(),
    value: z.string().min(1).optional(),
});
export type FieldPartStyles = z.infer<typeof fieldPartStylesSchema>;

const compoundFieldTemplateSchema = z.strictObject({
    labelMessage: messageKeySchema,
    valuePath: z.string().min(1),
    missingMessage: messageKeySchema,
    icon: z.string().min(1).nullable().default(null),
    format: namespacedIdSchema.nullable().default(null),
    separator: fieldSeparatorSchema.optional(),
    partStyles: fieldPartStylesSchema.optional(),
});

/**
 * One run of a composed row: a localized message, a formatted data value, a resource-pack glyph,
 * literal text, or a summary slot that collects what hidden blocks leave behind.
 */
export type Fragment = (
    | { kind: "message"; message: string }
    | { kind: "data"; data: string; format?: string }
    | { kind: "glyph"; glyph: string }
    | { kind: "literal"; text: string }
    | {
          kind: "slot";
          id: string;
          prefix?: Fragment;
          suffix?: Fragment;
          separator?: Fragment;
          maximumEntries?: number;
          overflowCountMessage?: string;
      }
) & { style?: string; condition?: PresentationCondition };

export const fragmentSchema: z.ZodType<Fragment, z.ZodTypeDef, unknown> =
    z.lazy(() => {
        const common = {
            style: z.string().min(1).optional(),
            condition: conditionSchema.optional(),
        };
        return z.discriminatedUnion("kind", [
            z.strictObject({
                kind: z.literal("message"),
                message: messageKeySchema,
                ...common,
            }),
            z.strictObject({
                kind: z.literal("data"),
                data: namespacedIdSchema,
                format: namespacedIdSchema.optional(),
                ...common,
            }),
            z.strictObject({
                kind: z.literal("glyph"),
                glyph: z.string().min(1),
                ...common,
            }),
            z.strictObject({
                kind: z.literal("literal"),
                text: z.string().min(1).max(256),
                ...common,
            }),
            z.strictObject({
                kind: z.literal("slot"),
                id: z.string().min(1).max(64),
                prefix: fragmentSchema.optional(),
                suffix: fragmentSchema.optional(),
                separator: fragmentSchema.optional(),
                maximumEntries: z.number().int().min(1).max(4096).optional(),
                overflowCountMessage: messageKeySchema.optional(),
                ...common,
            }),
        ]);
    });

/** A ranked weight (lower hides first) or "never"; absent inherits the enclosing block's. */
export const hidingWeightSchema = z.union([
    z.number().int().min(0).max(2147483647),
    z.literal("never"),
]);
export type HidingWeight = z.infer<typeof hidingWeightSchema>;

/** What a hidden block leaves in a slot: a static piece, or a repeat element value. */
export const summarySchema = z.strictObject({
    slot: z.string().min(1).max(64),
    piece: fragmentSchema.optional(),
    valuePath: z.string().min(1).optional(),
    format: namespacedIdSchema.optional(),
    style: z.string().min(1).optional(),
});
export type Summary = z.infer<typeof summarySchema>;

/** Hiding settings every content block may carry; absent when unset. */
type Hiding = { weight?: HidingWeight; summary?: Summary };

export type PresentationBlock = (
    | {
          uuid: string;
          type: "text";
          data: string;
          style: string | null;
          anchor: string | null;
          wrapping: string | null;
          unbreakable: boolean;
          missingPolicy: z.infer<typeof missingDataPolicySchema>;
      }
    | {
          uuid: string;
          type: "field";
          labelMessage: string;
          data: string;
          format: string | null;
          icon: string | null;
          style: string | null;
          anchor: string | null;
          wrapping: string | null;
          missingPolicy: z.infer<typeof missingDataPolicySchema>;
          separator?: FieldSeparator;
          partStyles?: FieldPartStyles;
      }
    | {
          uuid: string;
          type: "description";
          message: string;
          style: string | null;
          anchor: string | null;
          wrapping: string | null;
      }
    | {
          uuid: string;
          type: "conditional";
          condition: z.infer<typeof conditionSchema>;
          thenBlocks: PresentationBlock[];
          otherwiseBlocks: PresentationBlock[];
          style: string | null;
          anchor: string | null;
      }
    | {
          uuid: string;
          type: "repeat";
          data: string;
          maximumElements: number;
          template: z.infer<typeof compoundFieldTemplateSchema>;
          style: string | null;
          anchor: string | null;
          missingPolicy: z.infer<typeof missingDataPolicySchema>;
      }
    | {
          uuid: string;
          type: "nestedItemList";
          style: string | null;
          anchor: string | null;
      }
    | {
          uuid: string;
          type: "group";
          /** A single-row field or text block; absent means a header-less group. */
          header?: PresentationBlock;
          children: PresentationBlock[];
          /** Every option is absent when it has its default value. */
          marker?: z.infer<typeof groupMarkerSchema>;
          dividers?: z.infer<typeof groupDividersSchema>;
          whenHeaderMissing?: z.infer<typeof groupHeaderMissingPolicySchema>;
          whenEmpty?: z.infer<typeof groupEmptyPolicySchema>;
          gapBeforeLines?: number;
          style: string | null;
          anchor: string | null;
      }
    | {
          uuid: string;
          type: "row";
          left: Fragment[];
          right: Fragment[];
          wrapping: string | null;
          style: string | null;
          anchor: string | null;
      }
    | {
          uuid: string;
          type: "rule";
          title: Fragment[];
          style: string | null;
          anchor: string | null;
      }
) &
    Hiding;

const styleRef = z.string().min(1).nullable().default(null);
const anchorRef = z.string().min(1).nullable().default(null);
const wrappingRef = z.string().min(1).nullable().default(null);

// The parsed block is fully defaulted, while the accepted input leaves those fields optional, so
// the schema is typed with distinct output and input sides.
export const presentationBlockSchema: z.ZodType<
    PresentationBlock,
    z.ZodTypeDef,
    unknown
> = z.lazy(() =>
    z.discriminatedUnion("type", [
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("text"),
            data: namespacedIdSchema,
            style: styleRef,
            anchor: anchorRef,
            wrapping: wrappingRef,
            unbreakable: z.boolean().default(false),
            missingPolicy: missingDataPolicySchema.default("ERROR"),
            weight: hidingWeightSchema.optional(),
            summary: summarySchema.optional(),
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("field"),
            labelMessage: messageKeySchema,
            data: namespacedIdSchema,
            format: namespacedIdSchema.nullable().default(null),
            icon: z.string().min(1).nullable().default(null),
            style: styleRef,
            anchor: anchorRef,
            wrapping: wrappingRef,
            missingPolicy: missingDataPolicySchema.default("ERROR"),
            separator: fieldSeparatorSchema.optional(),
            partStyles: fieldPartStylesSchema.optional(),
            weight: hidingWeightSchema.optional(),
            summary: summarySchema.optional(),
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("description"),
            message: messageKeySchema,
            style: styleRef,
            anchor: anchorRef,
            wrapping: wrappingRef,
            weight: hidingWeightSchema.optional(),
            summary: summarySchema.optional(),
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("conditional"),
            condition: conditionSchema,
            thenBlocks: z.array(presentationBlockSchema).max(128),
            otherwiseBlocks: z.array(presentationBlockSchema).max(128),
            style: styleRef,
            anchor: anchorRef,
            weight: hidingWeightSchema.optional(),
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("repeat"),
            data: namespacedIdSchema,
            maximumElements: z.number().int().min(1).max(4096),
            template: compoundFieldTemplateSchema,
            style: styleRef,
            anchor: anchorRef,
            missingPolicy: missingDataPolicySchema.default("ERROR"),
            weight: hidingWeightSchema.optional(),
            summary: summarySchema.optional(),
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("nestedItemList"),
            style: styleRef,
            anchor: anchorRef,
            weight: hidingWeightSchema.optional(),
            summary: summarySchema.optional(),
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("group"),
            header: presentationBlockSchema.optional(),
            children: z.array(presentationBlockSchema).max(128),
            marker: groupMarkerSchema.optional(),
            dividers: groupDividersSchema.optional(),
            whenHeaderMissing: groupHeaderMissingPolicySchema.optional(),
            whenEmpty: groupEmptyPolicySchema.optional(),
            gapBeforeLines: z
                .number()
                .int()
                .min(0)
                .max(MAXIMUM_GROUP_GAP_LINES)
                .optional(),
            style: styleRef,
            anchor: anchorRef,
            weight: hidingWeightSchema.optional(),
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("row"),
            left: z.array(fragmentSchema).max(256).default([]),
            right: z.array(fragmentSchema).max(256).default([]),
            wrapping: wrappingRef,
            style: styleRef,
            anchor: anchorRef,
            weight: hidingWeightSchema.optional(),
            summary: summarySchema.optional(),
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("rule"),
            title: z.array(fragmentSchema).max(256).default([]),
            style: styleRef,
            anchor: anchorRef,
            weight: hidingWeightSchema.optional(),
            summary: summarySchema.optional(),
        }),
    ]),
);

// --- Items -------------------------------------------------------------------------------------

const dataAssignmentSchema = z.strictObject({
    key: namespacedIdSchema,
    value: dataValueSchema,
});

const dataGeneratorSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unixMillis"), key: namespacedIdSchema }),
    z.strictObject({
        kind: z.literal("randomDecimal"),
        key: namespacedIdSchema,
        minimum: decimalStringSchema,
        maximum: decimalStringSchema,
        scale: z.number().int().min(0).max(32),
    }),
]);

export const itemNodeSchema = z.strictObject({
    ...nodeIdentity,
    /** Item path, or a fully qualified key in document format 2. */
    id: itemIdSchema,
    enabled: z.boolean(),
    definition: z.strictObject({
        material: namespacedIdSchema,
        baseComponents: z
            .array(
                z.strictObject({
                    id: namespacedIdSchema,
                    value: dataValueSchema,
                }),
            )
            .max(256)
            .default([]),
        contentComponent: nestedContentComponentSchema.nullable().default(null),
        contents: z
            .array(
                z.strictObject({
                    item: namespacedIdSchema,
                    amount: z.number().int().min(1).max(1024),
                }),
            )
            .max(256)
            .default([]),
        definitionData: z.array(dataAssignmentSchema).max(256).default([]),
        instance: z.strictObject({
            mode: itemInstanceModeSchema,
            idGenerator: instanceIdGeneratorSchema.nullable().default(null),
            schemas: z
                .array(
                    z.strictObject({
                        id: namespacedIdSchema,
                        version: z.number().int().min(1).max(2_147_483_647),
                    }),
                )
                .max(64),
            defaults: z.array(dataAssignmentSchema).max(256).default([]),
            generators: z.array(dataGeneratorSchema).max(256).default([]),
        }),
    }),
    presentation: z.strictObject({
        layout: namespacedIdSchema.nullable().optional(),
        theme: namespacedIdSchema.nullable().optional(),
        nameMessage: messageKeySchema,
        blocks: z.array(presentationBlockSchema).max(128),
        /**
         * Data component ids whose vanilla tooltip lines stay visible; every other vanilla line is
         * hidden. Absent means none. Editors omit an empty list so older plugins keep loading.
         */
        shownFlags: z.array(namespacedIdSchema).max(64).optional(),
        /**
         * The implicit root group's decoration. Absent means NONE and BETWEEN_CHILDREN, the
         * behaviour before groups existed, so existing documents keep their hashes.
         */
        marker: groupMarkerSchema.optional(),
        dividers: groupDividersSchema.optional(),
        /** Runs around the item name; absent when empty. */
        nameBefore: z.array(fragmentSchema).max(256).optional(),
        nameAfter: z.array(fragmentSchema).max(256).optional(),
        /** Absent inherits the layout's strategy. */
        overflow: overflowStrategySchema.optional(),
    }),
    /** Editor-only: instance data used when previewing this item. Never published. */
    previewData: z.array(dataAssignmentSchema).max(256).default([]),
});
export type ItemNode = z.infer<typeof itemNodeSchema>;

// --- Access policies ---------------------------------------------------------------------------

/**
 * Catalog-level content policy only. The server-local `access.yml` caller grant is a second,
 * independent gate that is never uploaded, imported, or editable here.
 */
export const accessPolicyNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: namespacedIdSchema,
    subject: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("item"), item: idPathSchema }),
        z.strictObject({
            kind: z.literal("dataKey"),
            dataKey: namespacedIdSchema,
        }),
    ]),
    presentationReadable: z.boolean(),
    apiReadable: z.boolean(),
    apiWritable: z.boolean(),
});
export type AccessPolicyNode = z.infer<typeof accessPolicyNodeSchema>;

// --- Document ----------------------------------------------------------------------------------

export const LEGACY_PROJECT_DOCUMENT_SCHEMA_VERSION = 1;
export const PROJECT_DOCUMENT_SCHEMA_VERSION = 2;
export const SUPPORTED_PROJECT_DOCUMENT_SCHEMA_VERSIONS = [1, 2] as const;

export const measurementSchema = z.strictObject({
    boldExtraAdvancePixels: z.number().finite().min(0).max(4096),
    clientVersion: z
        .enum(["server", "1.21.11", "26.1.1", "26.1.2", "26.2", "26.3"])
        .optional(),
    missingGlyph: z.literal("error").optional(),
});
export type Measurement = z.infer<typeof measurementSchema>;

export const projectDocumentSchema = z
    .strictObject({
        schemaVersion: z.union([z.literal(1), z.literal(2)]),
        documentId: uuidSchema,
        /** Default namespace applied to item paths. */
        namespace: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9_.-]+$/),
        defaultLocale: localeSchema,
        /** Optional in schema 2; absence must not change an existing snapshot hash. */
        defaultLayout: namespacedIdSchema.nullable().optional(),
        defaultTheme: namespacedIdSchema.nullable().optional(),
        budgets: budgetsSchema,
        /** Omitted in schema 1; no read-time default may change a stored snapshot hash. */
        measurement: measurementSchema.optional(),
        formats: z.array(formatNodeSchema),
        locales: z.array(localeNodeSchema),
        fonts: z.array(fontNodeSchema),
        glyphs: z.array(glyphNodeSchema),
        bitmaps: z.array(bitmapNodeSchema),
        assetProfiles: z.array(assetProfileNodeSchema),
        resourcePackBindings: z.array(resourcePackBindingNodeSchema),
        tooltipStyles: z.array(tooltipStyleNodeSchema),
        spacing: spacingNodeSchema.nullable(),
        viewerFacts: z.array(viewerFactNodeSchema).max(256),
        layouts: z.array(layoutNodeSchema),
        themes: z.array(themeNodeSchema),
        /** Absent, never empty, when a document has no selectors so older hashes stay stable. */
        themeSelectors: z.array(themeSelectorNodeSchema).optional(),
        dataSchemas: z.array(dataSchemaNodeSchema),
        items: z.array(itemNodeSchema),
        accessPolicies: z.array(accessPolicyNodeSchema).max(0),
        extensions: z.record(z.string().max(128), z.unknown()).optional(),
        /**
         * Which catalog file each imported node came from, keyed by node UUID. Export writes nodes
         * back to those files; nodes without an entry use the domain's default file.
         */
        sourceLayout: sourceLayoutSchema.optional(),
    })
    .superRefine((document, context) => {
        const report = (path: (string | number)[], message: string) =>
            context.addIssue({ code: z.ZodIssueCode.custom, path, message });
        for (const [field, library] of [
            ["defaultLayout", "layouts"],
            ["defaultTheme", "themes"],
        ] as const) {
            if (document.schemaVersion === 1 && document[field] !== undefined)
                report([field], `${field} requires document schema 2`);
            // Theme selectors share the theme id space, so a default theme may name one.
            const declared =
                library === "themes"
                    ? [...document.themes, ...(document.themeSelectors ?? [])]
                    : document[library];
            if (
                document[field] != null &&
                !declared.some((entry) => entry.id === document[field])
            )
                report(
                    [field],
                    `${field} must reference a declared ${library === "layouts" ? "layout" : "theme"}`,
                );
        }
        const itemIds = new Set<string>();
        document.items.forEach((item, index) => {
            for (const [field, defaultField] of [
                ["layout", "defaultLayout"],
                ["theme", "defaultTheme"],
            ] as const) {
                if (
                    item.presentation[field] == null &&
                    (document.schemaVersion === 1 ||
                        document[defaultField] == null)
                )
                    report(
                        ["items", index, "presentation", field],
                        document.schemaVersion === 1
                            ? `${field} must be explicit in document schema 1`
                            : `Inherited ${field} requires ${defaultField}`,
                    );
            }
            const path = ["items", index, "id"];
            if (document.schemaVersion === 1) {
                if (!idPathSchema.safeParse(item.id).success)
                    report(
                        path,
                        "Document schema 1 requires an item path of at most 254 characters",
                    );
                return;
            }
            const id = itemKey(document, item);
            if (!namespacedIdSchema.safeParse(id).success)
                report(
                    path,
                    "Resolved item key must be a valid namespaced ID of at most 256 characters",
                );
            if (itemIds.has(id)) report(path, `Duplicate item key ${id}`);
            itemIds.add(id);
        });
        if (document.schemaVersion === 1 && document.measurement !== undefined)
            report(["measurement"], "measurement requires document schema 2");
        if (document.schemaVersion === 2 && document.measurement === undefined)
            report(
                ["measurement"],
                "measurement is required in document schema 2",
            );
        const integratedIds = new Set<string>();
        document.dataSchemas.forEach((schema, schemaIndex) => {
            schema.keys.forEach((key, keyIndex) => {
                const path = [
                    "dataSchemas",
                    schemaIndex,
                    "keys",
                    keyIndex,
                    "integration",
                ];
                const integration = key.integration;
                if (document.schemaVersion === 1) {
                    if (integration !== undefined)
                        report(path, "integration requires document schema 2");
                    return;
                }
                if (integration === undefined) {
                    report(
                        path,
                        "integration is required in document schema 2",
                    );
                    return;
                }
                if (integratedIds.has(key.id))
                    report(
                        path,
                        `YAML does not support multiple integration policies for ${key.id}`,
                    );
                integratedIds.add(key.id);
                const primary =
                    key.scope === "DEFINITION"
                        ? "catalogDefinition"
                        : "canonicalNbt";
                const scalar =
                    key.type.kind !== "list" && key.type.kind !== "compound";
                const pdcKeys = new Set<string>();
                integration.readSources.forEach((source, index) => {
                    const sourcePath = [...path, "readSources", index];
                    if (index === 0) {
                        if (source.kind !== primary)
                            report(
                                sourcePath,
                                `Primary source must be ${primary}`,
                            );
                    } else if (source.kind !== "pdc") {
                        report(
                            sourcePath,
                            "Only PDC fallbacks may follow the primary source",
                        );
                    }
                    if (source.kind === "pdc") {
                        if (key.scope !== "INSTANCE" || !scalar)
                            report(
                                sourcePath,
                                "PDC fallback requires a scalar INSTANCE data key",
                            );
                        if (pdcKeys.has(source.key))
                            report(sourcePath, "Duplicate PDC fallback key");
                        pdcKeys.add(source.key);
                    }
                });
                const writers = new Set<string>();
                integration.access.write.forEach((writer, index) => {
                    const writerPath = [...path, "access", "write", index];
                    if (
                        key.scope === "DEFINITION"
                            ? writer !== "definition"
                            : writer === "definition"
                    )
                        report(
                            writerPath,
                            `Write principal is incompatible with ${key.scope}`,
                        );
                    const normalized = writer.toLowerCase();
                    if (writers.has(normalized))
                        report(writerPath, "Duplicate write principal");
                    writers.add(normalized);
                });
                if (
                    integration.placeholderApi.exposed &&
                    (!scalar || integration.access.read !== "PUBLIC")
                )
                    report(
                        [...path, "placeholderApi", "exposed"],
                        "PlaceholderAPI exposure requires a public scalar data key",
                    );
            });
        });
    });
export type ProjectDocument = z.infer<typeof projectDocumentSchema>;

/** Explicit upgrade only. The caller must resolve each schema/key identity's real access policy. */
export function upgradeProjectDocument(
    document: ProjectDocument,
    integrationForKey: (
        schema: DataSchemaNode,
        key: DataKeyNode,
    ) => DataKeyIntegration,
): ProjectDocument {
    projectDocumentSchema.parse(document);
    if (document.schemaVersion !== 1)
        throw new Error("DOCUMENT_ALREADY_UPGRADED");
    const upgraded = {
        ...document,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
        measurement: { boldExtraAdvancePixels: 1 },
        dataSchemas: document.dataSchemas.map((schema) => ({
            ...schema,
            keys: schema.keys.map((key) => ({
                ...key,
                integration: integrationForKey(schema, key),
            })),
        })),
    };
    projectDocumentSchema.parse(upgraded);
    return structuredClone(upgraded) as ProjectDocument;
}

/** An empty but valid document, used when creating a project. */
export function emptyProjectDocument(
    documentId: string,
    namespace = "itemerness",
): ProjectDocument {
    return projectDocumentSchema.parse({
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
        documentId,
        namespace,
        defaultLocale: "en_us",
        budgets: {},
        measurement: { boldExtraAdvancePixels: 1 },
        formats: [],
        locales: [],
        fonts: [],
        glyphs: [],
        bitmaps: [],
        assetProfiles: [],
        resourcePackBindings: [],
        tooltipStyles: [],
        spacing: null,
        viewerFacts: [],
        layouts: [],
        themes: [],
        dataSchemas: [],
        items: [],
        accessPolicies: [],
    });
}

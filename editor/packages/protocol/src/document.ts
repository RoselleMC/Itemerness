import { z } from "zod";
import {
    canvasLayerAnchorSchema,
    characterFramePresetSchema,
    conditionOperatorSchema,
    dataScopeSchema,
    dataTypeSchema,
    dataValueSchema,
    decimalStringSchema,
    fieldValueAlignmentSchema,
    idPathSchema,
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
    themeRendererSchema,
    uuidSchema,
    vanillaTooltipLinePolicySchema,
    viewerFactTypeSchema,
    visualBoundsSchema,
} from "./common.js";

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

export const budgetsSchema = z.object({
    maximumWidthPixels: z.number().int().min(1).max(4096).default(220),
    maximumHeightPixels: z.number().int().min(1).max(4096).default(180),
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
    z.object({
        ...nodeIdentity,
        kind: z.literal("integer"),
        id: namespacedIdSchema,
        pattern: z.string().min(1).max(64).default("0"),
    }),
    z.object({
        ...nodeIdentity,
        kind: z.literal("decimal"),
        id: namespacedIdSchema,
        pattern: z.string().min(1).max(64),
        multiply: z.number().finite().default(1),
        suffixMessage: messageKeySchema.nullable().default(null),
    }),
    z.object({
        ...nodeIdentity,
        kind: z.literal("boolean"),
        id: namespacedIdSchema,
        trueMessage: messageKeySchema,
        falseMessage: messageKeySchema,
    }),
    z.object({
        ...nodeIdentity,
        kind: z.literal("namespacedKey"),
        id: namespacedIdSchema,
        mode: namespacedKeyFormatModeSchema,
        messagePattern: z.string().min(1).max(256).nullable().default(null),
        missingValue: missingKeyValueSchema.default("PATH"),
    }),
    z.object({
        ...nodeIdentity,
        kind: z.literal("list"),
        id: namespacedIdSchema,
        elementFormat: namespacedIdSchema,
        separatorMessage: messageKeySchema,
    }),
]);
export type FormatNode = z.infer<typeof formatNodeSchema>;

// --- Locales -----------------------------------------------------------------------------------

export const localeNodeSchema = z.object({
    ...nodeIdentity,
    locale: localeSchema,
    fallback: localeSchema.nullable().default(null),
    messages: z.record(messageKeySchema, z.string().max(8_192)),
});
export type LocaleNode = z.infer<typeof localeNodeSchema>;

// --- Assets ------------------------------------------------------------------------------------

/**
 * `metrics` selects where glyph advances come from:
 * `builtin:<revision>` resolves a generated vanilla table, `manifest:<id>` a validated pack
 * manifest, `explicit` the glyph entries declared in this document, and `space-provider` a signed
 * advance range.
 */
export const fontNodeSchema = z.object({
    ...nodeIdentity,
    id: namespacedIdSchema,
    metrics: z
        .string()
        .min(1)
        .max(128)
        .regex(
            /^(builtin:[a-z0-9_.:-]+|manifest:[a-z0-9_.:-]+|explicit|space-provider)$/,
        ),
    fallback: namespacedIdSchema.nullable().default(null),
    fallbackAdvancePixels: z.number().finite().nullable().default(null),
    /** Only meaningful for `space-provider` fonts. The step is fixed at one pixel. */
    advances: z
        .object({
            minimum: z.number().int().min(-4096).max(0),
            maximum: z.number().int().min(0).max(4096),
        })
        .nullable()
        .default(null),
});
export type FontNode = z.infer<typeof fontNodeSchema>;

export const glyphNodeSchema = z.object({
    ...nodeIdentity,
    /** Semantic asset id such as `icon.attack`. Raw code points never leave this registry. */
    id: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9][a-z0-9._-]*$/),
    font: namespacedIdSchema,
    codePoint: z.number().int().min(0).max(0x10ffff),
    advancePixels: z.number().finite(),
    visualBounds: visualBoundsSchema,
    bitmap: z.string().min(1).max(128).nullable().default(null),
});
export type GlyphNode = z.infer<typeof glyphNodeSchema>;

export const bitmapNodeSchema = z.object({
    ...nodeIdentity,
    id: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9][a-z0-9._-]*$/),
    baselineVariant: z.string().min(1).max(128).nullable().default(null),
    /** Renderer-facing: the resource-pack texture this bitmap provider draws from. */
    texture: namespacedIdSchema.nullable().default(null),
    sourceWidthPixels: z
        .number()
        .int()
        .min(1)
        .max(4096)
        .nullable()
        .default(null),
    sourceHeightPixels: z
        .number()
        .int()
        .min(1)
        .max(4096)
        .nullable()
        .default(null),
    renderWidthPixels: z.number().int().min(1).max(4096),
    renderHeightPixels: z.number().int().min(1).max(4096),
    ascentPixels: z.number().int().min(-4096).max(4096),
    visualBounds: visualBoundsSchema,
});
export type BitmapNode = z.infer<typeof bitmapNodeSchema>;

export const assetProfileNodeSchema = z.object({
    ...nodeIdentity,
    id: namespacedIdSchema,
    capabilities: z.array(namespacedIdSchema).max(64),
    metricsRevision: namespacedIdSchema.nullable().default(null),
    fallback: namespacedIdSchema.nullable().default(null),
});
export type AssetProfileNode = z.infer<typeof assetProfileNodeSchema>;

export const resourcePackBindingNodeSchema = z.object({
    ...nodeIdentity,
    id: namespacedIdSchema,
    enabled: z.boolean(),
    packId: uuidSchema.nullable().default(null),
    sha1: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .nullable()
        .default(null),
    assetProfile: namespacedIdSchema,
});
export type ResourcePackBindingNode = z.infer<
    typeof resourcePackBindingNodeSchema
>;

export const tooltipStyleNodeSchema = z.object({
    ...nodeIdentity,
    id: namespacedIdSchema,
    /** Renderer-facing: sprite paths the client resolves for `minecraft:tooltip_style`. */
    expectedBackgroundSprite: namespacedIdSchema,
    expectedFrameSprite: namespacedIdSchema,
    scaling: z.enum(["nine-slice", "stretch"]),
});
export type TooltipStyleNode = z.infer<typeof tooltipStyleNodeSchema>;

const spacingRangeSchema = z.object({
    firstCodePoint: z.number().int().min(0).max(0x10ffff),
    lastCodePoint: z.number().int().min(0).max(0x10ffff),
    minimumAdvancePixels: z.number().int().min(-4096).max(4096),
    maximumAdvancePixels: z.number().int().min(-4096).max(4096),
});

export const spacingNodeSchema = z.object({
    font: namespacedIdSchema,
    negative: spacingRangeSchema,
    positive: spacingRangeSchema,
});
export type SpacingNode = z.infer<typeof spacingNodeSchema>;

// --- Viewer facts ------------------------------------------------------------------------------

export const viewerFactNodeSchema = z.object({
    ...nodeIdentity,
    id: namespacedIdSchema,
    type: viewerFactTypeSchema,
    providers: z.array(z.string().min(1).max(128)).max(32),
    defaultValue: dataValueSchema.nullable().default(null),
    nullable: z.boolean().default(false),
    cacheKey: z.boolean().default(true),
    /** Editor-only: the value used when previewing. Never published to the runtime. */
    previewValue: dataValueSchema.nullable().default(null),
});
export type ViewerFactNode = z.infer<typeof viewerFactNodeSchema>;

// --- Layouts -----------------------------------------------------------------------------------

export const wrappingSchema = z.object({
    widthPixels: z.number().int().min(1).max(4096).nullable().default(null),
    maximumLines: z.number().int().min(1).max(256).default(16),
    overflow: overflowPolicySchema.default("ELLIPSIS"),
    preserveExplicitLines: z.boolean().default(true),
    continuationIndentPixels: z.number().int().min(0).max(1024).default(0),
    lineHeightPixels: z.number().int().min(1).max(256).default(10),
});
export type Wrapping = z.infer<typeof wrappingSchema>;

const canvasAnchorSchema = z.object({
    x: z.number().int().min(-4096).max(4096),
    y: z.number().int().min(-4096).max(4096),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    overflow: overflowPolicySchema,
});

export const layoutNodeSchema = z.discriminatedUnion("kind", [
    z.object({
        ...nodeIdentity,
        kind: z.literal("flow"),
        id: namespacedIdSchema,
        minimumWidthPixels: z.number().int().min(1).max(4096),
        maximumWidthPixels: z.number().int().min(1).max(4096),
        blockGapAfterPixels: z.number().int().min(0).max(256).default(0),
        fieldLeftPaddingPixels: z.number().int().min(0).max(1024).default(0),
        fieldIconGapPixels: z.number().int().min(0).max(256).default(0),
        fieldValueAlignment: fieldValueAlignmentSchema.default("LEFT"),
        descriptionLeftPaddingPixels: z
            .number()
            .int()
            .min(0)
            .max(1024)
            .default(0),
        descriptionRightPaddingPixels: z
            .number()
            .int()
            .min(0)
            .max(1024)
            .default(0),
        descriptionGapBeforePixels: z.number().int().min(0).max(256).default(0),
        wrapping: z.record(z.string().min(1).max(64), wrappingSchema),
    }),
    z.object({
        ...nodeIdentity,
        kind: z.literal("canvas"),
        id: namespacedIdSchema,
        widthPixels: z.number().int().min(1).max(4096),
        heightPixels: z.number().int().min(1).max(4096),
        maximumWidthPixels: z.number().int().min(1).max(4096),
        maximumHeightPixels: z.number().int().min(1).max(4096),
        reserveTooltipLines: z.number().int().min(0).max(256),
        anchors: z.record(z.string().min(1).max(64), canvasAnchorSchema),
        wrapping: z.record(z.string().min(1).max(64), wrappingSchema),
    }),
]);
export type LayoutNode = z.infer<typeof layoutNodeSchema>;

// --- Themes ------------------------------------------------------------------------------------

export const textStyleSchema = z.object({
    color: z.string().max(32).nullable().default(null),
    bold: z.boolean().default(false),
    italic: z.boolean().default(false),
    underlined: z.boolean().default(false),
    strikethrough: z.boolean().default(false),
});

const frameRowSchema = z.object({
    left: z.string().min(1).max(128),
    fill: z.string().min(1).max(128),
    right: z.string().min(1).max(128),
});

export const themeNodeSchema = z.object({
    ...nodeIdentity,
    id: namespacedIdSchema,
    renderer: themeRendererSchema,
    requiresResourcePack: z.boolean(),
    requiredCapabilities: z.array(namespacedIdSchema).max(64).default([]),
    vanillaTooltipLines: vanillaTooltipLinePolicySchema,
    fallback: namespacedIdSchema.nullable().default(null),
    /** Font role (`text`, `icons`, `frame`, `canvas`, `spacing`) to font id. */
    fonts: z.record(z.string().min(1).max(64), namespacedIdSchema),
    styles: z.record(z.string().min(1).max(64), textStyleSchema).default({}),
    tooltipStyle: namespacedIdSchema.nullable().default(null),
    requireExactFontMetrics: z.boolean().default(false),
    content: z
        .object({
            minimumWidthPixels: z.number().int().min(1).max(4096),
            maximumWidthPixels: z.number().int().min(1).max(4096),
            leftPaddingPixels: z.number().int().min(0).max(1024).default(0),
            rightPaddingPixels: z.number().int().min(0).max(1024).default(0),
        })
        .nullable()
        .default(null),
    characterFrame: z
        .object({
            preset: characterFramePresetSchema,
            minimumWidthPixels: z.number().int().min(1).max(4096),
            maximumWidthPixels: z.number().int().min(1).max(4096),
            leftPaddingPixels: z.number().int().min(0).max(1024),
            rightPaddingPixels: z.number().int().min(0).max(1024),
            alignmentTolerancePixels: z.number().int().min(0).max(256),
            maximumLines: z.number().int().min(1).max(256),
            fallbackBidirectionalText: z.boolean().default(true),
        })
        .nullable()
        .default(null),
    segmentedFrame: z
        .object({
            minimumWidthPixels: z.number().int().min(1).max(4096),
            maximumWidthPixels: z.number().int().min(1).max(4096),
            leftPaddingPixels: z.number().int().min(0).max(1024),
            rightPaddingPixels: z.number().int().min(0).max(1024),
            top: frameRowSchema,
            body: frameRowSchema,
            connector: frameRowSchema.nullable().default(null),
            bottom: frameRowSchema,
        })
        .nullable()
        .default(null),
    canvas: z
        .object({
            widthPixels: z.number().int().min(1).max(4096),
            heightPixels: z.number().int().min(1).max(4096),
            maximumWidthPixels: z.number().int().min(1).max(4096),
            maximumHeightPixels: z.number().int().min(1).max(4096),
            reserveTooltipLines: z.number().int().min(0).max(256),
            layers: z
                .array(
                    z.object({
                        asset: z.string().min(1).max(128),
                        anchor: canvasLayerAnchorSchema.default("TOP_LEFT"),
                        xPixels: z.number().int().min(-4096).max(4096),
                        baselineLine: z.number().int().min(0).max(256),
                        baselineVariant: z.string().min(1).max(128),
                        drawOrder: z.number().int().min(0).max(1024),
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
});
export type ThemeNode = z.infer<typeof themeNodeSchema>;

// --- Data schemas ------------------------------------------------------------------------------

export const dataKeyNodeSchema = z.object({
    ...nodeIdentity,
    id: namespacedIdSchema,
    type: dataTypeSchema,
    scope: dataScopeSchema,
    nullable: z.boolean().default(false),
    defaultValue: dataValueSchema.nullable().default(null),
    affectsStacking: z.boolean().default(true),
    presentationReadable: z.boolean().default(false),
    constraints: z
        .object({
            minimum: decimalStringSchema.nullable().default(null),
            maximum: decimalStringSchema.nullable().default(null),
            scale: z.number().int().min(0).max(32).nullable().default(null),
            maximumCodePoints: z.number().int().min(0).nullable().default(null),
            maximumElements: z.number().int().min(0).nullable().default(null),
            maximumEntries: z.number().int().min(0).nullable().default(null),
            maximumDepth: z.number().int().min(0).nullable().default(null),
            allowedValues: z.array(dataValueSchema).max(1024).default([]),
        })
        .default({}),
});
export type DataKeyNode = z.infer<typeof dataKeyNodeSchema>;

export const dataSchemaNodeSchema = z.object({
    ...nodeIdentity,
    id: namespacedIdSchema,
    /** Business schema version persisted in canonical item data. */
    version: z.number().int().min(1).max(1_000_000),
    keys: z.array(dataKeyNodeSchema).max(512),
});
export type DataSchemaNode = z.infer<typeof dataSchemaNodeSchema>;

// --- Presentation blocks -----------------------------------------------------------------------

const valueReferenceSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("data"), key: namespacedIdSchema }),
    z.object({ kind: z.literal("fact"), key: namespacedIdSchema }),
    z.object({ kind: z.literal("literal"), value: dataValueSchema }),
]);

const conditionSchema = z.object({
    operator: conditionOperatorSchema,
    left: valueReferenceSchema,
    right: valueReferenceSchema.nullable().default(null),
});

const compoundFieldTemplateSchema = z.object({
    labelMessage: messageKeySchema,
    valuePath: z.string().min(1).max(256),
    missingMessage: messageKeySchema,
    icon: z.string().min(1).max(128).nullable().default(null),
    format: namespacedIdSchema.nullable().default(null),
});

export type PresentationBlock =
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
      };

const styleRef = z.string().min(1).max(64).nullable().default(null);
const anchorRef = z.string().min(1).max(64).nullable().default(null);
const wrappingRef = z.string().min(1).max(64).nullable().default(null);

// The parsed block is fully defaulted, while the accepted input leaves those fields optional, so
// the schema is typed with distinct output and input sides.
export const presentationBlockSchema: z.ZodType<
    PresentationBlock,
    z.ZodTypeDef,
    unknown
> = z.lazy(() =>
    z.discriminatedUnion("type", [
        z.object({
            uuid: uuidSchema,
            type: z.literal("text"),
            data: namespacedIdSchema,
            style: styleRef,
            anchor: anchorRef,
            wrapping: wrappingRef,
            unbreakable: z.boolean().default(false),
            missingPolicy: missingDataPolicySchema.default("ERROR"),
        }),
        z.object({
            uuid: uuidSchema,
            type: z.literal("field"),
            labelMessage: messageKeySchema,
            data: namespacedIdSchema,
            format: namespacedIdSchema.nullable().default(null),
            icon: z.string().min(1).max(128).nullable().default(null),
            style: styleRef,
            anchor: anchorRef,
            wrapping: wrappingRef,
            missingPolicy: missingDataPolicySchema.default("ERROR"),
        }),
        z.object({
            uuid: uuidSchema,
            type: z.literal("description"),
            message: messageKeySchema,
            style: styleRef,
            anchor: anchorRef,
            wrapping: wrappingRef,
        }),
        z.object({
            uuid: uuidSchema,
            type: z.literal("conditional"),
            condition: conditionSchema,
            thenBlocks: z.array(presentationBlockSchema).max(128),
            otherwiseBlocks: z.array(presentationBlockSchema).max(128),
            style: styleRef,
            anchor: anchorRef,
        }),
        z.object({
            uuid: uuidSchema,
            type: z.literal("repeat"),
            data: namespacedIdSchema,
            maximumElements: z.number().int().min(1).max(4096),
            template: compoundFieldTemplateSchema,
            style: styleRef,
            anchor: anchorRef,
            missingPolicy: missingDataPolicySchema.default("ERROR"),
        }),
        z.object({
            uuid: uuidSchema,
            type: z.literal("nestedItemList"),
            style: styleRef,
            anchor: anchorRef,
        }),
    ]),
);

// --- Items -------------------------------------------------------------------------------------

const dataAssignmentSchema = z.object({
    key: namespacedIdSchema,
    value: dataValueSchema,
});

const dataGeneratorSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unixMillis"), key: namespacedIdSchema }),
    z.object({
        kind: z.literal("randomDecimal"),
        key: namespacedIdSchema,
        minimum: decimalStringSchema,
        maximum: decimalStringSchema,
        scale: z.number().int().min(0).max(32),
    }),
]);

export const itemNodeSchema = z.object({
    ...nodeIdentity,
    /** Path half of the item key; the document namespace supplies the other half. */
    id: idPathSchema,
    enabled: z.boolean(),
    definition: z.object({
        material: namespacedIdSchema,
        baseComponents: z
            .array(z.object({ id: namespacedIdSchema, value: dataValueSchema }))
            .max(256)
            .default([]),
        contentComponent: nestedContentComponentSchema.nullable().default(null),
        contents: z
            .array(
                z.object({
                    item: namespacedIdSchema,
                    amount: z.number().int().min(1).max(1024),
                }),
            )
            .max(256)
            .default([]),
        definitionData: z.array(dataAssignmentSchema).max(256).default([]),
        instance: z.object({
            mode: itemInstanceModeSchema,
            idGenerator: instanceIdGeneratorSchema.nullable().default(null),
            schemas: z
                .array(
                    z.object({
                        id: namespacedIdSchema,
                        version: z.number().int().min(1).max(1_000_000),
                    }),
                )
                .max(64),
            defaults: z.array(dataAssignmentSchema).max(256).default([]),
            generators: z.array(dataGeneratorSchema).max(64).default([]),
        }),
    }),
    presentation: z.object({
        layout: namespacedIdSchema,
        theme: namespacedIdSchema,
        nameMessage: messageKeySchema,
        blocks: z.array(presentationBlockSchema).max(128),
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
export const accessPolicyNodeSchema = z.object({
    ...nodeIdentity,
    id: namespacedIdSchema,
    subject: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("item"), item: idPathSchema }),
        z.object({ kind: z.literal("dataKey"), dataKey: namespacedIdSchema }),
    ]),
    presentationReadable: z.boolean(),
    apiReadable: z.boolean(),
    apiWritable: z.boolean(),
});
export type AccessPolicyNode = z.infer<typeof accessPolicyNodeSchema>;

// --- Document ----------------------------------------------------------------------------------

export const PROJECT_DOCUMENT_SCHEMA_VERSION = 1;

export const projectDocumentSchema = z.object({
    schemaVersion: z.literal(PROJECT_DOCUMENT_SCHEMA_VERSION),
    documentId: uuidSchema,
    /** Default namespace applied to item paths. */
    namespace: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9_.-]+$/),
    defaultLocale: localeSchema,
    budgets: budgetsSchema,
    formats: z.array(formatNodeSchema).max(512),
    locales: z.array(localeNodeSchema).max(128),
    fonts: z.array(fontNodeSchema).max(128),
    glyphs: z.array(glyphNodeSchema).max(4096),
    bitmaps: z.array(bitmapNodeSchema).max(1024),
    assetProfiles: z.array(assetProfileNodeSchema).max(128),
    resourcePackBindings: z.array(resourcePackBindingNodeSchema).max(128),
    tooltipStyles: z.array(tooltipStyleNodeSchema).max(128),
    spacing: spacingNodeSchema.nullable(),
    viewerFacts: z.array(viewerFactNodeSchema).max(256),
    layouts: z.array(layoutNodeSchema).max(256),
    themes: z.array(themeNodeSchema).max(256),
    dataSchemas: z.array(dataSchemaNodeSchema).max(256),
    items: z.array(itemNodeSchema).max(4096),
    accessPolicies: z.array(accessPolicyNodeSchema).max(4096),
    extensions: z.record(z.string().max(128), z.unknown()).optional(),
});
export type ProjectDocument = z.infer<typeof projectDocumentSchema>;

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

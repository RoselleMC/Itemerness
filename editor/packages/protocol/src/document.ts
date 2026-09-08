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

export const budgetsSchema = z.strictObject({
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

export const resourcePackBindingNodeSchema = z
    .strictObject({
        ...nodeIdentity,
        id: namespacedIdSchema,
        enabled: z.boolean(),
        packId: uuidSchema.nullable().default(null),
        sha1: z.string().nullable().default(null),
        assetProfile: namespacedIdSchema,
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
    constraints: z
        .strictObject({
            minimum: decimalStringSchema.nullable().default(null),
            maximum: decimalStringSchema.nullable().default(null),
            scale: z.number().int().min(0).max(32).nullable().default(null),
            maximumCodePoints: z.number().int().min(0).nullable().default(null),
            maximumElements: z.number().int().min(0).nullable().default(null),
            maximumEntries: z.number().int().min(0).nullable().default(null),
            maximumDepth: z.number().int().min(0).nullable().default(null),
            allowedValues: z.array(dataValueSchema).default([]),
        })
        .default({}),
});
export type DataKeyNode = z.infer<typeof dataKeyNodeSchema>;

export const dataSchemaNodeSchema = z.strictObject({
    ...nodeIdentity,
    id: namespacedIdSchema,
    /** Business schema version persisted in canonical item data. */
    version: z.number().int().min(1).max(2_147_483_647),
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

const compoundFieldTemplateSchema = z.strictObject({
    labelMessage: messageKeySchema,
    valuePath: z.string().min(1),
    missingMessage: messageKeySchema,
    icon: z.string().min(1).nullable().default(null),
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
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("description"),
            message: messageKeySchema,
            style: styleRef,
            anchor: anchorRef,
            wrapping: wrappingRef,
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("conditional"),
            condition: conditionSchema,
            thenBlocks: z.array(presentationBlockSchema).max(128),
            otherwiseBlocks: z.array(presentationBlockSchema).max(128),
            style: styleRef,
            anchor: anchorRef,
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
        }),
        z.strictObject({
            uuid: uuidSchema,
            type: z.literal("nestedItemList"),
            style: styleRef,
            anchor: anchorRef,
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
        .enum(["server", "1.21.11", "26.1.1", "26.1.2", "26.2"])
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
        dataSchemas: z.array(dataSchemaNodeSchema),
        items: z.array(itemNodeSchema),
        accessPolicies: z.array(accessPolicyNodeSchema).max(0),
        extensions: z.record(z.string().max(128), z.unknown()).optional(),
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
            if (
                document[field] != null &&
                !document[library].some((entry) => entry.id === document[field])
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

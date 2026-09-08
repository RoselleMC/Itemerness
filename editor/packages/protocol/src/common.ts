import { z } from "zod";

/**
 * Shared primitives for the authoring document and the preview wire format.
 *
 * Every enum constant below is spelled exactly as the Kotlin constant it mirrors in
 * `itemerness-core`. Keeping the two spellings identical removes the mapping table that
 * would otherwise be the most likely place for a silent cross-language drift.
 */

/** `namespace:path`, matching the `ItemKey` contract in `itemerness-api`. */
export const namespacedIdSchema = z
    .string()
    .min(3)
    .max(256)
    .regex(
        /^[a-z0-9_.-]{1,64}:[a-z0-9_./-]+$/,
        "expected a lowercase namespace:path identifier",
    );

/** The `path` half of a namespaced id, used where a document node carries its own namespace. */
export const idPathSchema = z
    .string()
    .min(1)
    .max(254)
    .regex(/^[a-z0-9_./-]+$/, "expected a lowercase path segment");

/** Format 2 item IDs may supply their own namespace; format 1 is checked separately. */
export const itemIdSchema = z.union([
    z
        .string()
        .min(1)
        .max(254)
        .regex(/^[a-z0-9_./-]+$/, "expected a lowercase item path"),
    namespacedIdSchema,
]);

/** Translation key, e.g. `item.travel-token.name`. */
export const messageKeySchema = z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "expected a lowercase message key");

/** Minecraft locale directory name, e.g. `en_us`. */
export const localeSchema = z
    .string()
    .min(2)
    .regex(
        /^[a-z]{2}_[a-z]{2}(?:_[a-z0-9]+)?$/,
        "expected a Minecraft locale such as en_us",
    );

/**
 * 64-bit integers travel as decimal strings. JSON numbers silently lose precision past 2^53,
 * and the canonical hash must survive a round trip through the JVM `Long` codec unchanged.
 */
export const longStringSchema = z
    .string()
    .regex(
        /^-?(0|[1-9][0-9]{0,18})$/,
        "expected a 64-bit integer in decimal form",
    );

/** Arbitrary-precision decimals travel as strings for the same reason as {@link longStringSchema}. */
export const decimalStringSchema = z
    .string()
    .regex(
        /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/,
        "expected a decimal literal",
    );

export const uuidSchema = z.string().uuid();

/** Signed pixel geometry. Mirrors `VisualBoundsSource`. */
export const visualBoundsSchema = z
    .strictObject({
        left: z.number().finite(),
        right: z.number().finite(),
        top: z.number().finite(),
        bottom: z.number().finite(),
    })
    .refine(
        (bounds) => bounds.right >= bounds.left && bounds.bottom >= bounds.top,
        {
            message: "visual bounds must not be inverted",
        },
    );
export type VisualBounds = z.infer<typeof visualBoundsSchema>;

/** Mirrors `SourceDataValue`. */
export type DataValue =
    | { kind: "null" }
    | { kind: "boolean"; value: boolean }
    | { kind: "integer"; value: string }
    | { kind: "decimal"; value: string }
    | { kind: "string"; value: string }
    | { kind: "list"; values: DataValue[] }
    | { kind: "compound"; entries: Record<string, DataValue> };

export const dataValueSchema: z.ZodType<DataValue> = z.lazy(() =>
    z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("null") }),
        z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
        z.strictObject({ kind: z.literal("integer"), value: longStringSchema }),
        z.strictObject({
            kind: z.literal("decimal"),
            value: decimalStringSchema,
        }),
        z.strictObject({
            kind: z.literal("string"),
            value: z.string(),
        }),
        z.strictObject({
            kind: z.literal("list"),
            values: z.array(dataValueSchema),
        }),
        z.strictObject({
            kind: z.literal("compound"),
            entries: z.record(z.string().max(256), dataValueSchema),
        }),
    ]),
);

/** Mirrors `DataType`. A `null` compound field list denotes an open compound. */
export type DataTypeNode =
    | { kind: "boolean" }
    | { kind: "integer" }
    | { kind: "long" }
    | { kind: "decimal" }
    | { kind: "string" }
    | { kind: "uuid" }
    | { kind: "namespacedKey" }
    | { kind: "list"; element: DataTypeNode }
    | { kind: "compound"; fields: CompoundFieldNode[] | null };

export interface CompoundFieldNode {
    name: string;
    type: DataTypeNode;
    nullable: boolean;
}

export const dataTypeSchema: z.ZodType<DataTypeNode> = z.lazy(() =>
    z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("boolean") }),
        z.strictObject({ kind: z.literal("integer") }),
        z.strictObject({ kind: z.literal("long") }),
        z.strictObject({ kind: z.literal("decimal") }),
        z.strictObject({ kind: z.literal("string") }),
        z.strictObject({ kind: z.literal("uuid") }),
        z.strictObject({ kind: z.literal("namespacedKey") }),
        z.strictObject({ kind: z.literal("list"), element: dataTypeSchema }),
        z.strictObject({
            kind: z.literal("compound"),
            fields: z
                .array(
                    z.strictObject({
                        name: z.string().min(1).max(256),
                        type: dataTypeSchema,
                        nullable: z.boolean(),
                    }),
                )
                .nullable(),
        }),
    ]),
);

export const dataScopeSchema = z.enum(["DEFINITION", "INSTANCE"]);
export type DataScope = z.infer<typeof dataScopeSchema>;

export const overflowPolicySchema = z.enum([
    "ERROR",
    "ELLIPSIS",
    "ALLOW_OVERFLOW",
]);
export type OverflowPolicy = z.infer<typeof overflowPolicySchema>;

export const themeRendererSchema = z.enum([
    "PLAIN",
    "VANILLA_CHARACTER_FRAME",
    "NATIVE_TOOLTIP_STYLE",
    "SEGMENTED_FRAME",
    "BITMAP_CANVAS",
]);
export type ThemeRenderer = z.infer<typeof themeRendererSchema>;

export const vanillaTooltipLinePolicySchema = z.enum([
    "PRESERVE",
    "PRESERVE_OUTSIDE_FRAME",
    "REQUIRE_MANAGED",
]);
export type VanillaTooltipLinePolicy = z.infer<
    typeof vanillaTooltipLinePolicySchema
>;

export const presentationRunKindSchema = z.enum([
    "TEXT",
    "ICON",
    "FRAME",
    "BITMAP",
    "SPACING",
    "WIDTH_ANCHOR",
    "HEIGHT_ANCHOR",
]);
export type PresentationRunKind = z.infer<typeof presentationRunKindSchema>;

export const themeFallbackCodeSchema = z.enum([
    "RESOURCE_PACK_UNAVAILABLE",
    "CAPABILITY_MISSING",
    "METRICS_MISMATCH",
    "UNMANAGED_TOOLTIP_LINES",
    "UNSUPPORTED_DIRECTION",
    "MISSING_GLYPH",
    "LAYOUT_OVERFLOW",
    "OUTPUT_BUDGET_EXCEEDED",
    "RENDER_FAILURE",
]);
export type ThemeFallbackCode = z.infer<typeof themeFallbackCodeSchema>;

export const textDirectionSchema = z.enum([
    "LEFT_TO_RIGHT",
    "RIGHT_TO_LEFT",
    "COMPLEX",
]);
export type TextDirection = z.infer<typeof textDirectionSchema>;

export const missingDataPolicySchema = z.enum(["ERROR", "OMIT"]);
export type MissingDataPolicy = z.infer<typeof missingDataPolicySchema>;

export const fieldValueAlignmentSchema = z.enum(["LEFT", "RIGHT"]);
export type FieldValueAlignment = z.infer<typeof fieldValueAlignmentSchema>;

export const characterFramePresetSchema = z.enum([
    "UNICODE_SINGLE",
    "UNICODE_DOUBLE",
    "ASCII_SAFE",
    "BRACKETED_SECTION",
    "SEPARATOR_ONLY",
]);
export type CharacterFramePreset = z.infer<typeof characterFramePresetSchema>;

export const canvasLayerAnchorSchema = z.enum(["TOP_LEFT", "TOP_RIGHT"]);
export type CanvasLayerAnchor = z.infer<typeof canvasLayerAnchorSchema>;

export const conditionOperatorSchema = z.enum([
    "LESS_THAN",
    "LESS_THAN_OR_EQUAL",
    "GREATER_THAN",
    "GREATER_THAN_OR_EQUAL",
    "EQUALS",
    "NOT_EQUALS",
    "EXISTS",
]);
export type ConditionOperator = z.infer<typeof conditionOperatorSchema>;

export const itemInstanceModeSchema = z.enum(["UNIQUE", "FUNGIBLE"]);
export type ItemInstanceMode = z.infer<typeof itemInstanceModeSchema>;

export const viewerFactTypeSchema = z.enum([
    "LOCALE",
    "BOOLEAN",
    "INTEGER",
    "LONG",
    "DECIMAL",
    "STRING",
    "UUID",
    "NAMESPACED_KEY",
]);
export type ViewerFactType = z.infer<typeof viewerFactTypeSchema>;

export const namespacedKeyFormatModeSchema = z.enum(["PATH", "MESSAGE"]);
export const missingKeyValueSchema = z.enum(["PATH", "FULL_KEY", "ERROR"]);
export const nestedContentComponentSchema = z.enum(["BUNDLE", "CONTAINER"]);
export const instanceIdGeneratorSchema = z.enum(["UUID_V4"]);

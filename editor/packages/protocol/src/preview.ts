import { z } from "zod";
import {
    localeSchema,
    namespacedIdSchema,
    presentationRunKindSchema,
    textDirectionSchema,
    themeFallbackCodeSchema,
    themeRendererSchema,
    visualBoundsSchema,
} from "./common.js";
import { diagnosticSchema } from "./diagnostics.js";
import { contentHash } from "./canonical.js";
import { projectDocumentSchema } from "./document.js";

/**
 * The preview wire format.
 *
 * `display` mirrors `com.iroselle.itemerness.core.presentation.PresentationDisplay` field for
 * field. When the artifact comes from an agent, the browser must rasterize exactly this geometry
 * and must not re-run wrapping or theme fallback of its own: the server already decided, and a
 * second opinion computed in TypeScript would be a different renderer wearing the same badge.
 */

/**
 * How far a given aspect of the preview can honestly be trusted.
 *
 * The UI is required to show one of these per aspect. A single undifferentiated "accurate" claim
 * is forbidden because the four levels fail in genuinely different ways and an editor needs to
 * know which one they are looking at.
 */
export const fidelityLevelSchema = z.enum([
    /** Content, references, conditions, locale and theme selection decided by the real compiler. */
    "exact-structure",
    /** Advances, wrapping and anchors computed from real font metrics. */
    "metric-faithful",
    /** Pixels drawn by a browser canvas from the same glyph textures; sampling may differ. */
    "approximate-raster",
    /** Only the real client can show this. Never claimed as verified. */
    "client-only",
]);
export type FidelityLevel = z.infer<typeof fidelityLevelSchema>;

export const fidelityAspectSchema = z.enum([
    "content",
    "locale",
    "theme-selection",
    "metrics",
    "wrapping",
    "glyph-raster",
    "tooltip-frame",
    "item-icon",
    "positioning",
    "vanilla-extra-lines",
]);
export type FidelityAspect = z.infer<typeof fidelityAspectSchema>;

export const fidelityClaimSchema = z.object({
    aspect: fidelityAspectSchema,
    level: fidelityLevelSchema,
    /** i18n key explaining why this aspect sits at this level. */
    reasonKey: z.string().min(1).max(256),
    params: z
        .record(
            z.string().max(64),
            z.union([z.string().max(512), z.number(), z.boolean()]),
        )
        .default({}),
});
export type FidelityClaim = z.infer<typeof fidelityClaimSchema>;

export const previewRunSchema = z.object({
    text: z.string().max(8_192),
    kind: presentationRunKindSchema,
    unbreakable: z.boolean().default(false),
    style: z.object({
        /** Packed 24-bit RGB, or null to inherit the theme default. */
        color: z.number().int().min(0).max(0xffffff).nullable().default(null),
        font: namespacedIdSchema.nullable().default(null),
        bold: z.boolean().default(false),
        italic: z.boolean().default(false),
        underlined: z.boolean().default(false),
        strikethrough: z.boolean().default(false),
    }),
});
export type PreviewRun = z.infer<typeof previewRunSchema>;

export const previewLineSchema = z.object({
    runs: z.array(previewRunSchema).max(512),
    /** `ceil` of the signed advance sum, matching what `Font.width` would measure. */
    logicalWidthPixels: z.number().int().min(0).max(65_536),
    /** Where ink may actually land, which is not the same rectangle as the logical width. */
    visualBounds: visualBoundsSchema,
});
export type PreviewLine = z.infer<typeof previewLineSchema>;

export const themeFallbackReasonSchema = z.object({
    theme: namespacedIdSchema,
    code: themeFallbackCodeSchema,
    detail: z.string().max(1_024),
});

export const previewDisplaySchema = z.object({
    displayName: previewLineSchema,
    lore: z.array(previewLineSchema).max(256),
    tooltipStyle: namespacedIdSchema.nullable(),
    renderer: themeRendererSchema,
    selectedTheme: namespacedIdSchema,
    requestedTheme: namespacedIdSchema,
    catalogRevision: z.number().int().min(0),
    fallbackReasons: z.array(themeFallbackReasonSchema).max(64).default([]),
});
export type PreviewDisplay = z.infer<typeof previewDisplaySchema>;

/** The viewer context a preview was compiled for. */
export const previewViewerSchema = z.object({
    locale: localeSchema,
    requestedTheme: namespacedIdSchema.nullable().default(null),
    assetProfile: namespacedIdSchema.nullable().default(null),
    capabilities: z.array(namespacedIdSchema).max(64).default([]),
    metricsRevision: namespacedIdSchema.nullable().default(null),
    resourcePackLoaded: z.boolean().default(false),
    managesVanillaTooltipLines: z.boolean().default(false),
    direction: textDirectionSchema.default("LEFT_TO_RIGHT"),
});
export type PreviewViewer = z.infer<typeof previewViewerSchema>;

export const previewOriginSchema = z.enum([
    /** Computed in the browser for instant typing feedback. Never publication evidence. */
    "local",
    /** Replayed from a stored fixture while no agent is connected. */
    "mock",
    /** Produced by a target server running the production compiler. */
    "agent",
]);
export type PreviewOrigin = z.infer<typeof previewOriginSchema>;

export const previewDigestsSchema = z.object({
    /** Hash of the document snapshot this artifact was compiled from. */
    snapshot: z.string().max(128),
    compiler: z.string().max(128).nullable().default(null),
    documentSchema: z.string().max(128).nullable().default(null),
    capability: z.string().max(128).nullable().default(null),
    asset: z.string().max(128).nullable().default(null),
});

export const previewArtifactSchema = z.object({
    schemaVersion: z.literal(1),
    origin: previewOriginSchema,
    itemId: namespacedIdSchema,
    viewer: previewViewerSchema,
    display: previewDisplaySchema.nullable(),
    fidelity: z.array(fidelityClaimSchema).max(32),
    diagnostics: z.array(diagnosticSchema).max(512).default([]),
    digests: previewDigestsSchema,
    /** Server-side compile duration used to enforce and diagnose the preview latency budget. */
    compileMillis: z.number().min(0).nullable().default(null),
    /** Present when the compile was rejected outright. */
    failure: z
        .object({
            code: z.enum([
                "UNKNOWN_ITEM",
                "MISSING_DATA",
                "MISSING_MESSAGE",
                "NO_SAFE_THEME",
                "OUTPUT_BUDGET_EXCEEDED",
                "INVALID_RUNTIME_VALUE",
                "DECODE_FAILED",
                "SNAPSHOT_MISMATCH",
                "DOCUMENT_INVALID",
            ]),
            messageKey: z.string().max(256),
            params: z
                .record(
                    z.string().max(64),
                    z.union([z.string().max(512), z.number(), z.boolean()]),
                )
                .default({}),
        })
        .nullable()
        .default(null),
});
export type PreviewArtifact = z.infer<typeof previewArtifactSchema>;

/** The request the browser sends to have a draft compiled by a target. */
export const previewRequestSchema = z
    .object({
        /**
         * The exact authoring snapshot to compile. Preview is intentionally independent from autosave:
         * a user must be able to see the draft they are typing even while its optimistic save is still
         * in flight or has stopped on a conflict.
         */
        document: projectDocumentSchema,
        itemId: namespacedIdSchema,
        viewer: previewViewerSchema,
        /** Guards against a late response overwriting a newer draft. */
        snapshotHash: z.string().min(1).max(128),
        targetServerId: z.string().max(128).nullable().default(null),
    })
    .superRefine((request, context) => {
        if (contentHash(request.document) !== request.snapshotHash) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["snapshotHash"],
                message: "snapshotHash does not match document",
            });
        }
    });
export type PreviewRequest = z.infer<typeof previewRequestSchema>;

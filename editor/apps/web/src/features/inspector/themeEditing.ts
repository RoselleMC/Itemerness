import {
    themeNodeSchema,
    type ProjectDocument,
    type ThemeNode,
} from "@itemerness/protocol";

export type ThemeGeometryKind =
    "content" | "characterFrame" | "segmentedFrame" | "canvas";
export type ThemePatch = (mutate: (theme: ThemeNode) => ThemeNode) => void;

export function switchThemeRenderer(
    theme: ThemeNode,
    renderer: ThemeNode["renderer"],
): ThemeNode {
    const fixedGeometry =
        renderer === "SEGMENTED_FRAME" || renderer === "BITMAP_CANVAS";
    let extensions = theme.extensions;
    let fallback = theme.fallback;
    let tooltipStyle = theme.tooltipStyle;
    let content = theme.content;
    let requireExactFontMetrics = theme.requireExactFontMetrics;
    let characterFrame = theme.characterFrame;
    const rawState = extensions?.editorRendererState;
    const saved: Record<string, unknown> =
        rawState && typeof rawState === "object" && !Array.isArray(rawState)
            ? { ...(rawState as Record<string, unknown>) }
            : rawState === undefined
              ? {}
              : { previousValue: rawState };
    let retained = false;
    const retain = (key: string, value: unknown) => {
        saved[key] = value;
        retained = true;
    };
    if (renderer === "PLAIN") {
        if (theme.renderer !== "PLAIN" || fallback !== null) {
            retain("fallback", fallback);
        }
        fallback = null;
    } else if (theme.renderer === "PLAIN") {
        if (typeof saved.fallback === "string" || saved.fallback === null)
            fallback = saved.fallback;
    }
    const supportsTooltip = (value: ThemeNode["renderer"]) =>
        value === "NATIVE_TOOLTIP_STYLE" || value === "BITMAP_CANVAS" || value === "SEGMENTED_FRAME";
    if (!supportsTooltip(renderer)) {
        if (supportsTooltip(theme.renderer) || tooltipStyle !== null)
            retain("tooltipStyle", tooltipStyle);
        tooltipStyle = null;
    } else if (
        !supportsTooltip(theme.renderer) &&
        tooltipStyle === null &&
        (typeof saved.tooltipStyle === "string" || saved.tooltipStyle === null)
    )
        tooltipStyle = saved.tooltipStyle;
    if (renderer !== "NATIVE_TOOLTIP_STYLE") {
        if (theme.renderer === "NATIVE_TOOLTIP_STYLE" || content !== null)
            retain("content", content);
        content = null;
    } else if (
        theme.renderer !== "NATIVE_TOOLTIP_STYLE" &&
        content === null &&
        saved.content !== undefined
    ) {
        const parsed = themeNodeSchema.shape.content.safeParse(saved.content);
        if (parsed.success) content = parsed.data;
    }
    if (renderer !== "BITMAP_CANVAS") {
        if (theme.renderer === "BITMAP_CANVAS" || requireExactFontMetrics)
            retain("requireExactFontMetrics", requireExactFontMetrics);
        requireExactFontMetrics = false;
    } else if (
        theme.renderer !== "BITMAP_CANVAS" &&
        !requireExactFontMetrics &&
        typeof saved.requireExactFontMetrics === "boolean"
    )
        requireExactFontMetrics = saved.requireExactFontMetrics;
    if (
        renderer === "VANILLA_CHARACTER_FRAME" &&
        characterFrame &&
        !characterFrame.fallbackBidirectionalText
    ) {
        retain("characterFallbackBidirectionalText", false);
        characterFrame = { ...characterFrame, fallbackBidirectionalText: true };
    }
    if (retained) extensions = { ...extensions, editorRendererState: saved };
    return {
        ...theme,
        ...(extensions === undefined ? {} : { extensions }),
        fallback,
        tooltipStyle,
        content,
        requireExactFontMetrics,
        characterFrame,
        renderer,
        requiresResourcePack:
            renderer !== "PLAIN" && renderer !== "VANILLA_CHARACTER_FRAME",
        vanillaTooltipLines: fixedGeometry
            ? "REQUIRE_MANAGED"
            : renderer === "VANILLA_CHARACTER_FRAME"
              ? "PRESERVE_OUTSIDE_FRAME"
              : theme.vanillaTooltipLines,
    };
}

export function incompatibleThemeSettings(theme: ThemeNode): string[] {
    return [
        theme.renderer !== "NATIVE_TOOLTIP_STYLE" && theme.content !== null
            ? "content"
            : null,
        theme.renderer !== "BITMAP_CANVAS" && theme.requireExactFontMetrics
            ? "requireExactFontMetrics"
            : null,
        theme.renderer !== "NATIVE_TOOLTIP_STYLE" &&
        theme.renderer !== "BITMAP_CANVAS" &&
        theme.renderer !== "SEGMENTED_FRAME" &&
        theme.tooltipStyle !== null
            ? "tooltipStyle"
            : null,
        theme.renderer === "PLAIN" && theme.fallback !== null
            ? "fallback"
            : null,
        theme.renderer === "VANILLA_CHARACTER_FRAME" &&
        theme.characterFrame &&
        !theme.characterFrame.fallbackBidirectionalText
            ? "fallbackBidirectionalText"
            : null,
    ].filter((value): value is string => value !== null);
}

export function availableCanvasGlyphs(document: ProjectDocument) {
    return document.glyphs.filter((glyph) =>
        document.bitmaps.some(
            (bitmap) =>
                bitmap.id === glyph.bitmap && bitmap.baselineVariant !== null,
        ),
    );
}

export function createCanvasLayer(
    document: ProjectDocument,
    canvas: NonNullable<ThemeNode["canvas"]>,
) {
    const glyph = availableCanvasGlyphs(document)[0];
    if (!glyph || canvas.layers.length >= document.budgets.maximumCanvasLayers)
        return null;
    const bitmap = document.bitmaps.find((entry) => entry.id === glyph.bitmap)!;
    return {
        asset: glyph.id,
        anchor: "TOP_LEFT" as const,
        xPixels: 0,
        baselineLine: 0,
        baselineVariant: bitmap.baselineVariant!,
        drawOrder: Math.min(
            1024,
            Math.max(-1, ...canvas.layers.map((layer) => layer.drawOrder)) + 1,
        ),
    };
}

export function initializeThemeGeometry(
    theme: ThemeNode,
    document: ProjectDocument,
    kind: ThemeGeometryKind,
): ThemeNode {
    if (theme[kind]) return theme;
    const width = Math.min(160, document.budgets.maximumWidthPixels);
    const height = Math.min(80, document.budgets.maximumHeightPixels);
    const area = {
        minimumWidthPixels: width,
        maximumWidthPixels: document.budgets.maximumWidthPixels,
        leftPaddingPixels: 0,
        rightPaddingPixels: 0,
    };
    switch (kind) {
        case "content":
            return { ...theme, content: area };
        case "characterFrame":
            return {
                ...theme,
                characterFrame: {
                    ...area,
                    preset: "ASCII_SAFE",
                    alignmentTolerancePixels: 1,
                    maximumLines: document.budgets.maximumLines,
                    fallbackBidirectionalText: true,
                },
            };
        case "segmentedFrame": {
            const glyph = document.glyphs.find(
                (entry) => entry.font === theme.fonts.frame,
            );
            if (!glyph || !document.spacing) return theme;
            const row = { left: glyph.id, fill: glyph.id, right: glyph.id };
            return {
                ...theme,
                segmentedFrame: {
                    ...area,
                    top: { ...row },
                    body: { ...row },
                    bottom: { ...row },
                    connector: null,
                },
            };
        }
        case "canvas": {
            if (!document.spacing) return theme;
            return {
                ...theme,
                canvas: {
                    widthPixels: width,
                    heightPixels: height,
                    maximumWidthPixels: document.budgets.maximumWidthPixels,
                    maximumHeightPixels: document.budgets.maximumHeightPixels,
                    reserveTooltipLines: Math.max(
                        1,
                        Math.min(
                            document.budgets.maximumLines,
                            Math.ceil(height / 10),
                        ),
                    ),
                    layers: [],
                    measuredAdvancePixels: width,
                    finalTooltipWidthPixels: width,
                    rejectNegativeFinalAdvance: true,
                    rejectOutOfBoundsLayer: true,
                    maximumEmittedComponents: Math.min(
                        256,
                        document.budgets.maximumRuns,
                    ),
                    normalizeVisualOrigin: true,
                },
            };
        }
    }
}

export function semanticRoleError(
    value: string,
    existing: readonly string[],
): "invalidRole" | "duplicateRole" | null {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) return "invalidRole";
    return existing.includes(value) ? "duplicateRole" : null;
}

export function numericThemeError(
    raw: string,
    minimum: number,
    maximum: number,
): boolean {
    if (!/^-?\d+$/.test(raw)) return true;
    const value = Number(raw);
    return !Number.isSafeInteger(value) || value < minimum || value > maximum;
}

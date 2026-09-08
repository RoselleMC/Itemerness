import {
    assetPath,
    bitmapProviderGlyphs,
    decodeImage,
    parseFontDefinition,
    parseLocation,
    type DecodedImage,
    type Glyph,
    type MountedPack,
} from "@itemerness/mc-assets";
import {
    bitmapNodeSchema,
    fontNodeSchema,
    glyphNodeSchema,
    projectDocumentSchema,
    type BitmapNode,
    type FontNode,
    type GlyphNode,
    type ProjectDocument,
} from "@itemerness/protocol";
import { assetError, freshSemanticId } from "./assetLibrary.js";

export interface PackFontImport {
    font: FontNode;
    glyphs: GlyphNode[];
    bitmaps: BitmapNode[];
}

// An entire import gets the same 128 MiB RGBA allowance as one decoded image.
export const MAX_FONT_ANALYSIS_PIXELS = 32 * 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export function packFontIds(pack: MountedPack): string[] {
    return pack
        .list("assets/")
        .flatMap((path) => {
            const match = /^assets\/([^/]+)\/font\/(.+)\.json$/.exec(path);
            return match ? [`${match[1]}:${match[2]}`] : [];
        })
        .sort();
}

/** Import only self-contained providers whose metrics this editor can reproduce. */
export function readPackFont(
    pack: MountedPack,
    fontId: string,
): PackFontImport {
    const bytes = pack.read(
        assetPath(parseLocation(fontId), "font/") + ".json",
    );
    if (!bytes) throw new Error("missingFont");
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("documentSize");
    const providers = parseFontDefinition(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        fontId,
    );
    if (
        providers.some(
            (provider) =>
                provider.filter !== null ||
                !["bitmap", "space"].includes(provider.type),
        )
    )
        throw new Error("unsupportedProvider");
    const font = fontNodeSchema.parse({
        uuid: crypto.randomUUID(),
        id: fontId,
        metrics: "explicit",
    });
    const glyphs: GlyphNode[] = [];
    const bitmaps: BitmapNode[] = [];
    const supplied = new Set<number>();
    const used = new Set<string>();
    const images = new Map<string, DecodedImage>();
    const measuredProviders = new Map<string, Map<number, Glyph>>();
    let decodedPixels = 0;
    let analyzedPixels = 0;
    let serializedBytes = 0;
    const account = (value: GlyphNode | BitmapNode) => {
        serializedBytes += new TextEncoder().encode(
            JSON.stringify(value),
        ).length;
        if (serializedBytes > 2 * 1024 * 1024) throw new Error("documentSize");
    };
    const stem = fontId.replace(/[^a-z0-9._-]/g, ".");
    for (const provider of providers) {
        if (provider.type === "space") {
            for (const [codePoint, advancePixels] of provider.advances) {
                if (supplied.has(codePoint)) continue;
                supplied.add(codePoint);
                glyphs.push(
                    glyphNodeSchema.parse({
                        uuid: crypto.randomUUID(),
                        id: `${stem}.u${codePoint.toString(16)}`,
                        font: fontId,
                        codePoint,
                        advancePixels,
                        visualBounds: { left: 0, right: 0, top: 0, bottom: 0 },
                    }),
                );
                account(glyphs.at(-1)!);
            }
        } else if (provider.type === "bitmap") {
            const pending = new Set<number>();
            for (const row of provider.chars)
                for (const character of row) {
                    const codePoint = character.codePointAt(0)!;
                    if (codePoint !== 0 && !supplied.has(codePoint))
                        pending.add(codePoint);
                }
            if (pending.size === 0) continue;
            // Required glyph keys and UUID alone exceed 128 serialized bytes per entry.
            if ((supplied.size + pending.size) * 128 > 2 * 1024 * 1024)
                throw new Error("documentSize");
            const location = parseLocation(provider.file);
            const path = assetPath(location, "textures/");
            let image = images.get(path);
            if (!image) {
                const data = pack.read(path);
                if (!data) throw new Error("missingTexture");
                // Budget IHDR dimensions before decodeImage allocates its RGBA buffers.
                if (
                    data.byteLength >= 33 &&
                    PNG_SIGNATURE.every((byte, index) => data[index] === byte)
                ) {
                    const header = new DataView(
                        data.buffer,
                        data.byteOffset,
                        data.byteLength,
                    );
                    if (
                        header.getUint32(8, false) === 13 &&
                        header.getUint32(12, false) === 0x49484452
                    ) {
                        const pixels =
                            header.getUint32(16, false) *
                            header.getUint32(20, false);
                        if (decodedPixels + pixels > MAX_FONT_ANALYSIS_PIXELS)
                            throw new Error("analysisBudget");
                    }
                }
                image = decodeImage(data, provider.file);
                decodedPixels += image.width * image.height;
                images.set(path, image);
            }
            const key = JSON.stringify(provider);
            let measured = measuredProviders.get(key);
            if (!measured) {
                analyzedPixels += image.width * image.height;
                if (analyzedPixels > MAX_FONT_ANALYSIS_PIXELS)
                    throw new Error("analysisBudget");
                measured = bitmapProviderGlyphs(provider, image, provider.file);
                measuredProviders.set(key, measured);
            }
            for (const [codePoint, glyph] of measured) {
                if (supplied.has(codePoint)) continue;
                supplied.add(codePoint);
                const base = `${location.namespace}.${location.path.replace(/\.png$/, "").replace(/[^a-z0-9._-]/g, ".")}`;
                const id = freshSemanticId(
                    measured.size === 1
                        ? base
                        : `${base}.u${codePoint.toString(16)}`,
                    used,
                );
                used.add(id);
                // Bitmap declarations describe whole textures, not cropped atlas cells.
                const wholeTexture =
                    provider.chars.length === 1 &&
                    [...provider.chars[0]!].length === 1;
                let bitmap: BitmapNode | null = null;
                if (
                    wholeTexture &&
                    provider.ascent >= 0 &&
                    provider.ascent <= provider.height
                ) {
                    const width =
                        (image.width * provider.height) / image.height;
                    if (Number.isInteger(width)) {
                        const parsed = bitmapNodeSchema.safeParse({
                            uuid: crypto.randomUUID(),
                            id,
                            texture: `${location.namespace}:${location.path}`,
                            sourceWidthPixels: image.width,
                            sourceHeightPixels: image.height,
                            renderWidthPixels: width,
                            renderHeightPixels: provider.height,
                            ascentPixels: provider.ascent,
                            visualBounds: glyph.bounds,
                        });
                        if (parsed.success) bitmap = parsed.data;
                    }
                }
                if (bitmap) {
                    account(bitmap);
                    bitmaps.push(bitmap);
                }
                glyphs.push(
                    glyphNodeSchema.parse({
                        uuid: crypto.randomUUID(),
                        id,
                        font: fontId,
                        codePoint,
                        advancePixels: glyph.advancePixels,
                        visualBounds: glyph.bounds,
                        bitmap: bitmap?.id ?? null,
                    }),
                );
                account(glyphs.at(-1)!);
            }
        }
    }
    return { font, glyphs, bitmaps };
}

export interface PackFontProposal {
    document: ProjectDocument;
    added: number;
    existing: number;
    conflicts: string[];
}

function sameBitmap(
    a: BitmapNode | undefined,
    b: BitmapNode | undefined,
): boolean {
    if (!a || !b) return a === b;
    return (
        a.texture === b.texture &&
        a.sourceWidthPixels === b.sourceWidthPixels &&
        a.sourceHeightPixels === b.sourceHeightPixels &&
        a.renderWidthPixels === b.renderWidthPixels &&
        a.renderHeightPixels === b.renderHeightPixels &&
        a.ascentPixels === b.ascentPixels &&
        a.visualBounds.left === b.visualBounds.left &&
        a.visualBounds.right === b.visualBounds.right &&
        a.visualBounds.top === b.visualBounds.top &&
        a.visualBounds.bottom === b.visualBounds.bottom
    );
}

/** Additive by design: mounting a pack never grants permission to rewrite existing declarations. */
export function proposePackFontImport(
    document: ProjectDocument,
    source: PackFontImport,
): PackFontProposal {
    const existingFont = document.fonts.find(
        (font) => font.id === source.font.id,
    );
    if (existingFont && existingFont.metrics !== "explicit")
        throw new Error("fontConflict");
    const fonts = existingFont
        ? document.fonts
        : [...document.fonts, source.font];
    const glyphs = [...document.glyphs];
    const bitmaps = [...document.bitmaps];
    const glyphIds = new Set(glyphs.map((glyph) => glyph.id));
    const bitmapIds = new Set(bitmaps.map((bitmap) => bitmap.id));
    const current = new Map(
        document.glyphs
            .filter((glyph) => glyph.font === source.font.id)
            .map((glyph) => [glyph.codePoint, glyph]),
    );
    let added = 0;
    let existing = 0;
    const conflicts: string[] = [];
    const sourceBitmaps = new Map(
        source.bitmaps
            .filter(
                (bitmap) =>
                    bitmap.renderWidthPixels <=
                        document.budgets.maximumWidthPixels &&
                    bitmap.renderHeightPixels <=
                        document.budgets.maximumHeightPixels,
            )
            .map((bitmap) => [bitmap.id, bitmap]),
    );
    const existingBitmaps = new Map(
        document.bitmaps.map((bitmap) => [bitmap.id, bitmap]),
    );
    for (const glyph of source.glyphs) {
        const previous = current.get(glyph.codePoint);
        if (previous) {
            const a = previous.visualBounds,
                b = glyph.visualBounds;
            if (
                previous.advancePixels === glyph.advancePixels &&
                a.left === b.left &&
                a.right === b.right &&
                a.top === b.top &&
                a.bottom === b.bottom &&
                sameBitmap(
                    previous.bitmap
                        ? existingBitmaps.get(previous.bitmap)
                        : undefined,
                    glyph.bitmap ? sourceBitmaps.get(glyph.bitmap) : undefined,
                )
            )
                existing++;
            else conflicts.push(previous.id);
            continue;
        }
        const bitmap = glyph.bitmap
            ? sourceBitmaps.get(glyph.bitmap)
            : undefined;
        const bitmapId = bitmap ? freshSemanticId(bitmap.id, bitmapIds) : null;
        if (bitmap && bitmapId) {
            bitmapIds.add(bitmapId);
            bitmaps.push({ ...bitmap, id: bitmapId });
        }
        const id = freshSemanticId(glyph.id, glyphIds);
        glyphIds.add(id);
        glyphs.push({ ...glyph, id, bitmap: bitmapId });
        added++;
    }
    const next = { ...document, fonts, glyphs, bitmaps };
    for (const glyph of glyphs.slice(document.glyphs.length)) {
        const error = assetError(next, "glyphs", glyph);
        if (error) throw new Error(error);
    }
    for (const bitmap of bitmaps.slice(document.bitmaps.length)) {
        const error = assetError(next, "bitmaps", bitmap);
        if (error) throw new Error(error);
    }
    projectDocumentSchema.parse(next);
    if (
        new TextEncoder().encode(JSON.stringify(next)).length >
        2 * 1024 * 1024 - 1024
    )
        throw new Error("documentSize");
    return { document: next, added, existing, conflicts };
}

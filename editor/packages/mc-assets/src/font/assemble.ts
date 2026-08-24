import type { Diagnostic } from "@itemerness/protocol";
import { decodeImage } from "../image.js";
import {
    assetPath,
    locationToString,
    parseLocation,
    type PackStack,
} from "../pack.js";
import { bitmapProviderGlyphs } from "./bitmap.js";
import type { Glyph } from "./glyph.js";
import {
    DEFAULT_FONT_OPTIONS,
    type FontOptions,
    type FontProvider,
    parseFontDefinition,
    providerEnabled,
} from "./providers.js";
import {
    applySizeOverrides,
    parseUnihexArchive,
    unihexCrop,
    unihexGlyph,
} from "./unihex.js";

/**
 * Assembles a font from the mounted pack stack.
 *
 * The walk mirrors the client: providers are visited in declaration order and the first one that
 * supplies a code point wins; `reference` providers are expanded in place and loaded at most once
 * however many times they are included.
 */

export interface FontTable {
    readonly fontId: string;
    readonly glyphs: ReadonlyMap<number, Glyph>;
    /** Providers that were visited, in effective order, for the metrics inspector. */
    readonly providerTrace: readonly string[];
    /**
     * True when at least one provider could not be measured (`ttf`, or a type this build does not
     * know). Any font in this state must not be presented as metric-faithful.
     */
    readonly metricsIncomplete: boolean;
    readonly diagnostics: readonly Diagnostic[];
}

function diagnostic(
    code: string,
    messageKey: string,
    params: Record<string, string | number | boolean>,
    severity: Diagnostic["severity"] = "ERROR",
): Diagnostic {
    return {
        code,
        severity,
        origin: "browser",
        messageKey,
        params,
        pointer: null,
        nodeUuid: null,
        businessId: null,
        targetServerId: null,
        fixKey: null,
    };
}

interface AssembleState {
    readonly glyphs: Map<number, Glyph>;
    readonly diagnostics: Diagnostic[];
    readonly providerTrace: string[];
    readonly visitedFonts: Set<string>;
    metricsIncomplete: boolean;
}

/** First-wins insertion, matching `put_first` in the metrics generator. */
function putFirst(
    target: Map<number, Glyph>,
    source: ReadonlyMap<number, Glyph>,
): void {
    for (const [codePoint, glyph] of source) {
        if (!target.has(codePoint)) target.set(codePoint, glyph);
    }
}

function readDefinition(
    stack: PackStack,
    fontId: string,
): readonly FontProvider[] | null {
    const location = parseLocation(fontId);
    const path = assetPath({
        namespace: location.namespace,
        path: `font/${location.path}.json`,
    });
    const bytes = stack.read(path);
    if (!bytes) return null;
    return parseFontDefinition(
        JSON.parse(new TextDecoder().decode(bytes)),
        path,
    );
}

function visitProvider(
    stack: PackStack,
    provider: FontProvider,
    options: FontOptions,
    state: AssembleState,
): void {
    if (!providerEnabled(provider, options)) return;

    switch (provider.type) {
        case "space": {
            state.providerTrace.push("space");
            const glyphs = new Map<number, Glyph>();
            for (const [codePoint, advance] of provider.advances) {
                glyphs.set(codePoint, {
                    codePoint,
                    advancePixels: advance,
                    boldExtraAdvancePixels: 1,
                    hasInk: false,
                    bounds: { left: 0, right: 0, top: 0, bottom: 0 },
                    raster: null,
                    providerKind: "space",
                });
            }
            putFirst(state.glyphs, glyphs);
            return;
        }
        case "bitmap": {
            const location = parseLocation(provider.file);
            const path = assetPath(location, "textures/");
            state.providerTrace.push(`bitmap ${locationToString(location)}`);
            const bytes = stack.read(path);
            if (!bytes) {
                state.metricsIncomplete = true;
                state.diagnostics.push(
                    diagnostic(
                        "ASSETS.FONT_TEXTURE_MISSING",
                        "diagnostics.assets.font_texture_missing",
                        {
                            texture: path,
                        },
                    ),
                );
                return;
            }
            try {
                putFirst(
                    state.glyphs,
                    bitmapProviderGlyphs(
                        provider,
                        decodeImage(bytes, path),
                        path,
                    ),
                );
            } catch (error) {
                state.metricsIncomplete = true;
                state.diagnostics.push(
                    diagnostic(
                        "ASSETS.FONT_TEXTURE_INVALID",
                        "diagnostics.assets.font_texture_invalid",
                        {
                            texture: path,
                            detail: (error as Error).message,
                        },
                    ),
                );
            }
            return;
        }
        case "unihex": {
            const location = parseLocation(provider.hexFile);
            const path = assetPath(location);
            state.providerTrace.push(`unihex ${locationToString(location)}`);
            const bytes = stack.read(path);
            if (!bytes) {
                state.metricsIncomplete = true;
                state.diagnostics.push(
                    diagnostic(
                        "ASSETS.FONT_HEX_MISSING",
                        "diagnostics.assets.font_hex_missing",
                        { file: path },
                    ),
                );
                return;
            }
            try {
                const sources = parseUnihexArchive(bytes, path);
                const glyphs = new Map<number, Glyph>();
                for (const [codePoint, source] of sources) {
                    const crop = applySizeOverrides(
                        codePoint,
                        unihexCrop(source.rows, source.bitWidth),
                        provider.sizeOverrides,
                    );
                    glyphs.set(codePoint, unihexGlyph(codePoint, source, crop));
                }
                putFirst(state.glyphs, glyphs);
            } catch (error) {
                state.metricsIncomplete = true;
                state.diagnostics.push(
                    diagnostic(
                        "ASSETS.FONT_HEX_INVALID",
                        "diagnostics.assets.font_hex_invalid",
                        {
                            file: path,
                            detail: (error as Error).message,
                        },
                    ),
                );
            }
            return;
        }
        case "reference": {
            const referenced = parseLocation(provider.id);
            const referencedId = locationToString(referenced);
            if (state.visitedFonts.has(referencedId)) return;
            state.visitedFonts.add(referencedId);
            state.providerTrace.push(`reference ${referencedId}`);
            let providers: readonly FontProvider[] | null;
            try {
                providers = readDefinition(stack, referencedId);
            } catch (error) {
                state.metricsIncomplete = true;
                state.diagnostics.push(
                    diagnostic(
                        "ASSETS.FONT_DEFINITION_INVALID",
                        "diagnostics.assets.font_definition_invalid",
                        {
                            font: referencedId,
                            detail: (error as Error).message,
                        },
                    ),
                );
                return;
            }
            if (!providers) {
                state.metricsIncomplete = true;
                state.diagnostics.push(
                    diagnostic(
                        "ASSETS.FONT_REFERENCE_MISSING",
                        "diagnostics.assets.font_reference_missing",
                        {
                            font: referencedId,
                        },
                    ),
                );
                return;
            }
            for (const nested of providers)
                visitProvider(stack, nested, options, state);
            return;
        }
        case "ttf": {
            state.providerTrace.push(`ttf ${provider.file}`);
            state.metricsIncomplete = true;
            state.diagnostics.push(
                diagnostic(
                    "ASSETS.FONT_TTF_UNSUPPORTED",
                    "diagnostics.assets.font_ttf_unsupported",
                    {
                        file: provider.file,
                    },
                ),
            );
            return;
        }
        default: {
            state.providerTrace.push(`unknown ${provider.rawType}`);
            state.metricsIncomplete = true;
            state.diagnostics.push(
                diagnostic(
                    "ASSETS.FONT_PROVIDER_UNKNOWN",
                    "diagnostics.assets.font_provider_unknown",
                    {
                        provider: provider.rawType,
                    },
                ),
            );
        }
    }
}

/** Builds one font from the mounted stack. Returns an empty table when the font does not exist. */
export function assembleFont(
    stack: PackStack,
    fontId: string,
    options: FontOptions = DEFAULT_FONT_OPTIONS,
): FontTable {
    const state: AssembleState = {
        glyphs: new Map(),
        diagnostics: [],
        providerTrace: [],
        visitedFonts: new Set([locationToString(parseLocation(fontId))]),
        metricsIncomplete: false,
    };

    let providers: readonly FontProvider[] | null;
    try {
        providers = readDefinition(stack, fontId);
    } catch (error) {
        return {
            fontId,
            glyphs: state.glyphs,
            providerTrace: state.providerTrace,
            metricsIncomplete: true,
            diagnostics: [
                diagnostic(
                    "ASSETS.FONT_DEFINITION_INVALID",
                    "diagnostics.assets.font_definition_invalid",
                    {
                        font: fontId,
                        detail: (error as Error).message,
                    },
                ),
            ],
        };
    }
    if (!providers) {
        return {
            fontId,
            glyphs: state.glyphs,
            providerTrace: state.providerTrace,
            metricsIncomplete: true,
            diagnostics: [
                diagnostic(
                    "ASSETS.FONT_DEFINITION_MISSING",
                    "diagnostics.assets.font_definition_missing",
                    { font: fontId },
                    "WARNING",
                ),
            ],
        };
    }

    for (const provider of providers)
        visitProvider(stack, provider, options, state);

    return {
        fontId,
        glyphs: state.glyphs,
        providerTrace: state.providerTrace,
        metricsIncomplete: state.metricsIncomplete,
        diagnostics: state.diagnostics,
    };
}

/** Caches assembled fonts for one pack stack. */
export class FontLibrary {
    private readonly cache = new Map<string, FontTable>();

    constructor(
        readonly stack: PackStack,
        readonly options: FontOptions = DEFAULT_FONT_OPTIONS,
    ) {}

    get(fontId: string): FontTable {
        const key = locationToString(parseLocation(fontId));
        const cached = this.cache.get(key);
        if (cached) return cached;
        const table = assembleFont(this.stack, key, this.options);
        this.cache.set(key, table);
        return table;
    }

    /** Fonts declared anywhere in the stack, for the asset browser. */
    availableFonts(): readonly string[] {
        const found = new Set<string>();
        for (const path of this.stack.listAll("assets/")) {
            const match = /^assets\/([a-z0-9_.-]+)\/font\/(.+)\.json$/.exec(
                path,
            );
            if (match) found.add(`${match[1]}:${match[2]}`);
        }
        return [...found].sort();
    }
}

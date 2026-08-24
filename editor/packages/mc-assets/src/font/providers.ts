/**
 * Parsing for `assets/<namespace>/font/<name>.json`.
 *
 * Provider order is significant and is not the order people usually assume. Minecraft resolves a
 * code point by walking the list from the first provider and taking the first one that supplies a
 * non-blank glyph. That is why vanilla lists `include/space` before the ASCII bitmaps: U+0020 must
 * take its advance from the space provider, not from the blank cell in `ascii.png`.
 *
 * The same first-wins rule is what `tools/font-metrics/generate_minecraft_font_metrics.py` encodes
 * as `put_first`, so the browser and the generated artifact agree by construction.
 */

export class FontDefinitionError extends Error {}

export interface FontFilter {
    readonly uniform?: boolean;
    readonly jp?: boolean;
}

export interface BitmapProvider {
    readonly type: "bitmap";
    readonly filter: FontFilter | null;
    /** Resource location of the texture, resolved under `assets/<ns>/textures/`. */
    readonly file: string;
    readonly height: number;
    readonly ascent: number;
    /** One string per texture row; each is split into Unicode scalars, not UTF-16 units. */
    readonly chars: readonly string[];
}

export interface SpaceProvider {
    readonly type: "space";
    readonly filter: FontFilter | null;
    readonly advances: ReadonlyMap<number, number>;
}

export interface UnihexSizeOverride {
    readonly from: number;
    readonly to: number;
    readonly left: number;
    readonly right: number;
}

export interface UnihexProvider {
    readonly type: "unihex";
    readonly filter: FontFilter | null;
    /** Resource location of a zip of `.hex` files, resolved under `assets/<ns>/`. */
    readonly hexFile: string;
    readonly sizeOverrides: readonly UnihexSizeOverride[];
}

export interface ReferenceProvider {
    readonly type: "reference";
    readonly filter: FontFilter | null;
    readonly id: string;
}

/**
 * TrueType providers are parsed but never measured.
 *
 * Reproducing FreeType hinting and Minecraft's oversampling in a browser would produce advances
 * that look right and are subtly wrong, which is worse than admitting the gap. Vanilla does not
 * use this provider; a pack that does gets an explicit diagnostic and an unknown-metrics marking.
 */
export interface TrueTypeProvider {
    readonly type: "ttf";
    readonly filter: FontFilter | null;
    readonly file: string;
}

export interface UnknownProvider {
    readonly type: "unknown";
    readonly filter: FontFilter | null;
    readonly rawType: string;
}

export type FontProvider =
    | BitmapProvider
    | SpaceProvider
    | UnihexProvider
    | ReferenceProvider
    | TrueTypeProvider
    | UnknownProvider;

/** Splits a string into Unicode scalars, so surrogate pairs count as one character. */
export function unicodeScalars(value: string): number[] {
    return [...value].map((character) => character.codePointAt(0)!);
}

function readFilter(raw: unknown): FontFilter | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "object")
        throw new FontDefinitionError("Provider filter must be an object");
    const record = raw as Record<string, unknown>;
    const filter: { uniform?: boolean; jp?: boolean } = {};
    if (typeof record.uniform === "boolean") filter.uniform = record.uniform;
    if (typeof record.jp === "boolean") filter.jp = record.jp;
    return filter;
}

function requireString(
    record: Record<string, unknown>,
    key: string,
    label: string,
): string {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new FontDefinitionError(`${label} is missing a string "${key}"`);
    }
    return value;
}

function requireInteger(
    record: Record<string, unknown>,
    key: string,
    label: string,
): number {
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new FontDefinitionError(
            `${label} is missing an integer "${key}"`,
        );
    }
    return value;
}

function parseProvider(raw: unknown, label: string): FontProvider {
    if (typeof raw !== "object" || raw === null) {
        throw new FontDefinitionError(
            `${label} contains a provider that is not an object`,
        );
    }
    const record = raw as Record<string, unknown>;
    const filter = readFilter(record.filter);
    const type = record.type;
    if (typeof type !== "string")
        throw new FontDefinitionError(
            `${label} contains a provider without a type`,
        );

    switch (type) {
        case "bitmap": {
            const chars = record.chars;
            if (
                !Array.isArray(chars) ||
                chars.length === 0 ||
                chars.some((row) => typeof row !== "string")
            ) {
                throw new FontDefinitionError(
                    `${label} bitmap provider needs a non-empty "chars" array of strings`,
                );
            }
            const height =
                record.height === undefined
                    ? 8
                    : requireInteger(record, "height", label);
            return {
                type: "bitmap",
                filter,
                file: requireString(record, "file", label),
                height,
                ascent: requireInteger(record, "ascent", label),
                chars: chars as string[],
            };
        }
        case "space": {
            const advances = record.advances;
            if (typeof advances !== "object" || advances === null) {
                throw new FontDefinitionError(
                    `${label} space provider needs an "advances" object`,
                );
            }
            const parsed = new Map<number, number>();
            for (const [character, advance] of Object.entries(
                advances as Record<string, unknown>,
            )) {
                const scalars = unicodeScalars(character);
                if (scalars.length !== 1) {
                    throw new FontDefinitionError(
                        `${label} space advance key must be one Unicode scalar`,
                    );
                }
                if (typeof advance !== "number" || !Number.isFinite(advance)) {
                    throw new FontDefinitionError(
                        `${label} space advance for ${character} is not a number`,
                    );
                }
                parsed.set(scalars[0]!, advance);
            }
            return { type: "space", filter, advances: parsed };
        }
        case "unihex": {
            const rawOverrides = record.size_overrides ?? [];
            if (!Array.isArray(rawOverrides)) {
                throw new FontDefinitionError(
                    `${label} unihex "size_overrides" must be an array`,
                );
            }
            const sizeOverrides = rawOverrides.map((entry) => {
                if (typeof entry !== "object" || entry === null) {
                    throw new FontDefinitionError(
                        `${label} unihex size override must be an object`,
                    );
                }
                const override = entry as Record<string, unknown>;
                const from = unicodeScalars(
                    requireString(override, "from", label),
                );
                const to = unicodeScalars(requireString(override, "to", label));
                if (from.length !== 1 || to.length !== 1) {
                    throw new FontDefinitionError(
                        `${label} unihex size override bounds must be single scalars`,
                    );
                }
                return {
                    from: from[0]!,
                    to: to[0]!,
                    left: requireInteger(override, "left", label),
                    right: requireInteger(override, "right", label),
                };
            });
            return {
                type: "unihex",
                filter,
                hexFile: requireString(record, "hex_file", label),
                sizeOverrides,
            };
        }
        case "reference":
            return {
                type: "reference",
                filter,
                id: requireString(record, "id", label),
            };
        case "ttf":
            return {
                type: "ttf",
                filter,
                file: requireString(record, "file", label),
            };
        default:
            return { type: "unknown", filter, rawType: type };
    }
}

/** Parses a font definition document into its ordered provider list. */
export function parseFontDefinition(
    raw: unknown,
    label: string,
): readonly FontProvider[] {
    if (typeof raw !== "object" || raw === null) {
        throw new FontDefinitionError(`${label} is not a JSON object`);
    }
    const providers = (raw as Record<string, unknown>).providers;
    if (!Array.isArray(providers)) {
        throw new FontDefinitionError(`${label} has no "providers" array`);
    }
    return providers.map((provider, index) =>
        parseProvider(provider, `${label}#${index}`),
    );
}

export interface FontOptions {
    /** The client's "Force Unicode Font" setting. */
    readonly uniform: boolean;
    /** The client's Japanese glyph variant setting. */
    readonly jp: boolean;
}

export const DEFAULT_FONT_OPTIONS: FontOptions = { uniform: false, jp: false };

/** Applies a provider's `filter`, which gates it on client font options. */
export function providerEnabled(
    provider: FontProvider,
    options: FontOptions,
): boolean {
    const filter = provider.filter;
    if (!filter) return true;
    if (filter.uniform !== undefined && filter.uniform !== options.uniform)
        return false;
    if (filter.jp !== undefined && filter.jp !== options.jp) return false;
    return true;
}

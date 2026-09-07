import { canonicalize, type PreviewDisplay } from "@itemerness/protocol";

/** Never guess by row index when the server inserted or removed synthetic lines. */
export function alignLineOrigins(
    local: PreviewDisplay,
    origins: readonly (string | null)[],
    display: PreviewDisplay,
): readonly (string | null)[] {
    const source = local.lore.map((line) => canonicalize(line.runs));
    const target = display.lore.map((line) => canonicalize(line.runs));
    if (
        source.length === target.length &&
        source.every((line, index) => line === target[index])
    )
        return origins;
    const matches = new Map<string, string | null>();
    for (const [index, signature] of source.entries()) {
        const origin = origins[index] ?? null;
        matches.set(
            signature,
            matches.has(signature) && matches.get(signature) !== origin
                ? null
                : origin,
        );
    }
    return target.map((signature) => matches.get(signature) ?? null);
}

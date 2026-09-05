import { createHash } from "node:crypto";
import type { ProjectDocument } from "@itemerness/protocol";

/**
 * Binds the authoring document to the resource pack this deployment actually serves.
 *
 * A `NATIVE_TOOLTIP_STYLE` theme only resolves when an enabled binding matches the bytes the viewer
 * loaded; otherwise the capability is unsatisfied and the theme falls back — silently, because a
 * fallback is a legitimate outcome and not an error. The shipped document carries an all-zero
 * placeholder, so out of the box every custom frame renders as character art and the pack's
 * artwork is never seen.
 *
 * The pack id and SHA-1 are deployment facts, not content, which is why they are computed here from
 * the mounted file instead of being committed to the fixture. Nothing else in the document changes.
 */

/**
 * The pack id a Minecraft server derives from a pack's SHA-1.
 *
 * Mirrors `UUID.nameUUIDFromBytes` over the 20 raw digest bytes — a version 3 UUID — which is what
 * `PackUUID.kt` computes on the server. The two must agree or the binding will not match.
 */
export function packIdFromSha1(sha1: string): string {
    const digest = createHash("md5").update(Buffer.from(sha1, "hex")).digest();
    digest[6] = (digest[6]! & 0x0f) | 0x30;
    digest[8] = (digest[8]! & 0x3f) | 0x80;
    const hex = digest.toString("hex");
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join("-");
}

/**
 * Returns `document` with its pack-backed binding repointed at `sha1`.
 *
 * Only a document with exactly one binding for a profile that grants capabilities is rewritten.
 * Two bindings matching the same bytes would make the profile ambiguous and resolve to none at all,
 * so a document that already describes several packs is left for a human to reconcile.
 */
export function withServerResourcePackBinding(
    document: ProjectDocument,
    sha1: string,
): ProjectDocument {
    const capable = new Set(
        document.assetProfiles
            .filter((profile) => profile.capabilities.length > 0)
            .map((profile) => profile.id),
    );
    const indexes = document.resourcePackBindings
        .map((binding, index) => ({ binding, index }))
        .filter((entry) => capable.has(entry.binding.assetProfile));
    const only = indexes.length === 1 ? indexes[0] : null;
    if (!only) return document;

    const packId = packIdFromSha1(sha1);
    if (
        only.binding.enabled &&
        only.binding.packId === packId &&
        only.binding.sha1 === sha1
    ) {
        return document;
    }
    const bindings = [...document.resourcePackBindings];
    bindings[only.index] = {
        ...only.binding,
        enabled: true,
        packId,
        sha1,
    };
    return { ...document, resourcePackBindings: bindings };
}

/** Must match the active Minecraft server and the document's builtin font revisions. */
export const VANILLA_ASSET_VERSION = "1.21.11";

/** Downloads the SHA-1-verified vanilla subset prepared by the control plane. */
export async function fetchVanillaAssets(
    fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
    const response = await fetcher(
        `/api/v1/vanilla-assets/${VANILLA_ASSET_VERSION}/bundle`,
        { cache: "no-store" },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

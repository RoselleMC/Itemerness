import {
    runoRpgCatalogSchema,
    type RunoRpgCatalog,
} from "@itemerness/protocol";

let cachedCatalog: RunoRpgCatalog | null = null;
let pendingCatalog: Promise<RunoRpgCatalog> | null = null;

async function requestCatalog(): Promise<RunoRpgCatalog> {
    const response = await fetch("/api/v1/runorpg/catalog", {
        cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = runoRpgCatalogSchema.safeParse(await response.json());
    if (!parsed.success) {
        throw new Error(
            parsed.error.issues[0]?.message ?? "invalid RunoRPG catalog",
        );
    }
    cachedCatalog = parsed.data;
    return parsed.data;
}

/** One in-memory catalog per editor session. A force read is reserved for explicit reloads/saves. */
export function loadRunoRpgCatalog(force = false): Promise<RunoRpgCatalog> {
    if (!force && cachedCatalog) return Promise.resolve(cachedCatalog);
    if (!force && pendingCatalog) return pendingCatalog;
    const request = requestCatalog().finally(() => {
        if (pendingCatalog === request) pendingCatalog = null;
    });
    pendingCatalog = request;
    return request;
}

export function replaceCachedRunoRpgCatalog(catalog: RunoRpgCatalog): void {
    cachedCatalog = catalog;
}

export function resetRunoRpgCatalogCache(): void {
    cachedCatalog = null;
    pendingCatalog = null;
}

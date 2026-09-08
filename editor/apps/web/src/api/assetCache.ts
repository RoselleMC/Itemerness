interface CacheEntry {
    bytes: Uint8Array;
    sha1: string;
}

export async function assetDigest(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-1", new Uint8Array(bytes));
    return [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
}

function database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("itemerness-assets", 1);
        request.onupgradeneeded = () =>
            request.result.createObjectStore("bundles");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("ASSET_CACHE_BLOCKED"));
    });
}

export async function cachedAsset(key: string): Promise<Uint8Array | null> {
    let db: IDBDatabase | undefined;
    try {
        db = await database();
        const entry = await new Promise<CacheEntry | undefined>(
            (resolve, reject) => {
                const request = db!
                    .transaction("bundles")
                    .objectStore("bundles")
                    .get(key);
                request.onsuccess = () =>
                    resolve(request.result as CacheEntry | undefined);
                request.onerror = () => reject(request.error);
            },
        );
        if (
            !entry ||
            !(entry.bytes instanceof Uint8Array) ||
            entry.bytes.length > 128 * 1024 * 1024
        )
            return null;
        return (await assetDigest(entry.bytes)) === entry.sha1
            ? entry.bytes
            : null;
    } catch {
        return null;
    } finally {
        db?.close();
    }
}

export async function cacheAsset(
    key: string,
    bytes: Uint8Array,
): Promise<boolean> {
    let db: IDBDatabase | undefined;
    try {
        const sha1 = await assetDigest(bytes);
        db = await database();
        await new Promise<void>((resolve, reject) => {
            const tx = db!.transaction("bundles", "readwrite");
            tx.objectStore("bundles").put(
                { bytes, sha1 } satisfies CacheEntry,
                key,
            );
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        return true;
    } catch {
        return false;
    } finally {
        db?.close();
    }
}

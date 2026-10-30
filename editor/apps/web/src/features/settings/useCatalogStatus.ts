import { useEffect, useState } from "react";
import { useConnectionStore } from "../../state/connection.js";
import { useEditorStore } from "../../state/store.js";

/**
 * Whether the server YAML still matches the configuration this draft was imported from.
 * `unknown` means the draft carries no import fingerprint; `unavailable` means the check failed.
 */
export type CatalogStatus =
    | "unsupported"
    | "checking"
    | "current"
    | "changed"
    | "unknown"
    | "unavailable";

/** Someone may edit the YAML while the editor is open; focusing the window rechecks, at most this often. */
const RECHECK_MILLIS = 15_000;

export function useCatalogStatus(ready: boolean): CatalogStatus {
    const client = useConnectionStore((state) => state.client);
    const supported = useConnectionStore(
        (state) => state.info?.capabilities.includes("catalog.status") ?? false,
    );
    const recovering = useConnectionStore((state) => state.recovery !== "none");
    const baseline = useEditorStore(
        (state) => state.document.sourceLayout?.sourceHash ?? null,
    );
    const [result, setResult] = useState<{
        client: object;
        baseline: string;
        status: CatalogStatus;
    } | null>(null);
    const [check, setCheck] = useState(0);
    const active = ready && supported && !recovering && client !== null;

    useEffect(() => {
        if (!active || baseline === null) return;
        const abort = new AbortController();
        const answer = (status: CatalogStatus) =>
            setResult({ client, baseline, status });
        // Results belong to one client and baseline; a reconnect or replacement discards them.
        client
            .catalogStatus(abort.signal)
            .then((status) => {
                if (!abort.signal.aborted)
                    answer(
                        status.sourceHash === baseline ? "current" : "changed",
                    );
            })
            .catch(() => {
                if (!abort.signal.aborted) answer("unavailable");
            });
        return () => abort.abort();
    }, [active, baseline, client, check]);

    useEffect(() => {
        if (!active || baseline === null) return;
        let checked = Date.now();
        const recheck = () => {
            if (Date.now() - checked < RECHECK_MILLIS) return;
            checked = Date.now();
            setCheck((value) => value + 1);
        };
        window.addEventListener("focus", recheck);
        return () => window.removeEventListener("focus", recheck);
    }, [active, baseline]);

    if (!ready || !supported || client === null) return "unsupported";
    if (baseline === null) return "unknown";
    // A focus recheck keeps showing the previous answer instead of flickering to "checking".
    if (result?.client === client && result.baseline === baseline)
        return result.status;
    return "checking";
}

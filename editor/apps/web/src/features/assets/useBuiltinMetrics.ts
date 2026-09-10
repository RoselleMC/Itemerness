import { useLayoutEffect } from "react";
import {
    isMinecraftClientVersion,
    readFontMetricsArtifact,
    type FontMetricsArtifact,
} from "@itemerness/mc-assets";
import { useConnectionStore } from "../../state/connection.js";
import { useEditorStore } from "../../state/store.js";
import v12111 from "../../../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-1.21.11.ifm?url";
import v2611 from "../../../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.1.ifm?url";
import v2612 from "../../../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm?url";
import v262 from "../../../../../../itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.2.ifm?url";

const urls = {
    "1.21.11": v12111,
    "26.1.1": v2611,
    "26.1.2": v2612,
    "26.2": v262,
};
const cache = new Map<string, FontMetricsArtifact>();

export function useBuiltinMetrics() {
    const serverVersion = useConnectionStore(
        (state) => state.info?.minecraftVersion,
    );
    const measurement = useEditorStore(
        (state) => state.document.measurement?.clientVersion,
    );
    const epoch = useEditorStore((state) => state.workspaceEpoch);
    const version =
        measurement && measurement !== "server" ? measurement : serverVersion;
    useLayoutEffect(() => {
        // Never carry a previous server's metric tables into a new workspace.
        const cached = version ? cache.get(version) : undefined;
        useEditorStore.setState({ artifact: cached ?? null });
        if (cached || !version || !isMinecraftClientVersion(version)) return;
        const abort = new AbortController();
        void (async () => {
            try {
                const response = await fetch(urls[version], {
                    signal: abort.signal,
                });
                if (!response.ok) return;
                const artifact = readFontMetricsArtifact(
                    new Uint8Array(await response.arrayBuffer()),
                    version,
                );
                if (abort.signal.aborted) return;
                cache.set(version, artifact);
                useEditorStore.setState({ artifact });
            } catch {
                // The fidelity panel reports unavailable metrics; mounted packs remain usable.
            }
        })();
        return () => abort.abort();
    }, [version, epoch]);
}

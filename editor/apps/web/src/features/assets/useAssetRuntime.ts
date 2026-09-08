import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
    nativePackSource,
    type NativePackSelection,
} from "../../api/packSources.js";
import {
    addPackSources,
    pollPackSources,
    resetAssetMounts,
    schedulePackReload,
    ensureVanilla,
    useAssetMounts,
} from "../../state/assetMounts.js";
import { usePreferences } from "../../state/preferences.js";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { notify } from "../../state/toasts.js";

export function useAssetRuntime(active: boolean) {
    const interval = usePreferences((state) => state.packCheckInterval);
    const epoch = useEditorStore((state) => state.workspaceEpoch);
    const context = useRef({ active, epoch });
    context.current = { active, epoch };
    const version = useConnectionStore((state) => state.info?.minecraftVersion);
    useEffect(() => {
        const timer = setInterval(() => void pollPackSources(), interval);
        return () => clearInterval(timer);
    }, [interval]);
    useEffect(() => {
        return () => resetAssetMounts();
    }, [epoch]);
    useEffect(() => {
        if (active) ensureVanilla(version);
    }, [active, version, epoch]);
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        const listeners = [
            listen<string>("resource-pack-changed", (event) =>
                schedulePackReload(event.payload),
            ),
            listen<NativePackSelection>("resource-pack-dropped", (event) => {
                const source = nativePackSource(event.payload);
                if (disposed || !context.current.active) {
                    if (
                        !useAssetMounts
                            .getState()
                            .sources.some(
                                (mount) => mount.source.id === source.id,
                            )
                    )
                        source.release();
                } else void addPackSources([source], context.current.epoch);
            }),
            listen<string>("resource-pack-drop-error", (event) => {
                if (!disposed && context.current.active)
                    notify(event.payload, "error", "pack-import");
            }),
        ];
        return () => {
            disposed = true;
            for (const listener of listeners)
                void listener.then((stop) => stop());
        };
    }, []);
}

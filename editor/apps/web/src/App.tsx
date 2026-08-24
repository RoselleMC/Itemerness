import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "./state/store.js";
import { Sidebar } from "./features/shell/Sidebar.js";
import { PreviewStage } from "./features/stage/PreviewStage.js";
import { Inspector } from "./features/inspector/Inspector.js";
import { usePreview } from "./features/preview/usePreview.js";
import { AssetPanel } from "./features/assets/AssetPanel.js";
import { LocaleMatrix } from "./features/locales/LocaleMatrix.js";
import { DiagnosticsList } from "./features/diagnostics/DiagnosticsList.js";
import {
    useDocumentSync,
    type DocumentSync,
} from "./features/document/useDocumentSync.js";

/**
 * The shell: item list, stage, inspector.
 *
 * The tooltip is the document, so it sits in the middle at full size and the editing surface reads
 * in its terms. Pack management, the translation matrix, and diagnostics are workflows people
 * enter deliberately and leave — they open as overlays instead of competing with the editing loop
 * for permanent screen space.
 */

type Overlay = "assets" | "translations" | "diagnostics" | null;

export function App() {
    const { t } = useTranslation();
    const documentSync = useDocumentSync();
    if (!documentSync.ready) {
        return (
            <main role="status" data-testid="editor-loading">
                {t("sidebar.documentSync.loading")}
            </main>
        );
    }
    return <EditorWorkspace documentSync={documentSync} />;
}

function EditorWorkspace({ documentSync }: { documentSync: DocumentSync }) {
    const { t } = useTranslation();
    const [overlay, setOverlay] = useState<Overlay>(null);
    const [spritesAvailable, setSpritesAvailable] = useState(false);
    const loadArtifact = useEditorStore((state) => state.loadArtifact);
    const artifact = useEditorStore((state) => state.artifact);

    const preview = usePreview(spritesAvailable);

    useEffect(() => {
        // The metrics artifact is served by the control plane and is why a first-time user gets
        // faithful geometry before mounting anything at all.
        if (artifact) return;
        void (async () => {
            try {
                const response = await fetch("/api/v1/font-metrics/26.1.2");
                if (!response.ok) return;
                loadArtifact(new Uint8Array(await response.arrayBuffer()));
            } catch {
                // Served without a control plane: mounted packs still provide metrics, and the
                // fidelity fold-out reports the downgrade.
            }
        })();
    }, [artifact, loadArtifact]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOverlay(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const handleGeometry = useCallback(
        (_geometry: unknown, sprites: boolean) => {
            setSpritesAvailable(sprites);
        },
        [],
    );

    return (
        <div className="app">
            <Sidebar
                onOpenOverlay={setOverlay}
                documentSync={documentSync.status}
                onResolveDocumentSync={documentSync.resolve}
            />
            <PreviewStage
                preview={preview}
                onGeometry={handleGeometry}
                onOpenDiagnostics={() => setOverlay("diagnostics")}
            />
            <Inspector preview={preview} />

            {overlay ? (
                <div
                    className="overlay-backdrop"
                    onClick={(event) =>
                        event.target === event.currentTarget && setOverlay(null)
                    }
                >
                    <div
                        className="overlay-panel"
                        role="dialog"
                        aria-modal="true"
                    >
                        <button
                            type="button"
                            className="overlay-close"
                            onClick={() => setOverlay(null)}
                            data-testid="close-overlay"
                        >
                            {t("common.close")}
                        </button>
                        {overlay === "assets" ? <AssetPanel /> : null}
                        {overlay === "translations" ? <LocaleMatrix /> : null}
                        {overlay === "diagnostics" ? <DiagnosticsList /> : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

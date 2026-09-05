import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "./state/store.js";
import { Sidebar } from "./features/shell/Sidebar.js";
import { PreviewStage } from "./features/stage/PreviewStage.js";
import { Inspector } from "./features/inspector/Inspector.js";
import { usePreview } from "./features/preview/usePreview.js";
import { AssetPanel } from "./features/assets/AssetPanel.js";
import {
    fetchVanillaAssets,
    VANILLA_ASSET_VERSION,
} from "./features/assets/vanillaAssets.js";
import { LocaleMatrix } from "./features/locales/LocaleMatrix.js";
import { DiagnosticsList } from "./features/diagnostics/DiagnosticsList.js";
import { loadRunoRpgCatalog } from "./features/runorpg/catalogCache.js";
import { serverResourcePackStatusSchema } from "@itemerness/protocol";
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

const INSPECTOR_WIDTH_KEY = "itemerness.inspector-width";
const DEFAULT_INSPECTOR_WIDTH = 372;
const MIN_INSPECTOR_WIDTH = 320;
const MAX_INSPECTOR_WIDTH = 720;
const MIN_STAGE_WIDTH = 360;
const RESIZER_WIDTH = 7;

function clampInspectorWidth(value: number, maximum = MAX_INSPECTOR_WIDTH) {
    return Math.round(
        Math.min(
            Math.max(MIN_INSPECTOR_WIDTH, maximum),
            Math.max(value, MIN_INSPECTOR_WIDTH),
        ),
    );
}

function initialInspectorWidth(): number {
    try {
        const stored = window.localStorage.getItem(INSPECTOR_WIDTH_KEY);
        if (stored === null) return DEFAULT_INSPECTOR_WIDTH;
        const value = Number(stored);
        return Number.isFinite(value)
            ? clampInspectorWidth(value)
            : DEFAULT_INSPECTOR_WIDTH;
    } catch {
        return DEFAULT_INSPECTOR_WIDTH;
    }
}

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
    const [inspectorWidth, setInspectorWidth] = useState(initialInspectorWidth);
    const [resizingInspector, setResizingInspector] = useState(false);
    const appRef = useRef<HTMLDivElement>(null);
    const resizePointer = useRef<number | null>(null);
    const loadArtifact = useEditorStore((state) => state.loadArtifact);
    const artifact = useEditorStore((state) => state.artifact);
    const mountPack = useEditorStore((state) => state.mountPack);
    const setRunoRpgCatalog = useEditorStore(
        (state) => state.setRunoRpgCatalog,
    );
    const automaticPacksRequested = useRef(false);

    const preview = usePreview(spritesAvailable);

    useEffect(() => {
        let cancelled = false;
        void loadRunoRpgCatalog()
            .then((catalog) => {
                if (!cancelled) setRunoRpgCatalog(catalog);
            })
            .catch(() => {
                // The dedicated RPG editor reports catalog errors in context. Itemerness templates
                // remain usable when the live server directory is temporarily unavailable.
            });
        return () => {
            cancelled = true;
        };
    }, [setRunoRpgCatalog]);

    useEffect(() => {
        // The metrics artifact is served by the control plane and is why a first-time user gets
        // faithful geometry before mounting anything at all.
        if (artifact) return;
        void (async () => {
            try {
                const response = await fetch(
                    `/api/v1/font-metrics/${VANILLA_ASSET_VERSION}`,
                );
                if (!response.ok) return;
                loadArtifact(new Uint8Array(await response.arrayBuffer()));
            } catch {
                // Served without a control plane: mounted packs still provide metrics, and the
                // fidelity fold-out reports the downgrade.
            }
        })();
    }, [artifact, loadArtifact]);

    useEffect(() => {
        if (automaticPacksRequested.current) return;
        automaticPacksRequested.current = true;
        void (async () => {
            const errors: string[] = [];

            // Vanilla is the base layer that supplies minecraft:default/uniform, including CJK.
            // The server pack is mounted afterwards because mountPack prepends newer packs, which
            // leaves BetterHud and other server overrides at the same priority as in the client.
            try {
                mountPack(
                    await fetchVanillaAssets(),
                    `vanilla-${VANILLA_ASSET_VERSION}`,
                    "vanilla",
                );
            } catch (error) {
                errors.push(
                    `原版字体资源自动挂载失败：${(error as Error).message}`,
                );
            }

            try {
                const statusResponse = await fetch(
                    "/api/v1/server-assets/resource-pack/status",
                    { cache: "no-store" },
                );
                if (!statusResponse.ok)
                    throw new Error(`HTTP ${statusResponse.status}`);
                const parsed = serverResourcePackStatusSchema.safeParse(
                    await statusResponse.json(),
                );
                if (!parsed.success)
                    throw new Error("服务器资源包状态响应无效");
                if (parsed.data.available) {
                    const response = await fetch(
                        "/api/v1/server-assets/resource-pack",
                        { cache: "no-store" },
                    );
                    if (!response.ok)
                        throw new Error(`HTTP ${response.status}`);
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    mountPack(
                        bytes,
                        parsed.data.name ?? "server-resource-pack.zip",
                    );
                    const mounted = useEditorStore
                        .getState()
                        .packs.find(
                            (slot) => slot.pack.sha1 === parsed.data.sha1,
                        );
                    if (!mounted) {
                        throw new Error("服务器资源包 SHA-1 校验失败");
                    }
                }
            } catch (error) {
                errors.push(
                    `服务器资源包自动挂载失败：${(error as Error).message}`,
                );
            }

            if (errors.length > 0)
                useEditorStore.setState({ mountError: errors.join("\n") });
        })();
    }, [mountPack]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOverlay(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        try {
            window.localStorage.setItem(
                INSPECTOR_WIDTH_KEY,
                String(inspectorWidth),
            );
        } catch {
            // Private browsing can deny storage; resizing still works for the current session.
        }
    }, [inspectorWidth]);

    const maximumInspectorWidth = useCallback(() => {
        const app = appRef.current;
        const sidebar = app?.querySelector<HTMLElement>(".sidebar");
        if (!app || !sidebar) return MAX_INSPECTOR_WIDTH;
        return Math.min(
            MAX_INSPECTOR_WIDTH,
            Math.max(
                MIN_INSPECTOR_WIDTH,
                app.getBoundingClientRect().width -
                    sidebar.getBoundingClientRect().width -
                    MIN_STAGE_WIDTH -
                    RESIZER_WIDTH,
            ),
        );
    }, []);

    const widthFromPointer = useCallback(
        (clientX: number) => {
            const app = appRef.current;
            if (!app) return;
            const right = app.getBoundingClientRect().right;
            setInspectorWidth(
                clampInspectorWidth(right - clientX, maximumInspectorWidth()),
            );
        },
        [maximumInspectorWidth],
    );

    const beginInspectorResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        resizePointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizingInspector(true);
        widthFromPointer(event.clientX);
    };

    const continueInspectorResize = (
        event: ReactPointerEvent<HTMLDivElement>,
    ) => {
        if (resizePointer.current !== event.pointerId) return;
        widthFromPointer(event.clientX);
    };

    const endInspectorResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (resizePointer.current !== event.pointerId) return;
        resizePointer.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setResizingInspector(false);
    };

    const resizeInspectorWithKeyboard = (
        event: ReactKeyboardEvent<HTMLDivElement>,
    ) => {
        const maximum = maximumInspectorWidth();
        let next: number | null = null;
        if (event.key === "ArrowLeft") next = inspectorWidth + 24;
        if (event.key === "ArrowRight") next = inspectorWidth - 24;
        if (event.key === "Home") next = MIN_INSPECTOR_WIDTH;
        if (event.key === "End") next = maximum;
        if (next === null) return;
        event.preventDefault();
        setInspectorWidth(clampInspectorWidth(next, maximum));
    };

    const handleGeometry = useCallback(
        (_geometry: unknown, sprites: boolean) => {
            setSpritesAvailable(sprites);
        },
        [],
    );

    return (
        <div
            className="app"
            ref={appRef}
            data-resizing-inspector={resizingInspector}
            style={
                {
                    "--inspector-width": `${inspectorWidth}px`,
                } as CSSProperties
            }
        >
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
            <div
                className="inspector-resizer"
                role="separator"
                aria-label={t("inspector.resize")}
                aria-orientation="vertical"
                aria-valuemin={MIN_INSPECTOR_WIDTH}
                aria-valuemax={Math.round(maximumInspectorWidth())}
                aria-valuenow={inspectorWidth}
                tabIndex={0}
                data-testid="inspector-resizer"
                onPointerDown={beginInspectorResize}
                onPointerMove={continueInspectorResize}
                onPointerUp={endInspectorResize}
                onPointerCancel={endInspectorResize}
                onKeyDown={resizeInspectorWithKeyboard}
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
                        {overlay === "diagnostics" ? (
                            <DiagnosticsList preview={preview} />
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

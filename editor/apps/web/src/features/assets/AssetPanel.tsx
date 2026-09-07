import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Download,
    GripVertical,
    ShieldCheck,
    Trash2,
    Upload,
    ArrowUp,
    ArrowDown,
} from "lucide-react";
import {
    crossCheckVanillaFonts,
    type CrossCheckReport,
} from "@itemerness/mc-assets";
import { fontLibraryOf, useEditorStore } from "../../state/store.js";
import { useDragReorder } from "../common/dragReorder.js";
import { fetchVanillaBundle } from "../../api/vanillaAssets.js";
import { useConnectionStore } from "../../state/connection.js";
import { describeContext } from "../../state/interface.js";
import { copyAction } from "../common/contextActions.js";

const VANILLA_VERSION = "26.1.2";

/**
 * Mounting resource packs.
 *
 * Files are read with `FileReader` and never uploaded: a resource pack is often unreleased work,
 * and the plugin never receives these bytes. The CDN alternative downloads pinned Mojang assets
 * directly to the editor and verifies their hashes before mounting them.
 */
export function AssetPanel() {
    const { t } = useTranslation();
    const state = useEditorStore();
    const client = useConnectionStore((state) => state.client);
    const current = () =>
        client !== null &&
        useConnectionStore.getState().client === client &&
        useEditorStore.getState().workspaceEpoch === state.workspaceEpoch;
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [busy, setBusy] = useState(false);
    const [reports, setReports] = useState<readonly CrossCheckReport[] | null>(
        null,
    );
    const [checking, setChecking] = useState(false);
    const drag = useDragReorder(
        state.packs.length,
        state.movePackTo,
        t("assets.priority"),
    );

    async function mountFile(file: File, kind: "vanilla" | "resource-pack") {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (current()) state.mountPack(bytes, file.name, kind);
    }

    async function fetchVanilla() {
        setBusy(true);
        try {
            const bytes = await fetchVanillaBundle();
            if (current())
                state.mountPack(bytes, `vanilla-${VANILLA_VERSION}`, "vanilla");
        } catch (error) {
            if (current())
                useEditorStore.setState({
                    mountError: (error as Error).message,
                });
        } finally {
            setBusy(false);
        }
    }

    function runSelfCheck() {
        const library = fontLibraryOf(state.packs);
        if (!library || !state.artifact) return;
        setChecking(true);
        // Deferred a frame so the button can show its busy state before the comparison blocks.
        setTimeout(() => {
            setReports(
                crossCheckVanillaFonts(state.artifact!, (fontId) =>
                    library.get(fontId),
                ),
            );
            setChecking(false);
        }, 0);
    }

    return (
        <section
            className="assets"
            aria-label={t("assets.heading")}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: t("assets.heading"),
                    items: [
                        {
                            id: "import-assets",
                            label: t("assets.import"),
                            icon: Upload,
                            run: () => inputRef.current?.click(),
                        },
                        {
                            id: "fetch-assets",
                            label: t("assets.fetchVanilla", {
                                version: VANILLA_VERSION,
                            }),
                            icon: Download,
                            disabled: busy,
                            run: fetchVanilla,
                        },
                        {
                            id: "check-assets",
                            label: t("assets.selfCheck.run"),
                            icon: ShieldCheck,
                            disabled:
                                !state.packs.length ||
                                !state.artifact ||
                                checking,
                            run: runSelfCheck,
                        },
                    ],
                })
            }
        >
            <div
                className="dropzone"
                data-testid="asset-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                    event.preventDefault();
                    const file = event.dataTransfer.files[0];
                    if (file) void mountFile(file, "resource-pack");
                }}
            >
                <button
                    type="button"
                    className="page-command"
                    onClick={() => inputRef.current?.click()}
                >
                    <Upload size={16} aria-hidden="true" />
                    {t("assets.import")}
                </button>
                <span className="small">.zip / .jar</span>
                <input
                    ref={inputRef}
                    type="file"
                    hidden
                    aria-label={t("assets.import")}
                    accept=".zip,.jar"
                    data-testid="asset-file-input"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file)
                            void mountFile(
                                file,
                                file.name.endsWith(".jar")
                                    ? "vanilla"
                                    : "resource-pack",
                            );
                        event.target.value = "";
                    }}
                />
            </div>

            <button
                type="button"
                className="page-command"
                onClick={() => void fetchVanilla()}
                disabled={busy}
                data-testid="fetch-vanilla"
            >
                <Download size={16} aria-hidden="true" />
                {t("assets.fetchVanilla", { version: VANILLA_VERSION })}
            </button>

            {state.mountError ? (
                <p className="error" data-testid="mount-error">
                    {state.mountError}
                </p>
            ) : null}

            <h3>{t("assets.mounted")}</h3>
            {state.packs.length === 0 ? (
                <p className="muted" data-testid="assets-empty">
                    {t("assets.empty")}
                </p>
            ) : (
                <ol className="pack-list" data-testid="pack-list">
                    {state.packs.map((slot, index) => (
                        <li
                            key={slot.pack.id}
                            {...drag.itemProps(index)}
                            tabIndex={0}
                            data-testid={`pack-${index}`}
                            onContextMenu={(event) =>
                                describeContext(event, {
                                    label: slot.pack.name,
                                    items: [
                                        {
                                            id: "pack-up",
                                            label: t("menus.raisePriority"),
                                            icon: ArrowUp,
                                            disabled: index === 0,
                                            run: () =>
                                                state.movePack(
                                                    slot.pack.id,
                                                    -1,
                                                ),
                                        },
                                        {
                                            id: "pack-down",
                                            label: t("menus.lowerPriority"),
                                            icon: ArrowDown,
                                            disabled:
                                                index ===
                                                state.packs.length - 1,
                                            run: () =>
                                                state.movePack(slot.pack.id, 1),
                                        },
                                        copyAction(
                                            "copy-pack",
                                            t("menus.copyId"),
                                            slot.pack.id,
                                        ),
                                        {
                                            id: "remove-pack",
                                            label: t("assets.remove"),
                                            icon: Trash2,
                                            danger: true,
                                            separator: true,
                                            run: () =>
                                                state.removePack(slot.pack.id),
                                        },
                                    ],
                                })
                            }
                        >
                            <span {...drag.handleProps(index)}>
                                <GripVertical size={16} aria-hidden="true" />
                            </span>
                            <span className="pack-name">{slot.pack.name}</span>
                            <span className="tag">
                                {t(`assets.kind.${slot.pack.kind}`)}
                            </span>
                            <span className="muted small">
                                {t("assets.size", { count: slot.entryCount })}
                            </span>
                            <span className="pack-actions">
                                <button
                                    type="button"
                                    aria-label={t("assets.remove")}
                                    data-tooltip={t("assets.remove")}
                                    onClick={() =>
                                        state.removePack(slot.pack.id)
                                    }
                                >
                                    <Trash2 size={15} aria-hidden="true" />
                                </button>
                            </span>
                        </li>
                    ))}
                </ol>
            )}

            <h3>{t("assets.selfCheck.heading")}</h3>
            <button
                type="button"
                className="page-command"
                onClick={runSelfCheck}
                disabled={
                    state.packs.length === 0 || !state.artifact || checking
                }
                data-testid="run-self-check"
            >
                <ShieldCheck size={16} aria-hidden="true" />
                {checking
                    ? t("assets.selfCheck.running")
                    : t("assets.selfCheck.run")}
            </button>
            {state.packs.length === 0 ? (
                <p className="muted small">
                    {t("assets.selfCheck.unavailable")}
                </p>
            ) : null}
            {reports ? (
                <table className="self-check" data-testid="self-check-results">
                    <thead>
                        <tr>
                            <th>{t("assets.selfCheck.font")}</th>
                            <th>{t("assets.selfCheck.compared")}</th>
                            <th>{t("assets.selfCheck.mismatches")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {reports.map((report) => (
                            <tr
                                key={report.fontId}
                                className={report.matches ? "pass" : "fail"}
                            >
                                <td>{report.fontId}</td>
                                <td>{report.comparedGlyphs}</td>
                                <td>
                                    {report.matches
                                        ? t("assets.selfCheck.pass", {
                                              count: report.comparedGlyphs,
                                          })
                                        : t("assets.selfCheck.fail", {
                                              count: report.mismatches.length,
                                          })}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}
        </section>
    );
}

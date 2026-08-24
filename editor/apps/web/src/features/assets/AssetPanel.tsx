import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    crossCheckVanillaFonts,
    type CrossCheckReport,
} from "@itemerness/mc-assets";
import { fontLibraryOf, useEditorStore } from "../../state/store.js";
import { useDragReorder } from "../common/dragReorder.js";

const VANILLA_VERSION = "26.1.2";

/**
 * Mounting resource packs.
 *
 * Files are read with `FileReader` and never uploaded: a resource pack is often unreleased work,
 * and there is no reason for the control plane to hold a copy just so the browser can measure a
 * glyph. The CDN button is the alternative for editors who do not have a client jar to hand; it
 * asks the control plane to fetch the pinned Mojang files, verify every SHA-1, and hand back only
 * the subset the preview needs.
 */
export function AssetPanel() {
    const { t } = useTranslation();
    const state = useEditorStore();
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
        state.mountPack(bytes, file.name, kind);
    }

    async function fetchVanilla() {
        setBusy(true);
        try {
            const response = await fetch(
                `/api/v1/vanilla-assets/${VANILLA_VERSION}/bundle`,
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            state.mountPack(bytes, `vanilla-${VANILLA_VERSION}`, "vanilla");
        } catch (error) {
            useEditorStore.setState({ mountError: (error as Error).message });
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
        <section className="assets" aria-label={t("assets.heading")}>
            <h2>{t("assets.heading")}</h2>
            <p className="muted">{t("assets.description")}</p>

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
                <span>{t("assets.drop")}</span>
                <input
                    ref={inputRef}
                    type="file"
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
                onClick={() => void fetchVanilla()}
                disabled={busy}
                data-testid="fetch-vanilla"
            >
                {t("assets.fetchVanilla", { version: VANILLA_VERSION })}
            </button>
            <p className="muted small">{t("assets.fetchVanillaHint")}</p>

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
                        <li key={slot.pack.id} {...drag.itemProps(index)}>
                            <span {...drag.handleProps(index)}>⠿</span>
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
                                    onClick={() =>
                                        state.removePack(slot.pack.id)
                                    }
                                >
                                    {t("assets.remove")}
                                </button>
                            </span>
                        </li>
                    ))}
                </ol>
            )}

            <h3>{t("assets.selfCheck.heading")}</h3>
            <p className="muted small">{t("assets.selfCheck.description")}</p>
            <button
                type="button"
                onClick={runSelfCheck}
                disabled={
                    state.packs.length === 0 || !state.artifact || checking
                }
                data-testid="run-self-check"
            >
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

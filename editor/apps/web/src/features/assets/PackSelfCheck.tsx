import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import {
    crossCheckVanillaFonts,
    type CrossCheckReport,
} from "@itemerness/mc-assets";
import { fontLibraryOf, useEditorStore } from "../../state/store.js";
import { notify } from "../../state/toasts.js";

export function PackSelfCheck() {
    const { t } = useTranslation();
    const { packs, artifact, workspaceEpoch } = useEditorStore();
    const [reports, setReports] = useState<{
        packs: typeof packs;
        values: readonly CrossCheckReport[];
    } | null>(null);
    const [busy, setBusy] = useState(false);
    const run = () => {
        const library = fontLibraryOf(packs);
        if (!library || !artifact) return;
        setBusy(true);
        setTimeout(() => {
            try {
                if (
                    useEditorStore.getState().workspaceEpoch !==
                        workspaceEpoch ||
                    useEditorStore.getState().packs !== packs
                )
                    return;
                const values = crossCheckVanillaFonts(artifact, (id) =>
                    library.get(id),
                );
                setReports({ packs, values });
                notify(
                    t(
                        values.every((value) => value.matches)
                            ? "packManager:checkPassed"
                            : "packManager:checkMismatch",
                    ),
                    values.every((value) => value.matches) ? "success" : "info",
                    "pack-check",
                );
            } catch (error) {
                notify(String(error), "error", "pack-check");
            } finally {
                setBusy(false);
            }
        }, 0);
    };
    return (
        <div className="pack-self-check">
            <button
                type="button"
                className="page-command"
                data-testid="run-self-check"
                disabled={!packs.length || !artifact || busy}
                onClick={run}
            >
                <ShieldCheck size={16} />
                {t(busy ? "assets.selfCheck.running" : "assets.selfCheck.run")}
            </button>
            {reports?.packs === packs && (
                <table className="self-check" data-testid="self-check-results">
                    <thead>
                        <tr>
                            <th>{t("assets.selfCheck.font")}</th>
                            <th>{t("assets.selfCheck.compared")}</th>
                            <th>{t("assets.selfCheck.mismatches")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {reports.values.map((report) => (
                            <tr
                                key={report.fontId}
                                className={report.matches ? "pass" : "fail"}
                            >
                                <td>{report.fontId}</td>
                                <td>{report.comparedGlyphs}</td>
                                <td>
                                    {t(
                                        report.matches
                                            ? "assets.selfCheck.pass"
                                            : "assets.selfCheck.fail",
                                        {
                                            count: report.matches
                                                ? report.comparedGlyphs
                                                : report.mismatches.length,
                                        },
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

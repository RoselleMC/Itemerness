import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectDocument } from "@itemerness/protocol";
import { catalogTransferDiff } from "./catalogTransferDiff.js";

export function CatalogImportSummary({
    current,
    candidate,
}: {
    current: ProjectDocument | null;
    candidate: ProjectDocument;
}) {
    const { t } = useTranslation();
    const diff = useMemo(
        () => catalogTransferDiff(current, candidate),
        [current, candidate],
    );
    const changes = (value: {
        added: number;
        removed: number;
        changed: number;
    }) =>
        value.added || value.removed || value.changed
            ? t("catalogTransfer.changes", value)
            : t("catalogTransfer.unchanged");
    const heading = (
        <thead>
            <tr>
                <th scope="col">{t("catalogTransfer.configuration")}</th>
                <th scope="col">{t("catalogTransfer.current")}</th>
                <th scope="col">{t("catalogTransfer.incoming")}</th>
            </tr>
        </thead>
    );
    return (
        <div className="catalog-import-summary">
            {!current && <p>{t("catalogTransfer.noCurrentDocument")}</p>}
            <table className="catalog-settings-diff">
                {heading}
                <tbody>
                    {diff.settings.map(({ key, before, after }) => (
                        <tr key={key} data-testid={`catalog-setting-${key}`}>
                            <th scope="row">
                                {t(`catalogTransfer.settings.${key}`)}
                            </th>
                            <td>
                                {before ??
                                    t(
                                        current
                                            ? "catalogTransfer.unspecified"
                                            : "catalogTransfer.none",
                                    )}
                            </td>
                            <td>{after ?? t("catalogTransfer.unspecified")}</td>
                        </tr>
                    ))}
                    <tr
                        className={
                            diff.enabled.after < diff.enabled.before
                                ? "catalog-enabled-reduction"
                                : undefined
                        }
                        data-testid="catalog-enabled-items"
                    >
                        <th scope="row">{t("catalogTransfer.enabledItems")}</th>
                        <td>{diff.enabled.before}</td>
                        <td>{diff.enabled.after}</td>
                    </tr>
                </tbody>
            </table>
            <p
                className="catalog-message-diff"
                data-testid="catalog-message-diff"
            >
                <strong>{t("catalogTransfer.messages")}</strong>
                <span>{changes(diff.messages)}</span>
            </p>
            <table className="catalog-counts-diff">
                {heading}
                <tbody>
                    {diff.counts.map((entry) => (
                        <tr
                            key={entry.kind}
                            data-testid={`catalog-count-${entry.kind}`}
                        >
                            <th scope="row">
                                {t(`catalogTransfer.counts.${entry.kind}`)}
                                <span className="catalog-count-changes">
                                    {changes(entry)}
                                </span>
                            </th>
                            <td>{entry.before}</td>
                            <td>{entry.after}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

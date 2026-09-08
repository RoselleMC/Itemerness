import { useTranslation } from "react-i18next";
import { useEditorStore } from "../../state/store.js";
import {
    namespaceIssue,
    setProjectNamespace,
} from "../../state/projectSettings.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { SelectField } from "../common/SelectField.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { IntegrationUpgradeButton } from "../inspector/DataIntegrationEditor.js";
import "./project-settings.css";

export function ProjectSettings() {
    const { t } = useTranslation();
    const store = useEditorStore();
    const document = store.document;
    return (
        <section
            className="settings-section project-settings"
            data-testid="project-settings"
        >
            <h3>{t("projectSettings.heading")}</h3>
            <label className="field">
                <span>{t("projectSettings.namespace")}</span>
                <BufferedInput
                    value={document.namespace}
                    owner={`${document.documentId}:namespace`}
                    label={t("projectSettings.namespace")}
                    testId="project-namespace"
                    validate={(namespace) => {
                        const issue = namespaceIssue(
                            useEditorStore.getState().document,
                            namespace,
                        );
                        return issue ? t(`projectSettings.${issue}`) : null;
                    }}
                    onCommit={(namespace) =>
                        store.updateDocument((draft) =>
                            setProjectNamespace(draft, namespace),
                        )
                    }
                />
            </label>
            <label className="field">
                <span>{t("projectSettings.defaultLocale")}</span>
                <SelectField
                    label={t("projectSettings.defaultLocale")}
                    data-testid="project-default-locale"
                    value={document.defaultLocale}
                    options={document.locales.map((locale) => ({
                        value: locale.locale,
                        label: locale.locale,
                    }))}
                    onValueChange={(locale) => {
                        if (commitInlineEditor())
                            store.updateDocument((draft) =>
                                draft.locales.some(
                                    (entry) => entry.locale === locale,
                                )
                                    ? { ...draft, defaultLocale: locale }
                                    : draft,
                            );
                    }}
                />
            </label>
            {document.schemaVersion === 2 ? (
                <>
                    {" "}
                    {(["layout", "theme"] as const).map((kind) => {
                        const field =
                            kind === "layout"
                                ? "defaultLayout"
                                : "defaultTheme";
                        const entries =
                            kind === "layout"
                                ? document.layouts
                                : document.themes;
                        const inheritedCount = document.items.filter(
                            (item) => item.presentation[kind] == null,
                        ).length;
                        return (
                            <label className="field" key={kind}>
                                <span>{t(`projectSettings.${field}`)}</span>
                                <SelectField
                                    label={t(`projectSettings.${field}`)}
                                    data-testid={`project-default-${kind}`}
                                    value={document[field] ?? ""}
                                    options={[
                                        {
                                            value: "",
                                            label: t("inspector.none"),
                                            disabled: inheritedCount > 0,
                                        },
                                        ...entries.map((entry) => ({
                                            value: entry.id,
                                            label: entry.id,
                                        })),
                                    ]}
                                    onValueChange={(value) => {
                                        if (!commitInlineEditor()) return;
                                        store.updateDocument((draft) => {
                                            if (
                                                !value &&
                                                draft.items.some(
                                                    (item) =>
                                                        item.presentation[
                                                            kind
                                                        ] == null,
                                                )
                                            )
                                                return draft;
                                            return {
                                                ...draft,
                                                [field]: value || null,
                                            };
                                        });
                                    }}
                                />
                                {inheritedCount > 0 && (
                                    <span className="muted small">
                                        {t("projectSettings.inheritedCount", {
                                            count: inheritedCount,
                                        })}
                                    </span>
                                )}
                            </label>
                        );
                    })}
                </>
            ) : (
                <>
                    <p className="muted small">{t("projectSettings.legacy")}</p>
                    <IntegrationUpgradeButton document={document} />
                </>
            )}
        </section>
    );
}

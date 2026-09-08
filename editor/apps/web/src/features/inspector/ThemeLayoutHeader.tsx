import { useTranslation } from "react-i18next";
import { useEditorStore } from "../../state/store.js";
import {
    renameThemeLayout,
    themeLayoutIdError,
    themeLayoutReferences,
    type ThemeLayoutKind,
} from "../../state/themeLayoutLibrary.js";
import { runMenuAction } from "../../state/interface.js";
import { BufferedInput } from "../common/BufferedInput.js";
import {
    createThemeLayoutActions,
    themeLayoutActions,
} from "../common/themeLayoutActions.js";
import "./themeLayoutLibrary.css";

export function ThemeLayoutAdd({
    kind,
    testIdPrefix = "",
}: {
    kind: ThemeLayoutKind;
    testIdPrefix?: string;
}) {
    const { t } = useTranslation();
    useEditorStore((state) => state.document[kind].length);
    return (
        <div className="theme-layout-add">
            {createThemeLayoutActions(kind, t).map((action) => (
                <button
                    key={action.id}
                    type="button"
                    className="add-item"
                    disabled={action.disabled}
                    onClick={() => runMenuAction(action)}
                    data-testid={`${testIdPrefix}${action.id}`}
                >
                    {action.icon && <action.icon size={16} />}
                    {action.label}
                </button>
            ))}
        </div>
    );
}

export function ThemeLayoutHeader({
    kind,
    uuid,
}: {
    kind: ThemeLayoutKind;
    uuid: string;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const entry = store.document[kind].find((entry) => entry.uuid === uuid);
    if (!entry) return null;
    const refs = themeLayoutReferences(store.document, kind, entry.id);
    const actions = themeLayoutActions(kind, uuid, t).filter(
        (action) =>
            action.id.startsWith("duplicate-") ||
            action.id.startsWith("delete-"),
    );
    return (
        <section className="theme-layout-header">
            <header className="content-inspector-header">
                <h3>
                    {t(
                        `inspector.${kind === "themes" ? "theme" : "layout"}.heading`,
                    )}
                </h3>
                <div className="content-inspector-actions">
                    {actions.map((action) => (
                        <button
                            key={action.id}
                            type="button"
                            className="icon-button"
                            disabled={action.disabled}
                            aria-label={action.label}
                            data-tooltip={
                                action.disabled && action.danger
                                    ? t("themeLayoutLibrary.inUse")
                                    : action.label
                            }
                            onClick={() => runMenuAction(action)}
                            data-testid={action.id}
                        >
                            {action.icon && <action.icon size={16} />}
                        </button>
                    ))}
                </div>
            </header>
            <label className="field-label">ID</label>
            <BufferedInput
                value={entry.id}
                label={t(`themeLayoutLibrary.id.${kind}`)}
                owner={uuid}
                testId={`${kind}-id`}
                validate={(id) => {
                    const error = themeLayoutIdError(
                        useEditorStore.getState().document,
                        kind,
                        uuid,
                        id,
                    );
                    return error ? t(`themeLayoutLibrary.${error}`) : null;
                }}
                onCommit={(id) => {
                    store.updateDocument((document) =>
                        renameThemeLayout(document, kind, uuid, id),
                    );
                    if (kind === "themes") {
                        store.selectTheme(id);
                        if (
                            useEditorStore.getState().themeOverride === entry.id
                        )
                            store.setThemeOverride(id);
                    } else store.selectLayout(id);
                }}
            />
            {!!refs.length && (
                <details className="theme-layout-references">
                    <summary>
                        {t("themeLayoutLibrary.references", {
                            count: refs.length,
                        })}
                    </summary>
                    <ul>
                        {refs.map((id, index) => (
                            <li key={`${index}:${id}`}>
                                <code>{id}</code>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </section>
    );
}

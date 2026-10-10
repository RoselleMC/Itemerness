import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
    itemKey,
    MAXIMUM_THEME_SELECTOR_CASES,
    type DataKeyNode,
    type ThemeSelectorCase,
    type ThemeSelectorNode,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { describeContext, runMenuAction } from "../../state/interface.js";
import {
    newThemeSelectorCase,
    renameThemeSelector,
    themeSelectorIdError,
    themeSelectorItems,
    themeSelectorReferences,
    updateThemeSelector,
} from "../../state/themeSelectorLibrary.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { SelectField } from "../common/SelectField.js";
import {
    ConditionEditor,
    documentReadableDataKeys,
} from "../common/ConditionEditor.js";
import { itemDataKeys } from "../common/typedValues.js";
import { themeSelectorActions } from "../common/themeLayoutActions.js";
import { DefinitionAction } from "./BaseComponentEditor.js";
import "./themeLayoutLibrary.css";

/**
 * Edits one reusable theme selector. Every change is a document history transaction through
 * the store; the canvas previews the selector because the theme library passes the selected id
 * as the viewer's requested theme.
 */
export function ThemeSelectorInspector({
    selector,
    previewSettings,
}: {
    selector: ThemeSelectorNode;
    previewSettings?: ReactNode;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const document = store.document;
    const update = (
        mutate: (current: ThemeSelectorNode) => ThemeSelectorNode,
    ) =>
        store.updateDocument((draft) =>
            updateThemeSelector(draft, selector.uuid, mutate),
        );
    const updateCases = (
        mutate: (cases: ThemeSelectorCase[]) => ThemeSelectorCase[],
    ) =>
        update((current) => ({
            ...current,
            cases: mutate([...current.cases]),
        }));
    const bound = themeSelectorItems(document, selector.id);
    // Literal samples come from an item that actually uses the selector, preferring the one
    // being edited; the operand list covers every bound item's readable data.
    const sampleItem =
        bound.find(
            (item) => itemKey(document, item) === store.selectedItemId,
        ) ??
        bound[0] ??
        null;
    const dataKeys: DataKeyNode[] = bound.length
        ? [
              ...new Map(
                  bound
                      .flatMap((item) => itemDataKeys(document, item))
                      .filter((key) => key.presentationReadable)
                      .map((key) => [key.id, key]),
              ).values(),
          ]
        : documentReadableDataKeys(document);
    const themeOptions = document.themes.map((theme) => ({
        value: theme.id,
        label: theme.id,
    }));
    const references = themeSelectorReferences(document, selector.id);
    const actions = themeSelectorActions(selector.uuid, t).filter(
        (action) =>
            action.id.startsWith("duplicate-") ||
            action.id.startsWith("delete-"),
    );
    const atBudget = selector.cases.length >= MAXIMUM_THEME_SELECTOR_CASES;
    return (
        <aside
            className="inspector"
            data-testid="theme-selector-inspector"
            aria-label={t("themeSelector.heading")}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: selector.id,
                    items: themeSelectorActions(selector.uuid, t),
                })
            }
        >
            <section className="theme-layout-header">
                <header className="content-inspector-header">
                    <h3>{t("themeSelector.heading")}</h3>
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
                    value={selector.id}
                    label={t("themeSelector.id")}
                    owner={selector.uuid}
                    testId="theme-selector-id"
                    validate={(id) => {
                        const error = themeSelectorIdError(
                            useEditorStore.getState().document,
                            selector.uuid,
                            id,
                        );
                        return error ? t(`themeLayoutLibrary.${error}`) : null;
                    }}
                    onCommit={(id) => {
                        const previous = selector.id;
                        store.updateDocument((draft) =>
                            renameThemeSelector(draft, selector.uuid, id),
                        );
                        store.selectTheme(id);
                        if (
                            useEditorStore.getState().themeOverride === previous
                        )
                            store.setThemeOverride(id);
                    }}
                />
                {!!references.length && (
                    <details className="theme-layout-references">
                        <summary>
                            {t("themeLayoutLibrary.references", {
                                count: references.length,
                            })}
                        </summary>
                        <ul>
                            {references.map((id, index) => (
                                <li key={`${index}:${id}`}>
                                    <code>{id}</code>
                                </li>
                            ))}
                        </ul>
                    </details>
                )}
            </section>

            <section className="theme-selector-cases">
                <p className="muted small">{t("themeSelector.hint")}</p>
                <ol
                    className="theme-selector-case-list"
                    data-testid="theme-selector-cases"
                >
                    {selector.cases.map((entry, index) => (
                        <li
                            // Cases have no identity of their own; position is their identity.
                            key={index}
                            className="theme-selector-case"
                            data-testid={`theme-selector-case-${index}`}
                        >
                            <header className="theme-selector-case-header">
                                <span className="field-label">
                                    {t("themeSelector.case", {
                                        index: index + 1,
                                    })}
                                </span>
                                <div className="definition-row-actions">
                                    <DefinitionAction
                                        label={t("values.moveUp")}
                                        icon={ArrowUp}
                                        testId={`theme-selector-case-${index}-up`}
                                        disabled={index === 0}
                                        onClick={() =>
                                            updateCases((cases) => {
                                                [
                                                    cases[index - 1],
                                                    cases[index],
                                                ] = [
                                                    cases[index]!,
                                                    cases[index - 1]!,
                                                ];
                                                return cases;
                                            })
                                        }
                                    />
                                    <DefinitionAction
                                        label={t("values.moveDown")}
                                        icon={ArrowDown}
                                        testId={`theme-selector-case-${index}-down`}
                                        disabled={
                                            index === selector.cases.length - 1
                                        }
                                        onClick={() =>
                                            updateCases((cases) => {
                                                [
                                                    cases[index],
                                                    cases[index + 1],
                                                ] = [
                                                    cases[index + 1]!,
                                                    cases[index]!,
                                                ];
                                                return cases;
                                            })
                                        }
                                    />
                                    <DefinitionAction
                                        label={t("themeSelector.removeCase")}
                                        icon={Trash2}
                                        testId={`theme-selector-case-${index}-remove`}
                                        onClick={() =>
                                            updateCases((cases) =>
                                                cases.filter(
                                                    (_, position) =>
                                                        position !== index,
                                                ),
                                            )
                                        }
                                    />
                                </div>
                            </header>
                            <p className="field-label">
                                {t("themeSelector.when")}
                            </p>
                            <ConditionEditor
                                document={document}
                                item={sampleItem}
                                dataKeys={dataKeys}
                                condition={entry.condition}
                                testId={`theme-selector-case-${index}-condition`}
                                onChange={(condition) =>
                                    updateCases((cases) =>
                                        cases.map((current, position) =>
                                            position === index
                                                ? { ...current, condition }
                                                : current,
                                        ),
                                    )
                                }
                            />
                            <label className="field-inline">
                                {t("themeSelector.theme")}
                                <SelectField
                                    label={t("themeSelector.theme")}
                                    data-testid={`theme-selector-case-${index}-theme`}
                                    value={entry.theme}
                                    options={themeOptions}
                                    onValueChange={(theme) =>
                                        updateCases((cases) =>
                                            cases.map((current, position) =>
                                                position === index
                                                    ? { ...current, theme }
                                                    : current,
                                            ),
                                        )
                                    }
                                />
                            </label>
                        </li>
                    ))}
                </ol>
                {!selector.cases.length && (
                    <p
                        className="muted small"
                        data-testid="theme-selector-empty"
                    >
                        {t("themeSelector.noCases")}
                    </p>
                )}
                <button
                    type="button"
                    className="add-item"
                    data-testid="theme-selector-add-case"
                    disabled={atBudget}
                    data-tooltip={
                        atBudget
                            ? t("themeSelector.caseBudget", {
                                  count: MAXIMUM_THEME_SELECTOR_CASES,
                              })
                            : undefined
                    }
                    onClick={() =>
                        update((current) => ({
                            ...current,
                            cases: [
                                ...current.cases,
                                newThemeSelectorCase(
                                    useEditorStore.getState().document,
                                    current,
                                ),
                            ],
                        }))
                    }
                >
                    <Plus size={16} />
                    {t("themeSelector.addCase")}
                </button>
                <label className="field-inline">
                    {t("themeSelector.defaultTheme")}
                    <SelectField
                        label={t("themeSelector.defaultTheme")}
                        data-testid="theme-selector-default"
                        value={selector.defaultTheme}
                        options={themeOptions}
                        onValueChange={(defaultTheme) =>
                            update((current) => ({ ...current, defaultTheme }))
                        }
                    />
                </label>
            </section>
            {previewSettings}
        </aside>
    );
}

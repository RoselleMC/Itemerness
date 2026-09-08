import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { ViewerFactNode } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { describeContext } from "../../state/interface.js";
import { builtinFactType } from "../../state/presentationLibrary.js";
import {
    addPresentationEntry,
    presentationEntryActions,
} from "../common/presentationLibraryActions.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { DataValueEditor } from "../common/DataValueEditor.js";
import { SelectField } from "../common/SelectField.js";
import { SuggestionInput } from "../common/SuggestionInput.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { PresentationLibraryHeader } from "./PresentationLibraryHeader.js";
import {
    factDataType,
    factValueError,
    initialFactValue,
    providerError,
    switchFactType,
} from "./factEditing.js";
import "./presentationLibrary.css";

export function ViewerFactInspector({
    previewSettings,
}: {
    previewSettings?: ReactNode;
}) {
    const store = useEditorStore();
    const fact = store.document.viewerFacts.find(
        (entry) => entry.uuid === store.selectedViewerFactUuid,
    );
    const { t } = useTranslation();
    if (!fact)
        return (
            <aside className="inspector">
                <button
                    type="button"
                    className="action-button"
                    onClick={() => addPresentationEntry("facts")}
                >
                    <Plus size={15} />
                    {t("presentationLibrary.add.facts")}
                </button>
                {previewSettings}
            </aside>
        );
    return (
        <FactEditor
            key={`${store.workspaceEpoch}:${fact.uuid}`}
            fact={fact}
            previewSettings={previewSettings}
        />
    );
}

function FactEditor({
    fact,
    previewSettings,
}: {
    fact: ViewerFactNode;
    previewSettings?: ReactNode;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const document = store.document;
    const [provider, setProvider] = useState("");
    const [error, setError] = useState<string | null>(null);
    const builtin = builtinFactType(fact.id);
    const update = (change: (source: ViewerFactNode) => ViewerFactNode) =>
        store.updateDocument((current) => ({
            ...current,
            viewerFacts: current.viewerFacts.map((entry) =>
                entry.uuid === fact.uuid ? change(entry) : entry,
            ),
        }));
    const patch = (changes: Partial<ViewerFactNode>) =>
        update((source) => ({ ...source, ...changes }));
    const execute = (action: (source: ViewerFactNode) => void) => {
        if (commitInlineEditor()) {
            setError(null);
            const source = useEditorStore
                .getState()
                .document.viewerFacts.find((entry) => entry.uuid === fact.uuid);
            if (source) action(source);
        }
    };
    const textError = (key: string | null) =>
        key
            ? t(`presentationLibrary.errors.${key}`, {
                  defaultValue: t(`values.errors.${key}`),
              })
            : null;
    const initialize = (field: "defaultValue" | "previewValue") => {
        const source = useEditorStore
            .getState()
            .document.viewerFacts.find((entry) => entry.uuid === fact.uuid);
        if (!source) return;
        const value =
            field === "previewValue" &&
            source.defaultValue &&
            !factValueError(document, source, source.defaultValue)
                ? source.defaultValue
                : initialFactValue(document, source);
        if (!value) {
            setError("missingResources");
            return;
        }
        patch({ [field]: value });
    };
    const addProvider = () =>
        execute((source) => {
            const failure = providerError(provider, source.providers);
            setError(failure);
            if (failure) return;
            patch({ providers: [...source.providers, provider] });
            setProvider("");
        });
    const providerOptions = [
        ...new Set([
            "api",
            "player-override",
            "client",
            "bukkit-resource-pack-status",
            ...document.viewerFacts.flatMap((entry) => entry.providers),
        ]),
    ];
    const valueSection = (field: "defaultValue" | "previewValue") => {
        const value = fact[field];
        const title =
            field === "defaultValue" ? "defaultValue" : "previewValue";
        const failure = value
            ? factValueError(document, fact, value)
            : field === "defaultValue" && !fact.nullable
              ? "requiredDefault"
              : null;
        return (
            <section>
                <div className="presentation-node-heading">
                    <h3>{t(`presentationLibrary.${title}`)}</h3>
                    <div className="inspector-actions">
                        {value && (
                            <button
                                type="button"
                                className="icon-button"
                                data-tooltip={t(
                                    "presentationLibrary.resetValue",
                                )}
                                aria-label={t("presentationLibrary.resetValue")}
                                data-testid={`fact-${field}-reset`}
                                onClick={() => execute(() => initialize(field))}
                            >
                                <RotateCcw size={15} />
                            </button>
                        )}
                        {value &&
                            (field === "previewValue" || fact.nullable) && (
                                <button
                                    type="button"
                                    className="icon-button"
                                    data-tooltip={t(
                                        `presentationLibrary.clear.${title}`,
                                    )}
                                    aria-label={t(
                                        `presentationLibrary.clear.${title}`,
                                    )}
                                    data-testid={`fact-${field}-clear`}
                                    onClick={() =>
                                        execute(() => patch({ [field]: null }))
                                    }
                                >
                                    <X size={15} />
                                </button>
                            )}
                    </div>
                </div>
                {value ? (
                    <DataValueEditor
                        value={value}
                        type={factDataType(fact.type)}
                        label={t(`presentationLibrary.${title}`)}
                        nullable={false}
                        allowNull={false}
                        testId={`fact-${field}`}
                        owner={`${fact.uuid}:${fact.type}:${field}`}
                        validateValue={(next) =>
                            textError(factValueError(document, fact, next))
                        }
                        onChange={(next) => patch({ [field]: next })}
                    />
                ) : (
                    <button
                        type="button"
                        className="action-button"
                        data-testid={`fact-${field}-set`}
                        onClick={() => execute(() => initialize(field))}
                    >
                        <Plus size={15} />
                        {t(`presentationLibrary.set.${title}`)}
                    </button>
                )}
                {failure && (
                    <p className="error small" role="alert">
                        {textError(failure)}
                    </p>
                )}
                {field === "previewValue" && !value && (
                    <p className="muted small">
                        {t("presentationLibrary.defaultPreview")}
                    </p>
                )}
            </section>
        );
    };
    return (
        <aside
            className="inspector presentation-inspector"
            aria-label={t("sidebar.mode.facts")}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: fact.id,
                    items: presentationEntryActions("facts", fact.uuid, t),
                })
            }
        >
            <PresentationLibraryHeader kind="facts" node={fact} />
            <section>
                <label className="field">
                    <span>{t("presentationLibrary.factType")}</span>
                    <SelectField
                        label={t("presentationLibrary.factType")}
                        value={fact.type}
                        data-testid="fact-type"
                        options={(
                            [
                                "LOCALE",
                                "BOOLEAN",
                                "INTEGER",
                                "LONG",
                                "DECIMAL",
                                "STRING",
                                "UUID",
                                "NAMESPACED_KEY",
                            ] as const
                        ).map((type) => ({
                            value: type,
                            label: t(`presentationLibrary.factTypes.${type}`),
                        }))}
                        onValueChange={(type) =>
                            execute(() =>
                                update((source) =>
                                    switchFactType(
                                        document,
                                        source,
                                        type as ViewerFactNode["type"],
                                    ),
                                ),
                            )
                        }
                    />
                </label>
                {builtin && fact.type !== builtin && (
                    <p className="warning small" role="status">
                        {t("presentationLibrary.runtimeFactTypeWarning", {
                            type: t(`presentationLibrary.factTypes.${builtin}`),
                        })}
                    </p>
                )}
                <label className="toggle-row">
                    <input
                        type="checkbox"
                        checked={fact.nullable}
                        data-testid="fact-nullable"
                        onChange={(event) => {
                            const nullable = event.target.checked;
                            execute((source) => {
                                const defaultValue =
                                    !nullable && !source.defaultValue
                                        ? initialFactValue(document, source)
                                        : source.defaultValue;
                                if (!nullable && !defaultValue) {
                                    setError("missingResources");
                                    return;
                                }
                                patch({ nullable, defaultValue });
                            });
                        }}
                    />
                    {t("presentationLibrary.nullable")}
                </label>
                <label className="toggle-row">
                    <input
                        type="checkbox"
                        checked={fact.cacheKey}
                        data-testid="fact-cacheKey"
                        onChange={(event) => {
                            const cacheKey = event.target.checked;
                            execute(() => patch({ cacheKey }));
                        }}
                    />
                    {t("presentationLibrary.cacheKey")}
                </label>
            </section>
            <section>
                <h3>{t("presentationLibrary.providers")}</h3>
                <ol className="presentation-providers">
                    {fact.providers.map((entry, index) => (
                        <li key={`${index}:${entry}`}>
                            <BufferedInput
                                value={entry}
                                label={t("presentationLibrary.provider", {
                                    index: index + 1,
                                })}
                                owner={`${fact.uuid}:provider:${index}`}
                                testId={`fact-provider-${index}`}
                                suggestions={providerOptions}
                                validate={(raw) =>
                                    textError(
                                        providerError(
                                            raw,
                                            fact.providers,
                                            entry,
                                        ),
                                    )
                                }
                                onCommit={(raw) =>
                                    update((source) => ({
                                        ...source,
                                        providers: source.providers.map(
                                            (value, position) =>
                                                position === index
                                                    ? raw
                                                    : value,
                                        ),
                                    }))
                                }
                            />
                            <div className="inspector-actions">
                                {([-1, 1] as const).map((offset) => {
                                    const Icon =
                                        offset === -1 ? ArrowUp : ArrowDown;
                                    const label = t(
                                        `values.${offset === -1 ? "moveUp" : "moveDown"}`,
                                    );
                                    return (
                                        <button
                                            key={offset}
                                            type="button"
                                            className="icon-button"
                                            aria-label={label}
                                            data-tooltip={label}
                                            data-testid={`fact-provider-${index}-${offset === -1 ? "up" : "down"}`}
                                            disabled={
                                                index + offset < 0 ||
                                                index + offset >=
                                                    fact.providers.length
                                            }
                                            onClick={() =>
                                                execute((source) => {
                                                    const providers = [
                                                        ...source.providers,
                                                    ];
                                                    [
                                                        providers[index],
                                                        providers[
                                                            index + offset
                                                        ],
                                                    ] = [
                                                        providers[
                                                            index + offset
                                                        ]!,
                                                        providers[index]!,
                                                    ];
                                                    patch({ providers });
                                                })
                                            }
                                        >
                                            <Icon size={14} />
                                        </button>
                                    );
                                })}
                                <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t(
                                        "presentationLibrary.removeProvider",
                                    )}
                                    data-tooltip={t(
                                        "presentationLibrary.removeProvider",
                                    )}
                                    data-testid={`fact-provider-${index}-delete`}
                                    disabled={fact.providers.length <= 1}
                                    onClick={() =>
                                        execute((source) =>
                                            patch({
                                                providers:
                                                    source.providers.filter(
                                                        (_, position) =>
                                                            position !== index,
                                                    ),
                                            }),
                                        )
                                    }
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        </li>
                    ))}
                </ol>
                <div className="presentation-add-provider">
                    <SuggestionInput
                        label={t("presentationLibrary.addProvider")}
                        value={provider}
                        suggestions={providerOptions}
                        onValueChange={(value) => {
                            setProvider(value);
                            setError(null);
                        }}
                        data-testid="fact-add-provider-input"
                        onKeyDown={(event) => {
                            if (
                                event.key === "Enter" &&
                                !event.currentTarget.hasAttribute(
                                    "aria-activedescendant",
                                )
                            ) {
                                event.preventDefault();
                                addProvider();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="icon-button"
                        aria-label={t("presentationLibrary.addProvider")}
                        data-tooltip={t("presentationLibrary.addProvider")}
                        data-testid="fact-add-provider"
                        onClick={addProvider}
                    >
                        <Plus size={15} />
                    </button>
                </div>
                {error && (
                    <p className="error small" role="alert">
                        {textError(error)}
                    </p>
                )}
            </section>
            {valueSection("defaultValue")}
            {valueSection("previewValue")}
            {previewSettings}
        </aside>
    );
}

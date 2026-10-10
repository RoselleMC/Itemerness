import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
    namespacedIdSchema,
    supportsDataFieldConstraints,
    type DataKeyNode,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { resolveMessage } from "../common/messages.js";
import { describeContext, runMenuAction } from "../../state/interface.js";
import { dataKeyActions } from "../common/dataLibraryActions.js";
import { renameDataKey } from "../../state/dataLibrary.js";
import { DataSchemaInspector } from "./DataSchemaInspector.js";
import { DataIntegrationEditor } from "./DataIntegrationEditor.js";
import { DataTypeEditor } from "../common/DataTypeEditor.js";
import { DataValueEditor } from "../common/DataValueEditor.js";
import { DataConstraintsEditor } from "../common/DataConstraintsEditor.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { SelectField } from "../common/SelectField.js";
import { initialDataValue, valueKindForType } from "../common/typedValues.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { dataKeyReferences } from "./dataKeyEditing.js";
import "./dataEditor.css";

export function DataInspector({
    previewSettings,
}: {
    previewSettings?: ReactNode;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const fieldConstraintsSupported = useConnectionStore((state) =>
        supportsDataFieldConstraints(state.info?.capabilities),
    );
    const doc = store.document;
    const schema = doc.dataSchemas.find((entry) =>
        entry.keys.some((key) => key.uuid === store.selectedDataKeyUuid),
    );
    const dataKey = schema?.keys.find(
        (key) => key.uuid === store.selectedDataKeyUuid,
    );
    if (!dataKey || !schema)
        return <DataSchemaInspector previewSettings={previewSettings} />;
    const references = dataKeyReferences(doc, dataKey.uuid);
    const patch = (changes: Partial<DataKeyNode>) =>
        store.updateDataKey(dataKey.uuid, (key) => ({ ...key, ...changes }));
    return (
        <aside
            className="inspector"
            aria-label={t("inspector.data.heading")}
            key={dataKey.uuid}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: dataKey.id,
                    items: dataKeyActions(dataKey.uuid, t),
                })
            }
        >
            <section>
                <header className="content-inspector-header">
                    <h3>{t("inspector.data.heading")}</h3>
                    <div className="content-inspector-actions">
                        {dataKeyActions(dataKey.uuid, t)
                            .filter(
                                (action) =>
                                    action.id === "duplicate-key" ||
                                    action.id === "delete-key",
                            )
                            .map((action) => (
                                <button
                                    key={action.id}
                                    type="button"
                                    className="icon-button"
                                    disabled={action.disabled}
                                    aria-label={action.label}
                                    data-tooltip={
                                        action.disabled
                                            ? t("dataLibrary.inUse")
                                            : action.label
                                    }
                                    data-testid={action.id}
                                    onClick={() => runMenuAction(action)}
                                >
                                    {action.icon && <action.icon size={16} />}
                                </button>
                            ))}
                    </div>
                </header>
                <BufferedInput
                    value={dataKey.id}
                    label={t("dataLibrary.keyId")}
                    testId="data-key-id"
                    owner={dataKey.uuid}
                    validate={(id) =>
                        !namespacedIdSchema.safeParse(id).success
                            ? t("dataLibrary.invalidId")
                            : doc.dataSchemas.some((entry) =>
                                    entry.keys.some(
                                        (key) =>
                                            key.uuid !== dataKey.uuid &&
                                            key.id === id,
                                    ),
                                )
                              ? t("dataLibrary.duplicateIdentity")
                              : null
                    }
                    onCommit={(id) =>
                        store.updateDocument((document) =>
                            renameDataKey(document, dataKey.uuid, id),
                        )
                    }
                />
                <p className="muted small data-key-id">
                    {schema.id} @ {schema.version}
                </p>
                <p className="muted small" data-testid="data-used-by">
                    {t("inspector.layout.usedBy", {
                        count: references.items.length,
                    })}
                </p>
            </section>
            {references.labels.length > 0 && (
                <section>
                    <h3>{t("inspector.data.label")}</h3>
                    {references.labels.map((messageKey, index) => {
                        const label = resolveMessage(
                            doc,
                            store.viewerLocale,
                            messageKey,
                        );
                        return (
                            <div className="data-label-field" key={messageKey}>
                                <label>
                                    <span className="field-label data-key-id">
                                        {messageKey}
                                    </span>
                                    <input
                                        value={
                                            label.source === "own"
                                                ? label.text
                                                : ""
                                        }
                                        placeholder={
                                            label.source === "missing"
                                                ? t("locales.missing")
                                                : label.text
                                        }
                                        data-testid={
                                            index === 0
                                                ? "data-label-input"
                                                : `data-label-input-${index}`
                                        }
                                        onChange={(event) =>
                                            store.setMessage(
                                                store.viewerLocale,
                                                messageKey,
                                                event.target.value,
                                            )
                                        }
                                    />
                                </label>
                                {label.source !== "own" &&
                                    label.sourceLocale && (
                                        <span className="muted small">
                                            {t("locales.inheritedFrom", {
                                                locale: label.sourceLocale,
                                            })}
                                        </span>
                                    )}
                            </div>
                        );
                    })}
                </section>
            )}
            <section>
                <DataTypeEditor
                    type={dataKey.type}
                    label={t("dataEditing.type")}
                    testId="data-type"
                    fieldConstraints={fieldConstraintsSupported}
                    onChange={(type) => patch({ type })}
                />
                <label className="field-label">{t("dataEditing.scope")}</label>
                <SelectField
                    value={dataKey.scope}
                    label={t("dataEditing.scope")}
                    data-testid="data-scope"
                    options={[
                        {
                            value: "DEFINITION",
                            label: t("inspector.data.definition"),
                        },
                        {
                            value: "INSTANCE",
                            label: t("inspector.data.instance"),
                        },
                    ]}
                    onValueChange={(scope) => {
                        if (commitInlineEditor())
                            patch({ scope: scope as DataKeyNode["scope"] });
                    }}
                />
                {(
                    [
                        "nullable",
                        "affectsStacking",
                        "presentationReadable",
                    ] as const
                ).map((key) => (
                    <label className="toggle-row" key={key}>
                        <input
                            type="checkbox"
                            checked={dataKey[key]}
                            data-testid={`data-${key}`}
                            onChange={(event) =>
                                patch({ [key]: event.target.checked })
                            }
                        />
                        {t(
                            key === "nullable"
                                ? "dataEditing.nullable"
                                : `inspector.data.${key}`,
                        )}
                    </label>
                ))}
            </section>
            <section>
                <div className="data-editor-row">
                    <h3>{t("inspector.data.defaultValue")}</h3>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label={t(
                            dataKey.defaultValue === null
                                ? "dataEditing.setDefault"
                                : "dataEditing.clearDefault",
                        )}
                        data-tooltip={t(
                            dataKey.defaultValue === null
                                ? "dataEditing.setDefault"
                                : "dataEditing.clearDefault",
                        )}
                        data-testid="data-default-toggle"
                        onClick={() => {
                            if (commitInlineEditor())
                                patch({
                                    defaultValue:
                                        dataKey.defaultValue === null
                                            ? initialDataValue(
                                                  valueKindForType(
                                                      dataKey.type,
                                                  ),
                                                  dataKey.type,
                                              )
                                            : null,
                                });
                        }}
                    >
                        {dataKey.defaultValue === null ? (
                            <Plus size={16} />
                        ) : (
                            <Trash2 size={16} />
                        )}
                    </button>
                </div>
                {dataKey.defaultValue === null ? (
                    <span className="muted small">
                        {t("dataEditing.noDefault")}
                    </span>
                ) : (
                    <DataValueEditor
                        value={dataKey.defaultValue}
                        type={dataKey.type}
                        nullable={dataKey.nullable}
                        constraints={dataKey.constraints}
                        label={t("inspector.data.defaultValue")}
                        testId="data-default"
                        onChange={(defaultValue) => patch({ defaultValue })}
                    />
                )}
            </section>
            <section>
                <h3>{t("dataEditing.constraintsHeading")}</h3>
                <DataConstraintsEditor
                    constraints={dataKey.constraints}
                    type={dataKey.type}
                    owner={dataKey.uuid}
                    testId="data"
                    onChange={(constraints) => patch({ constraints })}
                />
            </section>
            <DataIntegrationEditor document={doc} dataKey={dataKey} />
            {previewSettings}
        </aside>
    );
}

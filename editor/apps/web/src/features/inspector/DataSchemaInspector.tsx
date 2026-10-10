import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { Lock, LockOpen, Plus } from "lucide-react";
import { namespacedIdSchema, schemaOwnerSchema } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import {
    renameDataSchema,
    schemaItems,
    suggestedSchemaOwner,
} from "../../state/dataLibrary.js";
import { describeContext, runMenuAction } from "../../state/interface.js";
import { BufferedInput } from "../common/BufferedInput.js";
import {
    addKey,
    addSchema,
    dataSchemaActions,
    isSchemaLocked,
    unlockSchema,
} from "../common/dataLibraryActions.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { IntegrationUpgradeButton } from "./DataIntegrationEditor.js";

export function DataSchemaInspector({
    previewSettings,
}: {
    previewSettings?: ReactNode;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const schema = store.document.dataSchemas.find(
        (entry) => entry.uuid === store.selectedDataSchemaUuid,
    );
    if (!schema)
        return (
            <aside className="inspector" aria-label={t("dataLibrary.schema")}>
                <h3>{t("dataLibrary.schemas")}</h3>
                <button
                    type="button"
                    className="add-item"
                    onClick={() => addSchema()}
                    data-testid="empty-add-schema"
                >
                    <Plus size={16} />
                    {t("dataLibrary.addSchema")}
                </button>
                <IntegrationUpgradeButton document={store.document} />
                {previewSettings}
            </aside>
        );
    const locked = isSchemaLocked(schema.uuid);
    const suggestion = schema.owner ? null : suggestedSchemaOwner(schema);
    const setOwner = (owner: string | null) =>
        store.updateDocument((document) => ({
            ...document,
            dataSchemas: document.dataSchemas.map((entry) => {
                if (entry.uuid !== schema.uuid) return entry;
                const { owner: _previous, ...rest } = entry;
                return owner === null ? rest : { ...rest, owner };
            }),
        }));
    const actions = dataSchemaActions(schema.uuid, t).filter(
        (action) =>
            action.id === "duplicate-schema" || action.id === "delete-schema",
    );
    const validate = (id: string, version: number) =>
        !namespacedIdSchema.safeParse(id).success
            ? t("dataLibrary.invalidId")
            : !Number.isInteger(version) || version < 1 || version > 2147483647
              ? t("dataLibrary.invalidVersion")
              : store.document.dataSchemas.some(
                      (entry) =>
                          entry.uuid !== schema.uuid &&
                          entry.id === id &&
                          entry.version === version,
                  )
                ? t("dataLibrary.duplicateIdentity")
                : null;
    return (
        <aside
            className="inspector"
            aria-label={t("dataLibrary.schema")}
            key={schema.uuid}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: schema.id,
                    items: dataSchemaActions(schema.uuid, t),
                })
            }
        >
            <header className="content-inspector-header">
                <h3>{t("dataLibrary.schema")}</h3>
                <div className="content-inspector-actions">
                    {actions.map((action) => (
                        <button
                            key={action.id}
                            type="button"
                            className="icon-button"
                            aria-label={action.label}
                            data-tooltip={
                                action.disabled
                                    ? t("dataLibrary.inUse")
                                    : action.label
                            }
                            data-testid={action.id}
                            disabled={action.disabled}
                            onClick={() => runMenuAction(action)}
                        >
                            {action.icon && <action.icon size={16} />}
                        </button>
                    ))}
                </div>
            </header>
            <section
                className="data-schema-owner"
                data-testid="data-schema-owner"
            >
                <div className="data-editor-row">
                    <h4>{t("dataLibrary.owner")}</h4>
                    {locked && (
                        <button
                            type="button"
                            className="icon-button"
                            aria-label={t("dataLibrary.unlock")}
                            data-tooltip={t("dataLibrary.unlock")}
                            data-testid="data-schema-unlock"
                            onClick={() => void unlockSchema(schema.uuid, t)}
                        >
                            <LockOpen size={16} />
                        </button>
                    )}
                </div>
                {locked ? (
                    <p className="small" data-testid="data-schema-locked">
                        <Lock size={13} aria-hidden="true" />{" "}
                        {t("dataLibrary.ownedBy", { owner: schema.owner })}
                    </p>
                ) : (
                    <>
                        <BufferedInput
                            value={schema.owner ?? ""}
                            label={t("dataLibrary.owner")}
                            owner={`${schema.uuid}-owner`}
                            testId="data-schema-owner-input"
                            validate={(raw) =>
                                raw === "" ||
                                schemaOwnerSchema.safeParse(raw).success
                                    ? null
                                    : t("dataLibrary.invalidOwner")
                            }
                            onCommit={(raw) =>
                                setOwner(raw === "" ? null : raw)
                            }
                        />
                        <p className="muted small">
                            {t("dataLibrary.ownerHint")}
                        </p>
                        {suggestion && (
                            <button
                                type="button"
                                className="text-command"
                                data-testid="data-schema-declare-owner"
                                onClick={() => {
                                    if (commitInlineEditor())
                                        setOwner(suggestion);
                                }}
                            >
                                {t("dataLibrary.declareOwner", {
                                    owner: suggestion,
                                })}
                            </button>
                        )}
                    </>
                )}
            </section>
            <fieldset className="data-lock-scope" disabled={locked}>
                <section>
                    <label className="field-label">ID</label>
                    <BufferedInput
                        value={schema.id}
                        label={t("dataLibrary.schemaId")}
                        owner={schema.uuid}
                        testId="data-schema-id"
                        validate={(id) => validate(id, schema.version)}
                        onCommit={(id) =>
                            store.updateDocument((document) =>
                                renameDataSchema(
                                    document,
                                    schema.uuid,
                                    id,
                                    schema.version,
                                ),
                            )
                        }
                    />
                    <label className="field-label">
                        {t("dataLibrary.version")}
                    </label>
                    <BufferedInput
                        value={String(schema.version)}
                        label={t("dataLibrary.version")}
                        owner={schema.uuid}
                        testId="data-schema-version"
                        inputMode="numeric"
                        validate={(raw) =>
                            /^[1-9][0-9]*$/.test(raw)
                                ? validate(schema.id, Number(raw))
                                : t("dataLibrary.invalidVersion")
                        }
                        onCommit={(raw) =>
                            store.updateDocument((document) =>
                                renameDataSchema(
                                    document,
                                    schema.uuid,
                                    schema.id,
                                    Number(raw),
                                ),
                            )
                        }
                    />
                    <p className="muted small">
                        {t("inspector.layout.usedBy", {
                            count: schemaItems(store.document, schema).length,
                        })}
                    </p>
                </section>
            </fieldset>
            <section>
                <div className="data-editor-row">
                    <h3>
                        {t("dataLibrary.keys", { count: schema.keys.length })}
                    </h3>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label={t("dataLibrary.addKey")}
                        data-tooltip={t("dataLibrary.addKey")}
                        data-testid="schema-add-key"
                        disabled={locked}
                        onClick={() => addKey(schema.uuid)}
                    >
                        <Plus size={16} />
                    </button>
                </div>
                <ul className="data-schema-keys">
                    {schema.keys.map((key) => (
                        <li key={key.uuid}>
                            <button
                                type="button"
                                onClick={() => {
                                    if (commitInlineEditor())
                                        store.selectDataKey(key.uuid);
                                }}
                            >
                                {key.id}
                            </button>
                        </li>
                    ))}
                </ul>
            </section>
            <IntegrationUpgradeButton document={store.document} />
            {previewSettings}
        </aside>
    );
}

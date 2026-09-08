import { itemKey } from "@itemerness/protocol";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, RotateCcw } from "lucide-react";
import type {
    DataKeyNode,
    DataValue,
    ItemNode,
    ProjectDocument,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { DataValueEditor } from "../common/DataValueEditor.js";
import { SelectField } from "../common/SelectField.js";
import {
    initialDataValue,
    itemDataKeys,
    valueKindForType,
} from "../common/typedValues.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import {
    BaseComponentEditor,
    DefinitionAction,
} from "./BaseComponentEditor.js";
import {
    bindingIssue,
    contentGraphIssues,
    contentsEditIssue,
    definitionReferenceIssues,
    generatorIssue,
    inferContentComponent,
    initialGenerator,
    replaceBinding,
    setInstanceMode,
    type Generator,
    type ItemDefinition,
} from "./itemDefinitionEditing.js";
import "./item-definition.css";

type UpdateDefinition = (
    edit: (definition: ItemDefinition) => ItemDefinition,
) => void;

function valueSummary(value: DataValue | null, empty: string): string {
    if (value === null || value.kind === "null") return empty;
    if (value.kind === "list") return `[${value.values.length}]`;
    if (value.kind === "compound")
        return `{${Object.keys(value.entries).length}}`;
    return String(value.value);
}

function Assignments({
    item,
    keys,
    scope,
    update,
}: {
    item: ItemNode;
    keys: DataKeyNode[];
    scope: "DEFINITION" | "INSTANCE";
    update: UpdateDefinition;
}) {
    const { t } = useTranslation();
    const definition = item.definition;
    const entries =
        scope === "DEFINITION"
            ? definition.definitionData
            : definition.instance.defaults;
    const ownKeys = keys.filter(
        (key) =>
            key.scope === scope &&
            keys.filter((entry) => entry.id === key.id).length === 1,
    );
    const setEntries = (
        edit: (
            entries: typeof definition.definitionData,
        ) => typeof definition.definitionData,
    ) =>
        update((current) =>
            scope === "DEFINITION"
                ? { ...current, definitionData: edit(current.definitionData) }
                : {
                      ...current,
                      instance: {
                          ...current.instance,
                          defaults: edit(current.instance.defaults),
                      },
                  },
        );
    const prefix =
        scope === "DEFINITION" ? "definition-data" : "instance-defaults";
    const inherited = ownKeys.filter(
        (key) => !entries.some((entry) => entry.key === key.id),
    );
    return (
        <details className="definition-section" data-testid={prefix}>
            <summary>
                {t(
                    `itemDefinition.${scope === "DEFINITION" ? "definitionData" : "instanceDefaults"}`,
                )}
            </summary>
            {entries.map((entry, index) => {
                const matches = ownKeys.filter((key) => key.id === entry.key);
                const key = matches.length === 1 ? matches[0] : undefined;
                const generated =
                    scope === "INSTANCE" &&
                    definition.instance.generators.some(
                        (generator) => generator.key === entry.key,
                    );
                const duplicate = entries.some(
                    (other, position) =>
                        position !== index && other.key === entry.key,
                );
                const owner = `${item.uuid}-${prefix}-${index}-${entry.key}`;
                return (
                    <div
                        className="definition-entry"
                        key={`${entry.key}-${index}`}
                        data-testid={`${prefix}-${index}`}
                    >
                        <div className="definition-row-heading">
                            <SelectField
                                label={t("itemDefinition.key")}
                                data-testid={`${prefix}-${index}-key`}
                                value={entry.key}
                                options={ownKeys.map((candidate) => ({
                                    value: candidate.id,
                                    label: candidate.id,
                                    disabled:
                                        entries.some(
                                            (other, position) =>
                                                position !== index &&
                                                other.key === candidate.id,
                                        ) ||
                                        (scope === "INSTANCE" &&
                                            definition.instance.generators.some(
                                                (generator) =>
                                                    generator.key ===
                                                    candidate.id,
                                            )),
                                }))}
                                onValueChange={(next) => {
                                    if (commitInlineEditor())
                                        setEntries((current) =>
                                            current.map((old, position) =>
                                                position === index
                                                    ? { ...old, key: next }
                                                    : old,
                                            ),
                                        );
                                }}
                            />
                            <DefinitionAction
                                icon={RotateCcw}
                                label={t("itemDefinition.inherit")}
                                testId={`${prefix}-${index}-remove`}
                                onClick={() =>
                                    setEntries((current) =>
                                        current.filter(
                                            (_, position) => position !== index,
                                        ),
                                    )
                                }
                            />
                        </div>
                        {!key && (
                            <p className="error small" role="alert">
                                {t("itemDefinition.errors.unboundKey", {
                                    detail: entry.key,
                                })}
                            </p>
                        )}
                        {generated && (
                            <p className="error small" role="alert">
                                {t("itemDefinition.errors.generatorDefault")}
                            </p>
                        )}
                        {duplicate && (
                            <p className="error small" role="alert">
                                {t("itemDefinition.errors.duplicateAssignment")}
                            </p>
                        )}
                        <DataValueEditor
                            value={entry.value}
                            type={key?.type}
                            nullable={key?.nullable ?? true}
                            label={t("itemDefinition.overrideValue")}
                            owner={owner}
                            testId={`${prefix}-${index}-value`}
                            onChange={(value) =>
                                setEntries((current) =>
                                    current.map((old, position) =>
                                        position === index
                                            ? { ...old, value }
                                            : old,
                                    ),
                                )
                            }
                        />
                    </div>
                );
            })}
            {inherited.map((key) => {
                const generated =
                    scope === "INSTANCE" &&
                    definition.instance.generators.some(
                        (generator) => generator.key === key.id,
                    );
                return (
                    <div
                        className="definition-inherited"
                        key={key.uuid}
                        data-testid={`${prefix}-inherited-${key.id}`}
                    >
                        <div className="definition-row-heading">
                            <code>{key.id}</code>
                            <DefinitionAction
                                icon={Plus}
                                label={t("itemDefinition.addOverride")}
                                testId={`${prefix}-override-${key.id}`}
                                disabled={generated || entries.length >= 256}
                                onClick={() =>
                                    setEntries((current) => [
                                        ...current,
                                        {
                                            key: key.id,
                                            value: structuredClone(
                                                key.defaultValue ??
                                                    initialDataValue(
                                                        valueKindForType(
                                                            key.type,
                                                        ),
                                                        key.type,
                                                    ),
                                            ),
                                        },
                                    ])
                                }
                            />
                        </div>
                        <span
                            className={
                                !generated &&
                                !key.nullable &&
                                (key.defaultValue === null ||
                                    key.defaultValue.kind === "null")
                                    ? "error small"
                                    : "muted small"
                            }
                        >
                            {generated
                                ? t("itemDefinition.generated")
                                : key.defaultValue === null
                                  ? t(
                                        key.nullable
                                            ? "itemDefinition.noValue"
                                            : "itemDefinition.errors.requiredValue",
                                    )
                                  : t("itemDefinition.schemaValue", {
                                        value: valueSummary(
                                            key.defaultValue,
                                            t("values.types.null"),
                                        ),
                                    })}
                        </span>
                    </div>
                );
            })}
            {!entries.length && !inherited.length && (
                <p className="muted small">{t("itemDefinition.noBoundKeys")}</p>
            )}
        </details>
    );
}

function Generators({
    item,
    keys,
    update,
}: {
    item: ItemNode;
    keys: DataKeyNode[];
    update: UpdateDefinition;
}) {
    const { t } = useTranslation();
    const [adding, setAdding] = useState("");
    const { generators, defaults } = item.definition.instance;
    const eligible = keys.filter(
        (key) =>
            key.scope === "INSTANCE" &&
            (key.type.kind === "long" || key.type.kind === "decimal") &&
            !key.constraints.allowedValues.length &&
            !defaults.some((entry) => entry.key === key.id) &&
            keys.filter((other) => other.id === key.id).length === 1,
    );
    const updateGenerators = (edit: (values: Generator[]) => Generator[]) =>
        update((current) => ({
            ...current,
            instance: {
                ...current.instance,
                generators: edit(current.instance.generators),
            },
        }));
    const create = initialGenerator;
    const available = eligible.filter(
        (key) =>
            !generators.some((entry) => entry.key === key.id) &&
            !generatorIssue(create(key), key, defaults),
    );
    return (
        <details className="definition-section" data-testid="item-generators">
            <summary>{t("itemDefinition.generators")}</summary>
            {generators.map((generator, index) => {
                const key = keys.find((entry) => entry.id === generator.key);
                const issue = generatorIssue(generator, key, defaults);
                const updateGenerator = (
                    edit: (current: Generator) => Generator,
                ) =>
                    updateGenerators((current) =>
                        current.map((entry, position) =>
                            position === index ? edit(entry) : entry,
                        ),
                    );
                return (
                    <div
                        className="definition-entry"
                        data-testid={`generator-${index}`}
                        key={`${generator.key}-${index}`}
                    >
                        <div className="definition-row-heading">
                            <SelectField
                                label={t("itemDefinition.key")}
                                data-testid={`generator-${index}-key`}
                                value={generator.key}
                                options={eligible
                                    .filter(
                                        (entry) =>
                                            entry.type.kind ===
                                            (generator.kind === "unixMillis"
                                                ? "long"
                                                : "decimal"),
                                    )
                                    .map((entry) => ({
                                        value: entry.id,
                                        label: entry.id,
                                        disabled: generators.some(
                                            (other, position) =>
                                                position !== index &&
                                                other.key === entry.id,
                                        ),
                                    }))}
                                onValueChange={(next) => {
                                    if (commitInlineEditor())
                                        updateGenerator((current) => ({
                                            ...current,
                                            key: next,
                                        }));
                                }}
                            />
                            <DefinitionAction
                                label={t("itemDefinition.removeGenerator")}
                                testId={`generator-${index}-remove`}
                                onClick={() =>
                                    updateGenerators((current) =>
                                        current.filter(
                                            (_, position) => position !== index,
                                        ),
                                    )
                                }
                            />
                        </div>
                        <SelectField
                            label={t("itemDefinition.generatorKind")}
                            data-testid={`generator-${index}-kind`}
                            value={generator.kind}
                            options={["unixMillis", "randomDecimal"].map(
                                (kind) => ({
                                    value: kind,
                                    label: t(`itemDefinition.${kind}`),
                                }),
                            )}
                            onValueChange={(kind) => {
                                if (commitInlineEditor())
                                    updateGenerator((current) =>
                                        kind === "unixMillis"
                                            ? { kind, key: current.key }
                                            : {
                                                  kind: "randomDecimal",
                                                  key: current.key,
                                                  minimum: "0",
                                                  maximum: "1",
                                                  scale: 2,
                                              },
                                    );
                            }}
                        />
                        {issue && (
                            <p className="error small" role="alert">
                                {t(`itemDefinition.errors.${issue}`, {
                                    detail: generator.key,
                                })}
                            </p>
                        )}
                        {generators.some(
                            (entry, position) =>
                                position !== index &&
                                entry.key === generator.key,
                        ) && (
                            <p className="error small">
                                {t("itemDefinition.errors.duplicateGenerator")}
                            </p>
                        )}
                        {generator.kind === "randomDecimal" &&
                            (["minimum", "maximum", "scale"] as const).map(
                                (field) => (
                                    <label
                                        className="definition-field"
                                        key={field}
                                    >
                                        <span>
                                            {t(`itemDefinition.${field}`)}
                                        </span>
                                        <BufferedInput
                                            label={t(`itemDefinition.${field}`)}
                                            value={String(generator[field])}
                                            owner={`${item.uuid}-generator-${index}-${generator.key}-${field}`}
                                            testId={`generator-${index}-${field}`}
                                            inputMode={
                                                field === "scale"
                                                    ? "numeric"
                                                    : "decimal"
                                            }
                                            validate={(raw) => {
                                                if (
                                                    field === "scale" &&
                                                    !/^(0|[1-9][0-9]*)$/.test(
                                                        raw,
                                                    )
                                                )
                                                    return t(
                                                        "itemDefinition.errors.generatorScale",
                                                    );
                                                const error = generatorIssue(
                                                    {
                                                        ...generator,
                                                        [field]:
                                                            field === "scale"
                                                                ? Number(raw)
                                                                : raw,
                                                    },
                                                    key,
                                                    defaults,
                                                );
                                                return error
                                                    ? t(
                                                          `itemDefinition.errors.${error}`,
                                                      )
                                                    : null;
                                            }}
                                            onCommit={(raw) =>
                                                updateGenerator((current) =>
                                                    current.kind ===
                                                    "randomDecimal"
                                                        ? {
                                                              ...current,
                                                              [field]:
                                                                  field ===
                                                                  "scale"
                                                                      ? Number(
                                                                            raw,
                                                                        )
                                                                      : raw,
                                                          }
                                                        : current,
                                                )
                                            }
                                        />
                                    </label>
                                ),
                            )}
                    </div>
                );
            })}
            <div className="definition-add-row">
                <SelectField
                    label={t("itemDefinition.addGenerator")}
                    data-testid="generator-add-choice"
                    value={adding}
                    options={[
                        { value: "", label: t("itemDefinition.addGenerator") },
                        ...available.map((key) => ({
                            value: key.id,
                            label: key.id,
                        })),
                    ]}
                    onValueChange={setAdding}
                />
                <DefinitionAction
                    icon={Plus}
                    label={t("itemDefinition.addGenerator")}
                    testId="generator-add"
                    disabled={!available.some((key) => key.id === adding)}
                    onClick={() => {
                        const key = available.find(
                            (entry) => entry.id === adding,
                        );
                        if (key)
                            updateGenerators((current) => [
                                ...current,
                                create(key),
                            ]);
                        setAdding("");
                    }}
                />
            </div>
        </details>
    );
}

function Contents({
    document,
    item,
    update,
}: {
    document: ProjectDocument;
    item: ItemNode;
    update: UpdateDefinition;
}) {
    const { t } = useTranslation();
    const [adding, setAdding] = useState("");
    const contents = item.definition.contents;
    const carrier = inferContentComponent(item.definition.material);
    const setContents = (
        edit: (
            values: ItemDefinition["contents"],
        ) => ItemDefinition["contents"],
    ) =>
        update((current) => {
            const next = edit(current.contents);
            return {
                ...current,
                contents: next,
                contentComponent: next.length
                    ? inferContentComponent(current.material)
                    : null,
            };
        });
    const candidates = (index: number) =>
        document.items.map((target) => {
            const id = itemKey(document, target);
            const next = [...contents];
            next[index] = { item: id, amount: next[index]?.amount ?? 1 };
            return {
                value: id,
                label: id,
                disabled: !!contentsEditIssue(document, item, next),
            };
        });
    const issues = contentGraphIssues(document).filter(
        (issue) => issue.item === itemKey(document, item),
    );
    const mismatch =
        item.definition.contentComponent !== (contents.length ? carrier : null);
    return (
        <details className="definition-section" data-testid="item-contents">
            <summary>{t("itemDefinition.contents")}</summary>
            <p className="muted small">
                {t("itemDefinition.carrier", {
                    carrier: carrier
                        ? t(`itemDefinition.${carrier}`)
                        : t("itemDefinition.noCarrier"),
                })}
            </p>
            {!carrier && contents.length > 0 && (
                <p className="error small" role="alert">
                    {t("itemDefinition.errors.contentCarrier")}
                </p>
            )}
            {mismatch && (
                <div className="definition-row-heading">
                    <p className="error small">
                        {t("itemDefinition.errors.carrierMismatch")}
                    </p>
                    <DefinitionAction
                        icon={RotateCcw}
                        disabled={contents.length > 0 && !carrier}
                        label={t("itemDefinition.repairCarrier")}
                        testId="content-repair-carrier"
                        onClick={() =>
                            update((current) => ({
                                ...current,
                                contentComponent: current.contents.length
                                    ? inferContentComponent(current.material)
                                    : null,
                            }))
                        }
                    />
                </div>
            )}
            {[...new Set(issues.map((issue) => issue.code))].map((code) => (
                <p className="error small" role="alert" key={code}>
                    {t(`itemDefinition.errors.${code}`)}
                </p>
            ))}
            {contents.map((entry, index) => (
                <div
                    className="definition-entry"
                    data-testid={`content-entry-${index}`}
                    key={index}
                >
                    <SelectField
                        label={t("itemDefinition.nestedItem")}
                        data-testid={`content-entry-${index}-item`}
                        value={entry.item}
                        options={candidates(index)}
                        onValueChange={(next) => {
                            if (commitInlineEditor())
                                setContents((current) =>
                                    current.map((old, position) =>
                                        position === index
                                            ? { ...old, item: next }
                                            : old,
                                    ),
                                );
                        }}
                    />
                    <div className="definition-row-heading">
                        <BufferedInput
                            label={t("itemDefinition.amount")}
                            value={String(entry.amount)}
                            owner={`${item.uuid}-content-${index}-${entry.item}`}
                            testId={`content-entry-${index}-amount`}
                            inputMode="numeric"
                            validate={(raw) => {
                                if (
                                    !/^[1-9][0-9]*$/.test(raw) ||
                                    Number(raw) > 99
                                )
                                    return t(
                                        "itemDefinition.errors.contentAmount",
                                    );
                                const error = contentsEditIssue(
                                    document,
                                    item,
                                    contents.map((old, position) =>
                                        position === index
                                            ? { ...old, amount: Number(raw) }
                                            : old,
                                    ),
                                );
                                return error
                                    ? t(`itemDefinition.errors.${error}`)
                                    : null;
                            }}
                            onCommit={(raw) =>
                                setContents((current) =>
                                    current.map((old, position) =>
                                        position === index
                                            ? { ...old, amount: Number(raw) }
                                            : old,
                                    ),
                                )
                            }
                        />
                        <div className="definition-row-actions">
                            <DefinitionAction
                                label={t("values.moveUp")}
                                icon={ArrowUp}
                                disabled={index === 0}
                                onClick={() =>
                                    setContents((current) => {
                                        const next = [...current];
                                        [next[index - 1], next[index]] = [
                                            next[index]!,
                                            next[index - 1]!,
                                        ];
                                        return next;
                                    })
                                }
                            />
                            <DefinitionAction
                                label={t("values.moveDown")}
                                icon={ArrowDown}
                                disabled={index === contents.length - 1}
                                onClick={() =>
                                    setContents((current) => {
                                        const next = [...current];
                                        [next[index], next[index + 1]] = [
                                            next[index + 1]!,
                                            next[index]!,
                                        ];
                                        return next;
                                    })
                                }
                            />
                            <DefinitionAction
                                label={t("itemDefinition.removeContent")}
                                testId={`content-entry-${index}-remove`}
                                onClick={() =>
                                    setContents((current) =>
                                        current.filter(
                                            (_, position) => position !== index,
                                        ),
                                    )
                                }
                            />
                        </div>
                    </div>
                </div>
            ))}
            <div className="definition-add-row">
                <SelectField
                    label={t("itemDefinition.addContent")}
                    data-testid="content-add-choice"
                    value={adding}
                    options={[
                        { value: "", label: t("itemDefinition.addContent") },
                        ...candidates(contents.length),
                    ]}
                    disabled={!carrier || contents.length >= 64}
                    onValueChange={setAdding}
                />
                <DefinitionAction
                    icon={Plus}
                    label={t("itemDefinition.addContent")}
                    testId="content-add"
                    disabled={
                        !carrier ||
                        contents.length >= 64 ||
                        !adding ||
                        !!contentsEditIssue(document, item, [
                            ...contents,
                            { item: adding, amount: 1 },
                        ])
                    }
                    onClick={() => {
                        setContents((current) => [
                            ...current,
                            { item: adding, amount: 1 },
                        ]);
                        setAdding("");
                    }}
                />
            </div>
        </details>
    );
}

export function ItemDefinitionEditor({
    document,
    item,
}: {
    document: ProjectDocument;
    item: ItemNode;
}) {
    const { t } = useTranslation();
    const [addingSchema, setAddingSchema] = useState("");
    const update: UpdateDefinition = (edit) =>
        useEditorStore.getState().updateItem(item.uuid, (current) => ({
            ...current,
            definition: edit(current.definition),
        }));
    const instance = item.definition.instance;
    const keys = itemDataKeys(document, item);
    const issues = definitionReferenceIssues(document, item);
    const bindings = (index: number) =>
        document.dataSchemas.map((schema) => {
            const candidate = replaceBinding(item.definition, index, {
                id: schema.id,
                version: schema.version,
            });
            const error = bindingIssue(document, candidate.instance.schemas);
            return {
                value: schema.uuid,
                label: `${schema.id}@${schema.version}`,
                disabled: !!error && error !== "missingSchema",
            };
        });
    return (
        <section className="item-definition" data-testid="item-definition">
            <h3>{t("itemDefinition.heading")}</h3>
            <label className="definition-field">
                <span>{t("itemDefinition.mode")}</span>
                <SelectField
                    label={t("itemDefinition.mode")}
                    value={instance.mode}
                    data-testid="instance-mode"
                    options={["FUNGIBLE", "UNIQUE"].map((mode) => ({
                        value: mode,
                        label: t(`itemDefinition.${mode}`),
                    }))}
                    onValueChange={(mode) => {
                        if (commitInlineEditor())
                            update((current) =>
                                setInstanceMode(
                                    current,
                                    mode as typeof instance.mode,
                                ),
                            );
                    }}
                />
            </label>
            <div className="definition-row-heading">
                <span className="muted small">
                    {t("itemDefinition.identity", {
                        generator:
                            instance.idGenerator ??
                            t("itemDefinition.noIdentity"),
                    })}
                </span>
                {instance.idGenerator !==
                    (instance.mode === "UNIQUE" ? "UUID_V4" : null) && (
                    <DefinitionAction
                        icon={RotateCcw}
                        label={t("itemDefinition.repairIdentity")}
                        onClick={() =>
                            update((current) =>
                                setInstanceMode(current, current.instance.mode),
                            )
                        }
                    />
                )}
            </div>
            {instance.mode === "UNIQUE" && (
                <p className="muted small">{t("itemDefinition.uniqueStack")}</p>
            )}
            <details
                className="definition-section"
                data-testid="item-schema-bindings"
            >
                <summary>{t("itemDefinition.schemas")}</summary>
                {instance.schemas.map((ref, index) => (
                    <div
                        className="definition-add-row"
                        key={`${ref.id}-${index}`}
                    >
                        <SelectField
                            label={t("itemDefinition.schemaVersion")}
                            data-testid={`schema-binding-${index}`}
                            value={
                                document.dataSchemas.find(
                                    (schema) =>
                                        schema.id === ref.id &&
                                        schema.version === ref.version,
                                )?.uuid ?? `${ref.id}@${ref.version}`
                            }
                            options={bindings(index)}
                            onValueChange={(uuid) => {
                                const schema = document.dataSchemas.find(
                                    (entry) => entry.uuid === uuid,
                                );
                                if (schema && commitInlineEditor())
                                    update((current) =>
                                        replaceBinding(current, index, {
                                            id: schema.id,
                                            version: schema.version,
                                        }),
                                    );
                            }}
                        />
                        <DefinitionAction
                            label={t("itemDefinition.removeBinding")}
                            testId={`schema-binding-${index}-remove`}
                            onClick={() =>
                                update((current) =>
                                    replaceBinding(current, index, null),
                                )
                            }
                        />
                    </div>
                ))}
                <div className="definition-add-row">
                    <SelectField
                        label={t("itemDefinition.addBinding")}
                        data-testid="schema-add-choice"
                        value={addingSchema}
                        options={[
                            {
                                value: "",
                                label: t("itemDefinition.addBinding"),
                            },
                            ...bindings(instance.schemas.length),
                        ]}
                        onValueChange={setAddingSchema}
                    />
                    <DefinitionAction
                        icon={Plus}
                        label={t("itemDefinition.addBinding")}
                        testId="schema-add"
                        disabled={
                            !bindings(instance.schemas.length).some(
                                (option) =>
                                    option.value === addingSchema &&
                                    !option.disabled,
                            )
                        }
                        onClick={() => {
                            const schema = document.dataSchemas.find(
                                (entry) => entry.uuid === addingSchema,
                            );
                            if (schema)
                                update((current) =>
                                    replaceBinding(
                                        current,
                                        current.instance.schemas.length,
                                        {
                                            id: schema.id,
                                            version: schema.version,
                                        },
                                    ),
                                );
                            setAddingSchema("");
                        }}
                    />
                </div>
            </details>
            {issues.length > 0 && (
                <div
                    className="definition-diagnostics"
                    data-testid="definition-reference-issues"
                >
                    {issues.map((issue) => (
                        <p
                            className="error small"
                            key={`${issue.code}:${issue.detail}`}
                        >
                            {t(`itemDefinition.errors.${issue.code}`, {
                                detail: issue.detail,
                            })}
                        </p>
                    ))}
                </div>
            )}
            <Assignments
                item={item}
                keys={keys}
                scope="DEFINITION"
                update={update}
            />
            <Assignments
                item={item}
                keys={keys}
                scope="INSTANCE"
                update={update}
            />
            <Generators item={item} keys={keys} update={update} />
            <Contents document={document} item={item} update={update} />
            <BaseComponentEditor
                definition={item.definition}
                owner={item.uuid}
                update={update}
            />
        </section>
    );
}

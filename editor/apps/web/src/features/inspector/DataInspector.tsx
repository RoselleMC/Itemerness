import { useTranslation } from "react-i18next";
import type { DataTypeNode, DataValue } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { humanizePath, resolveMessage } from "../common/messages.js";

/**
 * Data key editing, scoped to what content editors actually decide: the human label every item
 * shows for the key, and its default value. Type, scope, and constraints define what plugins wrote
 * into the schema — shown for understanding, folded as read-only, because changing them is an API
 * migration and not a wording tweak.
 */

function typeText(node: DataTypeNode): string {
    switch (node.kind) {
        case "list":
            return `list<${typeText(node.element)}>`;
        case "compound":
            return "compound";
        case "namespacedKey":
            return "key";
        default:
            return node.kind;
    }
}

function scalarToText(value: DataValue | null): string | null {
    if (!value) return null;
    switch (value.kind) {
        case "integer":
        case "decimal":
            return value.value;
        case "string":
            return value.value;
        case "boolean":
            return String(value.value);
        default:
            return null;
    }
}

export function DataInspector() {
    const { t } = useTranslation();
    const store = useEditorStore();
    const doc = store.document;
    const dataKey = doc.dataSchemas
        .flatMap((schema) => schema.keys)
        .find((key) => key.id === store.selectedDataKeyId);

    if (!dataKey) {
        return (
            <aside className="inspector">
                <p className="muted">{t("stage.noItem")}</p>
            </aside>
        );
    }

    const path = dataKey.id.split(":").pop() ?? dataKey.id;
    const labelKey = `data.${path}.label`;
    const label = resolveMessage(doc, store.viewerLocale, labelKey);
    const usedBy = doc.items.filter((item) =>
        item.presentation.blocks.some(
            (block) => "data" in block && block.data === dataKey.id,
        ),
    );
    const defaultText = scalarToText(dataKey.defaultValue);

    const commitDefault = (raw: string) => {
        const current = dataKey.defaultValue;
        if (!current) return;
        let next: DataValue | null = null;
        if (current.kind === "integer" && /^-?\d+$/.test(raw))
            next = { kind: "integer", value: raw };
        if (current.kind === "decimal" && /^-?\d+(\.\d+)?$/.test(raw))
            next = { kind: "decimal", value: raw };
        if (current.kind === "string") next = { kind: "string", value: raw };
        if (current.kind === "boolean")
            next = { kind: "boolean", value: raw === "true" };
        if (!next) return;
        store.updateDataKey(dataKey.id, (key) => ({
            ...key,
            defaultValue: next,
        }));
    };

    return (
        <aside className="inspector" aria-label={t("inspector.data.heading")}>
            <section>
                <h3>{t("inspector.data.heading")}</h3>
                <p className="library-title">
                    {label.source === "missing"
                        ? humanizePath(path)
                        : label.text}
                    <span className="tag">{typeText(dataKey.type)}</span>
                    <span className="tag">
                        {dataKey.scope === "INSTANCE"
                            ? t("inspector.data.instance")
                            : t("inspector.data.definition")}
                    </span>
                </p>
                <p className="muted small">
                    {t("inspector.layout.usedBy", { count: usedBy.length })}
                </p>
            </section>

            <section>
                <h3>{t("inspector.data.label")}</h3>
                <input
                    value={label.source === "own" ? label.text : ""}
                    placeholder={
                        label.source === "missing"
                            ? humanizePath(path)
                            : label.text
                    }
                    onChange={(event) =>
                        store.setMessage(
                            store.viewerLocale,
                            labelKey,
                            event.target.value,
                        )
                    }
                    data-testid="data-label-input"
                />
                <p className="muted small">
                    {label.source === "own"
                        ? t("inspector.name.editingIn", {
                              locale: store.viewerLocale,
                          })
                        : t("inspector.name.inherited", {
                              locale: label.sourceLocale ?? doc.defaultLocale,
                          })}
                </p>
                <p className="muted small">{t("inspector.data.labelHint")}</p>
            </section>

            {defaultText !== null ? (
                <section>
                    <h3>{t("inspector.data.defaultValue")}</h3>
                    {dataKey.defaultValue?.kind === "boolean" ? (
                        <label className="toggle-row">
                            <input
                                type="checkbox"
                                checked={dataKey.defaultValue.value}
                                onChange={(event) =>
                                    commitDefault(String(event.target.checked))
                                }
                            />
                            {t("inspector.data.defaultValue")}
                        </label>
                    ) : (
                        <input
                            value={defaultText}
                            onChange={(event) =>
                                commitDefault(event.target.value)
                            }
                            data-testid="data-default-input"
                        />
                    )}
                    <p className="muted small">
                        {t("inspector.data.defaultHint")}
                    </p>
                </section>
            ) : null}

            <details className="advanced">
                <summary>{t("inspector.advanced.heading")}</summary>
                <dl>
                    <dt>ID</dt>
                    <dd>
                        <code>{dataKey.id}</code>
                    </dd>
                    <dt>{t("inspector.data.affectsStacking")}</dt>
                    <dd>{String(dataKey.affectsStacking)}</dd>
                    <dt>{t("inspector.data.presentationReadable")}</dt>
                    <dd>{String(dataKey.presentationReadable)}</dd>
                    {dataKey.constraints.minimum !== null ||
                    dataKey.constraints.maximum !== null ? (
                        <>
                            <dt>{t("inspector.data.range")}</dt>
                            <dd>
                                {dataKey.constraints.minimum ?? "−∞"} …{" "}
                                {dataKey.constraints.maximum ?? "+∞"}
                            </dd>
                        </>
                    ) : null}
                    {dataKey.constraints.allowedValues.length > 0 ? (
                        <>
                            <dt>{t("inspector.data.allowed")}</dt>
                            <dd>
                                {dataKey.constraints.allowedValues
                                    .map(
                                        (value) =>
                                            scalarToText(value) ?? value.kind,
                                    )
                                    .map((value) => value.split(":").pop())
                                    .join(", ")}
                            </dd>
                        </>
                    ) : null}
                </dl>
            </details>
        </aside>
    );
}

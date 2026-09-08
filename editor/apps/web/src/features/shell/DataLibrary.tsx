import { useTranslation } from "react-i18next";
import { useEditorStore } from "../../state/store.js";
import { describeContext } from "../../state/interface.js";
import { dataKeyReferences } from "../inspector/dataKeyEditing.js";
import { humanizePath, resolveMessage } from "../common/messages.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import {
    dataKeyActions,
    dataSchemaActions,
} from "../common/dataLibraryActions.js";

export function DataLibrary({ query }: { query: string }) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const matches = (text: string) =>
        text.toLowerCase().includes(query.toLowerCase());
    return (
        <>
            <ul
                className="item-list data-schema-library"
                data-testid="data-list"
            >
                {store.document.dataSchemas.map((schema) => {
                    const rows = schema.keys
                        .map((key) => {
                            const labels = dataKeyReferences(
                                store.document,
                                key.uuid,
                            ).labels;
                            const resolved =
                                labels.length === 1
                                    ? resolveMessage(
                                          store.document,
                                          store.viewerLocale,
                                          labels[0]!,
                                      )
                                    : null;
                            return {
                                key,
                                name:
                                    resolved && resolved.source !== "missing"
                                        ? resolved.text
                                        : humanizePath(key.id.split(":")[1]!),
                            };
                        })
                        .filter(
                            (row) =>
                                matches(row.key.id) ||
                                matches(row.name) ||
                                matches(schema.id),
                        );
                    if (!rows.length && !matches(schema.id)) return null;
                    return (
                        <li key={schema.uuid} className="data-schema-group">
                            <button
                                type="button"
                                className={`data-schema-heading ${store.selectedDataSchemaUuid === schema.uuid && store.selectedDataKeyUuid === null ? "selected" : ""}`}
                                data-testid={`schema-${schema.uuid}`}
                                onClick={() => {
                                    if (commitInlineEditor())
                                        store.selectDataSchema(schema.uuid);
                                }}
                                onContextMenu={(event) => {
                                    if (!commitInlineEditor()) {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        return;
                                    }
                                    describeContext(event, {
                                        label: schema.id,
                                        items: dataSchemaActions(
                                            schema.uuid,
                                            t,
                                        ),
                                    });
                                }}
                            >
                                <span>{schema.id}</span>
                                <span>@ {schema.version}</span>
                            </button>
                            <ul>
                                {rows.map(({ key, name }) => (
                                    <li key={key.uuid}>
                                        <button
                                            type="button"
                                            className={`item-row ${store.selectedDataKeyUuid === key.uuid ? "selected" : ""}`}
                                            data-testid={`datakey-${key.id.split(":")[1]}`}
                                            data-node-uuid={key.uuid}
                                            onClick={() => {
                                                if (commitInlineEditor())
                                                    store.selectDataKey(
                                                        key.uuid,
                                                    );
                                            }}
                                            onContextMenu={(event) => {
                                                if (!commitInlineEditor()) {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    return;
                                                }
                                                describeContext(event, {
                                                    label: name,
                                                    items: dataKeyActions(
                                                        key.uuid,
                                                        t,
                                                    ),
                                                });
                                            }}
                                        >
                                            <span className="item-row-text">
                                                <span className="item-row-name">
                                                    {name}
                                                </span>
                                                <span className="item-row-note">
                                                    {key.id}
                                                </span>
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </li>
                    );
                })}
            </ul>
        </>
    );
}

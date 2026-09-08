import { Copy, Plus, Trash2 } from "lucide-react";
import type { TFunction } from "i18next";
import { useEditorStore } from "../../state/store.js";
import { confirmAction, type MenuAction } from "../../state/interface.js";
import {
    keyReferenceItems,
    newDataKey,
    newDataSchema,
    removeDataKey,
    removeDataSchema,
    schemaItems,
} from "../../state/dataLibrary.js";
import { commitInlineEditor } from "./inlineEdit.js";
import { copyAction, relatedItems } from "./contextActions.js";

export function addSchema(sourceUuid?: string) {
    if (!commitInlineEditor()) return;
    const store = useEditorStore.getState();
    const source = sourceUuid
        ? store.document.dataSchemas.find(
              (schema) => schema.uuid === sourceUuid,
          )
        : undefined;
    if (sourceUuid && !source) return;
    const schema = newDataSchema(store.document, source);
    store.updateDocument((document) => ({
        ...document,
        dataSchemas: [...document.dataSchemas, schema],
    }));
    store.selectDataSchema(schema.uuid);
}

export function addKey(schemaUuid: string, sourceUuid?: string) {
    if (!commitInlineEditor()) return;
    const store = useEditorStore.getState();
    const schema = store.document.dataSchemas.find(
        (entry) => entry.uuid === schemaUuid,
    );
    const source = sourceUuid
        ? schema?.keys.find((key) => key.uuid === sourceUuid)
        : undefined;
    if (!schema || (sourceUuid && !source)) return;
    const key = newDataKey(store.document, source);
    store.updateDocument((document) => ({
        ...document,
        dataSchemas: document.dataSchemas.map((entry) =>
            entry.uuid === schemaUuid
                ? { ...entry, keys: [...entry.keys, key] }
                : entry,
        ),
    }));
    store.selectDataKey(key.uuid);
}

async function deleteNode(
    kind: "schema" | "key",
    uuid: string,
    id: string,
    t: TFunction,
) {
    if (
        !commitInlineEditor() ||
        !(await confirmAction({
            title: t(
                `dataLibrary.delete${kind === "schema" ? "Schema" : "Key"}`,
            ),
            message: t("dataLibrary.deleteConfirm", { id }),
            accept: t("menus.delete"),
        }))
    )
        return;
    const store = useEditorStore.getState();
    store.updateDocument((document) =>
        kind === "schema"
            ? removeDataSchema(document, uuid)
            : removeDataKey(document, uuid),
    );
    if (kind === "schema" && store.selectedDataSchemaUuid === uuid) {
        const next = useEditorStore.getState().document.dataSchemas[0];
        if (next) store.selectDataSchema(next.uuid);
        else
            useEditorStore.setState({
                selectedDataSchemaUuid: null,
                selectedDataKeyUuid: null,
            });
    } else if (
        kind === "key" &&
        store.selectedDataKeyUuid === uuid &&
        store.selectedDataSchemaUuid
    )
        store.selectDataSchema(store.selectedDataSchemaUuid);
}

export function dataSchemaActions(uuid: string, t: TFunction): MenuAction[] {
    const document = useEditorStore.getState().document;
    const schema = document.dataSchemas.find((entry) => entry.uuid === uuid);
    if (!schema) return [];
    const items = schemaItems(document, schema);
    return [
        copyAction("copy-id", t("menus.copyId"), schema.id),
        {
            id: "add-key",
            label: t("dataLibrary.addKey"),
            icon: Plus,
            run: () => addKey(uuid),
        },
        {
            id: "duplicate-schema",
            label: t("dataLibrary.duplicateSchema"),
            icon: Copy,
            run: () => addSchema(uuid),
        },
        relatedItems(items, t),
        {
            id: "delete-schema",
            label: t("dataLibrary.deleteSchema"),
            icon: Trash2,
            danger: true,
            separator: true,
            disabled: items.length > 0,
            run: () => deleteNode("schema", uuid, schema.id, t),
        },
    ];
}

export function dataKeyActions(uuid: string, t: TFunction): MenuAction[] {
    const document = useEditorStore.getState().document;
    const schema = document.dataSchemas.find((entry) =>
        entry.keys.some((key) => key.uuid === uuid),
    );
    const key = schema?.keys.find((entry) => entry.uuid === uuid);
    if (!schema || !key) return [];
    const items = keyReferenceItems(document, schema, key);
    return [
        copyAction("copy-id", t("menus.copyId"), key.id),
        {
            id: "duplicate-key",
            label: t("dataLibrary.duplicateKey"),
            icon: Copy,
            run: () => addKey(schema.uuid, uuid),
        },
        relatedItems(items, t),
        {
            id: "delete-key",
            label: t("dataLibrary.deleteKey"),
            icon: Trash2,
            danger: true,
            separator: true,
            disabled: items.length > 0,
            run: () => deleteNode("key", uuid, key.id, t),
        },
    ];
}

import { itemKey, itemLayout, itemTheme } from "@itemerness/protocol";
import type {
    DataTypeNode,
    ItemNode,
    PresentationBlock,
    ProjectDocument,
} from "@itemerness/protocol";
import { useEditorStore } from "./store.js";
import { humanizePath } from "../features/common/messages.js";
import {
    editBlockTree,
    insertBlockTree,
    locateBlock,
    moveBlockTree,
    type ContentInsertionTarget,
} from "./blocks.js";

export type ContentKind = PresentationBlock["type"];

function compoundPath(type: DataTypeNode): string | null {
    if (type.kind !== "compound") return null;
    if (type.fields === null) return "value";
    for (const field of type.fields) {
        if (!/^[a-zA-Z0-9_-]+$/.test(field.name)) continue;
        if (field.type.kind !== "compound") return field.name;
        const child = compoundPath(field.type);
        if (child) return `${field.name}.${child}`;
    }
    return null;
}

export function contentSources(document: ProjectDocument, item: ItemNode) {
    const keys = document.dataSchemas
        .filter((schema) =>
            item.definition.instance.schemas.some(
                (reference) =>
                    reference.id === schema.id &&
                    reference.version === schema.version,
            ),
        )
        .flatMap((schema) => schema.keys)
        .filter((key) => key.presentationReadable);
    const repeat = keys.flatMap((key) => {
        const path =
            key.type.kind === "list" ? compoundPath(key.type.element) : null;
        return path ? [{ key, path }] : [];
    })[0];
    return { keys, repeat };
}

export function canInsertContent(
    document: ProjectDocument,
    item: ItemNode,
    kind: ContentKind,
): boolean {
    const { keys, repeat } = contentSources(document, item);
    if (kind === "field" || kind === "text") return keys.length > 0;
    if (kind === "repeat") return repeat !== undefined;
    if (kind === "nestedItemList") return item.definition.contents.length > 0;
    return true;
}

function selection() {
    const state = useEditorStore.getState();
    const item = state.document.items.find(
        (entry) =>
            itemKey(state.document, entry) === state.selectedItemId,
    );
    const location =
        item && state.selectedBlockUuid
            ? locateBlock(item.presentation.blocks, state.selectedBlockUuid)
            : null;
    return item && location ? { state, item, location } : null;
}
export function insertContent(
    kind: ContentKind,
    anchor: ContentInsertionTarget,
    position: "before" | "after",
    defaultText: string,
) {
    const state = useEditorStore.getState();
    const item = state.document.items.find(
        (entry) =>
            itemKey(state.document, entry) === state.selectedItemId,
    );
    if (!item || !canInsertContent(state.document, item, kind)) return;
    const target =
        typeof anchor === "string"
            ? anchor === "__name" ||
              locateBlock(item.presentation.blocks, anchor)
            : locateBlock(item.presentation.blocks, anchor.parentUuid)?.block
                  .type === "conditional";
    if (!target) return;
    const uuid = crypto.randomUUID(),
        message = `item.text.${uuid}`;
    const { keys, repeat } = contentSources(state.document, item);
    const dataKey = keys[0]?.id;
    const fact =
        state.document.viewerFacts.find((entry) =>
            ["INTEGER", "LONG"].includes(entry.type),
        ) ?? state.document.viewerFacts[0];
    const theme = state.document.themes.find(
        (entry) => entry.id === itemTheme(state.document, item),
    );
    const layout = state.document.layouts.find(
        (entry) => entry.id === itemLayout(state.document, item),
    );
    const wrapping =
        layout && Object.hasOwn(layout.wrapping, "body") ? "body" : null;
    const text: PresentationBlock = {
        uuid,
        type: "description",
        message,
        style:
            theme && Object.hasOwn(theme.styles, "description")
                ? "description"
                : null,
        anchor: null,
        wrapping,
    };
    const numeric = fact && ["INTEGER", "LONG"].includes(fact.type);
    const block: PresentationBlock =
        kind === "text"
            ? {
                  uuid,
                  type: "text",
                  data: dataKey!,
                  style: null,
                  anchor: null,
                  wrapping,
                  unbreakable: false,
                  missingPolicy: "OMIT",
              }
            : kind === "repeat"
              ? {
                    uuid,
                    type: "repeat",
                    data: repeat!.key.id,
                    maximumElements: Math.max(
                        1,
                        Math.min(
                            state.document.budgets.maximumRepeatElements,
                            repeat!.key.constraints.maximumElements ??
                                state.document.budgets.maximumRepeatElements,
                        ),
                    ),
                    template: {
                        labelMessage: message,
                        missingMessage: `${message}.missing`,
                        valuePath: repeat!.path,
                        icon: null,
                        format: null,
                    },
                    style: null,
                    anchor: null,
                    missingPolicy: "OMIT",
                }
              : kind === "nestedItemList"
                ? { uuid, type: "nestedItemList", style: null, anchor: null }
                : kind === "field"
                  ? {
                        uuid,
                        type: "field",
                        labelMessage: message,
                        data: dataKey!,
                        format: null,
                        icon: null,
                        style: null,
                        anchor: null,
                        wrapping,
                        missingPolicy: "OMIT",
                    }
                  : kind === "conditional"
                    ? {
                          uuid,
                          type: "conditional",
                          condition: {
                              operator: numeric
                                  ? "GREATER_THAN_OR_EQUAL"
                                  : fact
                                    ? "EXISTS"
                                    : "EQUALS",
                              left: fact
                                  ? { kind: "fact", key: fact.id }
                                  : {
                                        kind: "literal",
                                        value: { kind: "boolean", value: true },
                                    },
                              right: !fact
                                  ? {
                                        kind: "literal",
                                        value: { kind: "boolean", value: true },
                                    }
                                  : numeric
                                    ? {
                                          kind: "literal",
                                          value: {
                                              kind: "integer",
                                              value: "1",
                                          },
                                      }
                                    : null,
                          },
                          thenBlocks: [{ ...text, uuid: crypto.randomUUID() }],
                          otherwiseBlocks: [],
                          style: null,
                          anchor: null,
                      }
                    : text;
    const messages: Record<string, string> =
        kind === "text" || kind === "nestedItemList"
            ? {}
            : kind === "repeat"
              ? {
                    [message]: humanizePath(repeat!.path),
                    [`${message}.missing`]: defaultText,
                }
              : {
                    [message]:
                        kind === "field"
                            ? humanizePath(dataKey!.split(":").pop()!)
                            : defaultText,
                };
    const transaction = state.beginTransaction();
    state.updateDocument((document) => ({
        ...document,
        locales: document.locales.map((locale) =>
            locale.locale === document.defaultLocale
                ? {
                      ...locale,
                      messages: {
                          ...locale.messages,
                          ...messages,
                      },
                  }
                : locale,
        ),
        items: document.items.map((entry) =>
            entry.uuid === item.uuid
                ? {
                      ...entry,
                      presentation: {
                          ...entry.presentation,
                          blocks: insertBlockTree(
                              entry.presentation.blocks,
                              anchor,
                              block,
                              position,
                          ),
                      },
                  }
                : entry,
        ),
    }));
    state.selectBlock(uuid);
    state.commitTransaction(transaction);
}
export function moveSelectedContent(delta: number) {
    const selected = selection();
    if (!selected) return;
    const { state, item, location } = selected;
    state.setEditGroup(null);
    state.updateItem(item.uuid, (current) => ({
        ...current,
        presentation: {
            ...current.presentation,
            blocks: moveBlockTree(
                current.presentation.blocks,
                location.block.uuid,
                delta,
            ),
        },
    }));
}
export function deleteSelectedContent() {
    const selected = selection();
    if (!selected) return;
    const { state, item, location } = selected;
    state.setEditGroup(null);
    state.updateItem(item.uuid, (current) => ({
        ...current,
        presentation: {
            ...current.presentation,
            blocks: editBlockTree(
                current.presentation.blocks,
                location.block.uuid,
                () => null,
            ),
        },
    }));
}
export function duplicateSelectedContent() {
    const selected = selection();
    if (!selected) return;
    const { state, item, location } = selected;
    const messages = new Map<string, string>();
    const key = (original: string) => {
        if (!messages.has(original))
            messages.set(
                original,
                `item.copy.${crypto.randomUUID()}`,
            );
        return messages.get(original)!;
    };
    const clone = (source: PresentationBlock): PresentationBlock => {
        const block = { ...structuredClone(source), uuid: crypto.randomUUID() };
        if (block.type === "description") block.message = key(block.message);
        if (block.type === "field")
            block.labelMessage = key(block.labelMessage);
        if (block.type === "repeat") {
            block.template.labelMessage = key(block.template.labelMessage);
            if (block.template.missingMessage)
                block.template.missingMessage = key(
                    block.template.missingMessage,
                );
        }
        if (block.type === "conditional") {
            block.thenBlocks = block.thenBlocks.map(clone);
            block.otherwiseBlocks = block.otherwiseBlocks.map(clone);
        }
        return block;
    };
    const block = clone(location.block);
    const transaction = state.beginTransaction();
    state.updateDocument((document) => ({
        ...document,
        locales: document.locales.map((locale) => ({
            ...locale,
            messages: {
                ...locale.messages,
                ...Object.fromEntries(
                    [...messages]
                        .filter(([from]) =>
                            Object.hasOwn(locale.messages, from),
                        )
                        .map(([from, to]) => [to, locale.messages[from]!]),
                ),
            },
        })),
        items: document.items.map((entry) =>
            entry.uuid === item.uuid
                ? {
                      ...entry,
                      presentation: {
                          ...entry.presentation,
                          blocks: insertBlockTree(
                              entry.presentation.blocks,
                              location.block.uuid,
                              block,
                          ),
                      },
                  }
                : entry,
        ),
    }));
    state.selectBlock(block.uuid);
    state.commitTransaction(transaction);
}

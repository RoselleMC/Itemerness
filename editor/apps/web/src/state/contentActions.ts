import type { PresentationBlock } from "@itemerness/protocol";
import { useEditorStore } from "./store.js";
import { humanizePath } from "../features/common/messages.js";
import {
    editBlockTree,
    insertBlockTree,
    locateBlock,
    moveBlockTree,
} from "./blocks.js";

function selection() {
    const state = useEditorStore.getState();
    const item = state.document.items.find(
        (entry) =>
            `${state.document.namespace}:${entry.id}` === state.selectedItemId,
    );
    const location =
        item && state.selectedBlockUuid
            ? locateBlock(item.presentation.blocks, state.selectedBlockUuid)
            : null;
    return item && location ? { state, item, location } : null;
}
export function insertContent(
    kind: "field" | "description" | "conditional",
    anchor: string,
    position: "before" | "after",
    defaultText: string,
) {
    const state = useEditorStore.getState();
    const item = state.document.items.find(
        (entry) =>
            `${state.document.namespace}:${entry.id}` === state.selectedItemId,
    );
    if (
        !item ||
        (anchor !== "__name" && !locateBlock(item.presentation.blocks, anchor))
    )
        return;
    const uuid = crypto.randomUUID(),
        message = `item.${item.id}.text.${uuid.slice(0, 8)}`;
    const dataKey = state.document.dataSchemas
        .flatMap((schema) => schema.keys)
        .find((key) => key.presentationReadable)?.id;
    const fact =
        state.document.viewerFacts.find((entry) =>
            ["INTEGER", "LONG"].includes(entry.type),
        ) ?? state.document.viewerFacts[0];
    if ((kind === "field" && !dataKey) || (kind === "conditional" && !fact))
        return;
    const theme = state.document.themes.find(
        (entry) => entry.id === item.presentation.theme,
    );
    const layout = state.document.layouts.find(
        (entry) => entry.id === item.presentation.layout,
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
        kind === "field"
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
                        operator: numeric ? "GREATER_THAN_OR_EQUAL" : "EXISTS",
                        left: { kind: "fact", key: fact!.id },
                        right: numeric
                            ? {
                                  kind: "literal",
                                  value: { kind: "integer", value: "1" },
                              }
                            : null,
                    },
                    thenBlocks: [{ ...text, uuid: crypto.randomUUID() }],
                    otherwiseBlocks: [],
                    style: null,
                    anchor: null,
                }
              : text;
    const transaction = state.beginTransaction();
    state.updateDocument((document) => ({
        ...document,
        locales: document.locales.map((locale) =>
            locale.locale === document.defaultLocale
                ? {
                      ...locale,
                      messages: {
                          ...locale.messages,
                          [message]:
                              kind === "field"
                                  ? humanizePath(dataKey!.split(":").pop()!)
                                  : defaultText,
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
                `item.${item.id}.copy.${crypto.randomUUID()}`,
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

import type { TFunction } from "i18next";
import type { PresentationBlock } from "@itemerness/protocol";
import { useEditorStore } from "./store.js";
import { confirmAction } from "./interface.js";
import { resolveMessage } from "../features/common/messages.js";

export async function deleteItem(uuid: string, t: TFunction) {
    const state = useEditorStore.getState();
    const item = state.document.items.find((entry) => entry.uuid === uuid);
    if (!item) return;
    const name = resolveMessage(
        state.document,
        state.viewerLocale,
        item.presentation.nameMessage,
    ).text;
    if (
        await confirmAction({
            title: t("menus.deleteItem"),
            message: t("inspector.advanced.deleteConfirm", { name }),
            accept: t("menus.delete"),
        })
    )
        useEditorStore.getState().removeItem(uuid);
}

export function duplicateItem(uuid: string, t: TFunction) {
    const state = useEditorStore.getState();
    const original = state.document.items.find((entry) => entry.uuid === uuid);
    if (!original) return;
    let id = `${original.id}-copy`,
        suffix = 2;
    while (state.document.items.some((entry) => entry.id === id))
        id = `${original.id}-copy-${suffix++}`;
    const messages = new Map<string, string>();
    const key = (source: string) => {
        if (!messages.has(source))
            messages.set(source, `item.${id}.copy.${crypto.randomUUID()}`);
        return messages.get(source)!;
    };
    const clone = (block: PresentationBlock): PresentationBlock => {
        const next = { ...structuredClone(block), uuid: crypto.randomUUID() };
        if (next.type === "field") next.labelMessage = key(next.labelMessage);
        if (next.type === "description") next.message = key(next.message);
        if (next.type === "repeat") {
            next.template.labelMessage = key(next.template.labelMessage);
            if (next.template.missingMessage)
                next.template.missingMessage = key(
                    next.template.missingMessage,
                );
        }
        if (next.type === "conditional") {
            next.thenBlocks = next.thenBlocks.map(clone);
            next.otherwiseBlocks = next.otherwiseBlocks.map(clone);
        }
        return next;
    };
    const nameKey = key(original.presentation.nameMessage);
    const item = {
        ...structuredClone(original),
        uuid: crypto.randomUUID(),
        id,
        presentation: {
            ...original.presentation,
            nameMessage: nameKey,
            blocks: original.presentation.blocks.map(clone),
        },
    };
    const transaction = state.beginTransaction();
    state.updateDocument((document) => ({
        ...document,
        items: [...document.items, item],
        locales: document.locales.map((locale) => {
            const copied = Object.fromEntries(
                [...messages]
                    .filter(([from]) => Object.hasOwn(locale.messages, from))
                    .map(([from, to]) => [to, locale.messages[from]!]),
            );
            if (copied[nameKey] !== undefined)
                copied[nameKey] +=
                    ` (${t("menus.copySuffix", { lng: locale.locale.startsWith("zh") ? "zh-CN" : "en-US" })})`;
            return { ...locale, messages: { ...locale.messages, ...copied } };
        }),
    }));
    state.selectItem(`${state.document.namespace}:${id}`);
    state.commitTransaction(transaction);
}

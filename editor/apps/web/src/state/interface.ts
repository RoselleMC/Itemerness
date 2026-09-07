import { create } from "zustand";
import type { LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { useEditorStore } from "./store.js";
import { useConnectionStore } from "./connection.js";

export interface MenuAction {
    id: string;
    label: string;
    icon?: LucideIcon;
    disabled?: boolean;
    danger?: boolean;
    checked?: boolean;
    separator?: boolean;
    children?: MenuAction[];
    run?: () => void | Promise<unknown>;
}
export interface MenuDescription {
    label: string;
    items: MenuAction[];
    textExtras?: boolean;
    allowPopup?: boolean;
}
const contexts = new WeakMap<Event, MenuDescription>();
export function describeContext(
    event: MouseEvent,
    description: MenuDescription,
) {
    if (!contexts.has(event.nativeEvent))
        contexts.set(event.nativeEvent, description);
}
export function contextFor(event: Event) {
    return contexts.get(event);
}
export function contextOwner(state = useEditorStore.getState()) {
    const connection = useConnectionStore.getState();
    return JSON.stringify([
        connection.address,
        connection.status,
        connection.info?.serverId,
        state.workspaceEpoch,
        state.snapshotHash,
        state.mode,
        state.selectedItemId,
        state.selectedBlockUuid,
        state.selectedThemeId,
        state.selectedLayoutId,
        state.selectedDataKeyId,
        state.viewerLocale,
        state.packs.map((slot) => slot.pack.id),
    ]);
}
interface Confirmation {
    title: string;
    message: string;
    accept: string;
    owner: string;
    resolve(value: boolean): void;
}
export const useInterface = create<{
    confirmation: Confirmation | null;
    error: string | null;
    closePopups: number;
    connectionRequest: number;
}>(() => ({
    confirmation: null,
    error: null,
    closePopups: 0,
    connectionRequest: 0,
}));
export function confirmAction(
    options: Omit<Confirmation, "resolve" | "owner">,
): Promise<boolean> {
    useInterface.getState().confirmation?.resolve(false);
    return new Promise((resolve) =>
        useInterface.setState({
            confirmation: { ...options, resolve, owner: contextOwner() },
            closePopups: useInterface.getState().closePopups + 1,
        }),
    );
}
export function resolveConfirmation(value: boolean) {
    const confirmation = useInterface.getState().confirmation;
    useInterface.setState({ confirmation: null });
    confirmation?.resolve(value && confirmation.owner === contextOwner());
}
export function runMenuAction(action: MenuAction) {
    if (action.disabled || !action.run) return;
    try {
        const result = action.run();
        if (result instanceof Promise)
            void result.catch(() =>
                useInterface.setState({ error: "menus.actionFailed" }),
            );
    } catch {
        useInterface.setState({ error: "menus.actionFailed" });
    }
}

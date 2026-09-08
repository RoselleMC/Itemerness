import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import {
    Copy,
    Save,
    Undo2,
    Redo2,
    Settings,
    Plug,
    Unplug,
    Plus,
    Scan,
    ZoomIn,
    ZoomOut,
    PanelLeft,
    Info,
} from "lucide-react";
import { useEditorStore, type EditorMode } from "../state/store.js";
import { useConnectionStore } from "../state/connection.js";
import { usePreferences } from "../state/preferences.js";
import { openItemCreation } from "../state/itemActions.js";
import {
    runMenuAction,
    useInterface,
    type MenuAction,
} from "../state/interface.js";
import { commitInlineEditor } from "../features/common/inlineEdit.js";
import { isTextControl, textMenu } from "../features/common/textMenu.js";
import type { DocumentSync } from "../features/document/useDocumentSync.js";
import type { WorkspacePage } from "../features/shell/PrimaryNavigation.js";
import { windowAction, type WindowPlatform } from "./chrome.js";
import { createFullscreenToggle } from "./fullscreen.js";

export interface ApplicationMenuGroup {
    id: string;
    label: string;
    items: MenuAction[];
}
export interface ApplicationMenu {
    groups: ApplicationMenuGroup[];
    refreshContext(): void;
    error: boolean;
}

export function useApplicationMenu({
    sync,
    platform,
    blocked,
    page,
    showPage,
    navigationExpanded,
    toggleNavigation,
    disconnect,
    about,
}: {
    sync: DocumentSync;
    platform: WindowPlatform;
    blocked: boolean;
    page: WorkspacePage;
    showPage(page: WorkspacePage): void;
    navigationExpanded: boolean;
    toggleNavigation(): void;
    disconnect(): void;
    about(): void;
}): ApplicationMenu {
    const { t } = useTranslation();
    const state = useEditorStore();
    const connection = useConnectionStore();
    const preferences = usePreferences();
    const [error, setError] = useState(false);
    const [, refresh] = useState(0);
    const focus = useRef<Element | null>(null);
    const fullscreen = useRef<ReturnType<typeof createFullscreenToggle> | null>(
        null,
    );
    const mac =
        platform === "macos" ||
        (platform === "browser" &&
            /Macintosh|Mac OS X/.test(navigator.userAgent));
    const mod = mac ? "Cmd" : "Ctrl";
    const ready = sync.ready && !blocked;
    const canvas = ready && page === "editor";
    const text =
        isTextControl(focus.current) &&
        focus.current.isConnected &&
        !focus.current.closest("[hidden],[inert]")
            ? textMenu(focus.current, t)
            : [];
    const textAction = (id: string) => text.find((entry) => entry.id === id);
    const go = (next: WorkspacePage, mode?: EditorMode) => {
        if (!commitInlineEditor()) return;
        if (mode) useEditorStore.getState().setMode(mode);
        showPage(next);
    };
    const canvasCommand = (command: string) => {
        if (commitInlineEditor())
            window.dispatchEvent(
                new CustomEvent("editor-canvas-command", { detail: command }),
            );
    };
    const groups: ApplicationMenuGroup[] = [
        {
            id: "file",
            label: t("applicationMenu.file"),
            items: [
                {
                    id: "new-item",
                    label: t("applicationMenu.newItem"),
                    icon: Plus,
                    shortcut: `${mod}+N`,
                    disabled: !ready,
                    run: () => {
                        if (commitInlineEditor()) {
                            go("editor", "items");
                            openItemCreation();
                        }
                    },
                },
                {
                    id: "save-document",
                    label: t("settings.save"),
                    icon: Save,
                    shortcut: `${mod}+S`,
                    disabled:
                        !ready ||
                        state.historyTransactionId !== null ||
                        ["conflict", "offline"].includes(sync.status.kind),
                    run: sync.save,
                },
                {
                    id: "auto-save",
                    label: t("settings.autoSave"),
                    checked: preferences.autoSave,
                    disabled: blocked,
                    run: () => preferences.setAutoSave(!preferences.autoSave),
                },
                {
                    id: "connection",
                    label: t("connection.heading"),
                    icon: Plug,
                    separator: true,
                    shortcut: `${mod}+Shift+K`,
                    disabled: blocked,
                    run: () =>
                        useInterface.setState({
                            connectionRequest:
                                useInterface.getState().connectionRequest + 1,
                        }),
                },
                {
                    id: "disconnect",
                    label: t("connection.disconnect"),
                    icon: Unplug,
                    disabled: blocked || !connection.client,
                    run: disconnect,
                },
                {
                    id: "settings",
                    label: t("sidebar.settings"),
                    icon: Settings,
                    separator: true,
                    shortcut: `${mod}+,`,
                    disabled: blocked,
                    run: () => go("settings"),
                },
                {
                    id: "close-window",
                    label: t("window.close"),
                    shortcut: mac ? "Cmd+W" : "Alt+F4",
                    separator: true,
                    disabled: platform === "browser" || blocked,
                    run: () => windowAction("close"),
                },
            ],
        },
        {
            id: "edit",
            label: t("applicationMenu.edit"),
            items: [
                {
                    id: "undo",
                    label: t("history.undo"),
                    icon: Undo2,
                    shortcut: `${mod}+Z`,
                    disabled:
                        blocked ||
                        (textAction("undo")?.disabled ??
                            (!ready || !state.canUndo)),
                    run:
                        textAction("undo")?.run ??
                        (() => {
                            if (commitInlineEditor()) state.undo();
                        }),
                },
                {
                    id: "redo",
                    label: t("history.redo"),
                    icon: Redo2,
                    shortcut: mac ? "Cmd+Shift+Z" : "Ctrl+Y",
                    disabled:
                        blocked ||
                        (textAction("redo")?.disabled ??
                            (!ready || !state.canRedo)),
                    run:
                        textAction("redo")?.run ??
                        (() => {
                            if (commitInlineEditor()) state.redo();
                        }),
                },
                ...["cut", "copy", "paste", "select-all"].map((id, index) => ({
                    ...(textAction(id) ?? {
                        id,
                        label: t(
                            `menus.${id === "select-all" ? "selectAll" : id}`,
                        ),
                        icon: Copy,
                        disabled: true,
                    }),
                    label: t(`menus.${id === "select-all" ? "selectAll" : id}`),
                    separator: index === 0,
                    shortcut: `${mod}+${["X", "C", "V", "A"][index]}`,
                    disabled:
                        blocked ||
                        !textAction(id) ||
                        textAction(id)!.disabled ||
                        (id === "copy" &&
                            isTextControl(focus.current) &&
                            focus.current.selectionStart ===
                                focus.current.selectionEnd),
                })),
            ],
        },
        {
            id: "view",
            label: t("applicationMenu.view"),
            items: [
                ...(
                    [
                        "items",
                        "themes",
                        "layouts",
                        "data",
                        "formats",
                        "facts",
                    ] as const
                ).map((mode) => ({
                    id: `mode-${mode}`,
                    label: t(`sidebar.mode.${mode}`),
                    disabled: !ready,
                    checked: page === "editor" && state.mode === mode,
                    run: () => go("editor", mode),
                })),
                {
                    id: "assets",
                    label: t("sidebar.assets"),
                    separator: true,
                    disabled: !ready,
                    run: () => go("assets"),
                },
                {
                    id: "translations",
                    label: t("sidebar.translations"),
                    disabled: !ready,
                    run: () => go("translations"),
                },
                {
                    id: "toggle-navigation",
                    label: t("applicationMenu.navigation"),
                    icon: PanelLeft,
                    checked: navigationExpanded,
                    shortcut: `${mod}+B`,
                    disabled: blocked,
                    run: toggleNavigation,
                },
                {
                    id: "zoom-in",
                    label: t("applicationMenu.zoomIn"),
                    icon: ZoomIn,
                    separator: true,
                    shortcut: `${mod}+=`,
                    disabled: !canvas,
                    run: () => canvasCommand("zoom-in"),
                },
                {
                    id: "zoom-out",
                    label: t("applicationMenu.zoomOut"),
                    icon: ZoomOut,
                    shortcut: `${mod}+-`,
                    disabled: !canvas,
                    run: () => canvasCommand("zoom-out"),
                },
                {
                    id: "zoom-reset",
                    label: t("stage.resetZoom"),
                    shortcut: `${mod}+0`,
                    disabled: !canvas,
                    run: () => canvasCommand("zoom-reset"),
                },
                {
                    id: "zoom-fit",
                    label: t("stage.fitZoom"),
                    icon: Scan,
                    disabled: !canvas,
                    run: () => canvasCommand("zoom-fit"),
                },
                {
                    id: "compare",
                    label: t("stage.compare"),
                    separator: true,
                    checked: state.compareLocales,
                    disabled: !canvas || state.document.locales.length < 2,
                    run: () => state.setCompareLocales(!state.compareLocales),
                },
                {
                    id: "geometry",
                    label: t("stage.overlay"),
                    checked: state.annotations,
                    disabled: !canvas,
                    run: () => state.setAnnotations(!state.annotations),
                },
                {
                    id: "fullscreen",
                    label: t("applicationMenu.fullscreen"),
                    separator: true,
                    shortcut: mac ? "Ctrl+Cmd+F" : "F11",
                    disabled: platform === "browser" || blocked,
                    run: () =>
                        (fullscreen.current ??=
                            createFullscreenToggle(getCurrentWindow()))(),
                },
            ],
        },
        {
            id: "help",
            label: t("applicationMenu.help"),
            items: [
                {
                    id: "about",
                    label: t("applicationMenu.about"),
                    icon: Info,
                    disabled: blocked,
                    run: about,
                },
            ],
        },
    ];
    const latest = useRef(groups);
    latest.current = groups;
    const refreshContext = () => {
        const element = document.activeElement;
        if (
            !element?.closest(
                "[data-application-menu],.ui-positioner,.option-menu",
            )
        )
            focus.current = element;
        refresh((value) => value + 1);
    };
    const refreshRef = useRef(refreshContext);
    refreshRef.current = refreshContext;
    useEffect(() => {
        const update = () => refreshRef.current();
        document.addEventListener("focusin", update);
        document.addEventListener("input", update);
        document.addEventListener("selectionchange", update);
        return () => {
            document.removeEventListener("focusin", update);
            document.removeEventListener("input", update);
            document.removeEventListener("selectionchange", update);
        };
    }, []);
    useEffect(() => {
        let active = true;
        let stop: (() => void) | undefined;
        const run = (id: string) => {
            const action = latest.current
                .flatMap((group) => group.items)
                .find((item) => item.id === id);
            if (action) runMenuAction(action);
        };
        if (isTauri())
            void listen<string>("editor-menu", ({ payload }) => {
                if (active) run(payload);
            })
                .then((unlisten) => (active ? (stop = unlisten) : unlisten()))
                .catch(() => {
                    if (active) setError(true);
                });
        const key = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing || event.altKey)
                return;
            const command = event.ctrlKey || event.metaKey;
            let id: string | undefined;
            if (command) {
                if (event.key === "," && !event.shiftKey) id = "settings";
                if (event.key.toLowerCase() === "n" && !event.shiftKey)
                    id = "new-item";
                if (event.key.toLowerCase() === "b" && !event.shiftKey)
                    id = "toggle-navigation";
                if (event.key.toLowerCase() === "k" && event.shiftKey)
                    id = "connection";
                if (["=", "+", "-", "0"].includes(event.key))
                    id =
                        event.key === "-"
                            ? "zoom-out"
                            : event.key === "0"
                              ? "zoom-reset"
                              : "zoom-in";
            } else if (event.key === "F11" && platform === "windows")
                id = "fullscreen";
            if (id) {
                event.preventDefault();
                run(id);
            }
        };
        window.addEventListener("keydown", key);
        return () => {
            active = false;
            stop?.();
            window.removeEventListener("keydown", key);
        };
    }, [platform]);
    const nativeState = JSON.stringify(
        groups.map((group) => ({
            id: group.id,
            label: group.label,
            items: group.items.map(({ id, label, disabled, checked }) => ({
                id,
                label,
                enabled: !disabled,
                checked,
            })),
        })),
    );
    useEffect(() => {
        if (!isTauri()) return;
        let active = true;
        void invoke("update_editor_menu", {
            groups: JSON.parse(nativeState),
        }).catch(() => {
            if (active) setError(true);
        });
        return () => {
            active = false;
        };
    }, [nativeState]);
    return { groups, refreshContext, error };
}

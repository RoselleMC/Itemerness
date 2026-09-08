import {
    cloneElement,
    useLayoutEffect,
    useEffect,
    useRef,
    useState,
    type ComponentProps,
    type ReactElement,
    type MouseEvent,
    type KeyboardEvent,
} from "react";
import { Menu } from "@base-ui/react/menu";
import { useTranslation } from "react-i18next";
import {
    contextFor,
    contextOwner,
    resolveConfirmation,
    useInterface,
    type MenuDescription,
} from "../../state/interface.js";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { MenuItems } from "./MenuItems.js";
import { textMenu, isTextControl } from "./textMenu.js";
import { commitInlineEditor } from "./inlineEdit.js";
import { copyAction } from "./contextActions.js";
import { TooltipLayer } from "./TooltipLayer.js";
import { ToastHost } from "./ToastHost.js";
import { notify } from "../../state/toasts.js";

interface OpenMenu extends MenuDescription {
    x: number;
    y: number;
    owner: string;
    focus: HTMLElement | null;
}
export function InterfaceHost({
    children,
    defaults,
    blocked,
}: {
    children: ReactElement<ComponentProps<"div">>;
    defaults: () => MenuDescription;
    blocked: boolean;
}) {
    const { t } = useTranslation();
    const [model, setModel] = useState<OpenMenu | null>(null);
    const [open, setOpen] = useState(false);
    const ui = useInterface();
    useEditorStore();
    useConnectionStore(
        (state) => `${state.status}:${state.address}:${state.info?.serverId}`,
    );
    const owner = contextOwner();
    useLayoutEffect(() => {
        if (blocked || ui.confirmation || (model && model.owner !== owner))
            setOpen(false);
        if (ui.confirmation && (blocked || ui.confirmation.owner !== owner))
            resolveConfirmation(false);
    }, [blocked, ui.confirmation, owner, model]);
    useEffect(() => () => resolveConfirmation(false), []);
    useEffect(() => {
        if (!ui.error) return;
        notify(t(ui.error), "error", "interface-error");
        const timer = setTimeout(
            () => useInterface.setState({ error: null }),
            5000,
        );
        return () => clearTimeout(timer);
    }, [ui.error, t]);
    const context = (event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (blocked || ui.confirmation || !(event.target instanceof Element))
            return;
        const target = event.target;
        const input = target.closest("input,textarea");
        const specific = contextFor(event.nativeEvent);
        if (
            target.closest("[data-ui-popup]") &&
            !specific?.allowPopup &&
            !isTextControl(input)
        )
            return;
        if (useEditorStore.getState().historyTransactionId !== null) {
            window.dispatchEvent(
                new globalThis.KeyboardEvent("keydown", {
                    key: "Escape",
                    bubbles: true,
                    cancelable: true,
                }),
            );
            return;
        }
        let description = isTextControl(input)
            ? {
                  label: t("menus.editText"),
                  items: [
                      ...textMenu(input, t),
                      ...(specific?.textExtras ? specific.items : []),
                  ],
              }
            : (specific ?? defaults());
        if (!isTextControl(input)) {
            const code = target.closest("code");
            const selection = window.getSelection();
            const text = selection?.toString() || code?.textContent;
            if (text)
                description = {
                    ...description,
                    items: [
                        copyAction("copy-selection", t("menus.copy"), text),
                        ...description.items.map((item, index) =>
                            index === 0 ? { ...item, separator: true } : item,
                        ),
                    ],
                };
        }
        const focus = target.closest<HTMLElement>(
            "input,textarea,button,[tabindex]",
        );
        setModel({
            ...description,
            x: event.clientX,
            y: event.clientY,
            owner: contextOwner(),
            focus,
        });
        setOpen(true);
    };
    const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
        if (
            event.key !== "ContextMenu" &&
            !(event.shiftKey && event.key === "F10")
        )
            return;
        event.preventDefault();
        const target = event.target as HTMLElement;
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(
            new globalThis.MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                button: 2,
                clientX: rect.left + Math.min(24, rect.width / 2),
                clientY: rect.bottom,
            }),
        );
    };
    const prepare = (target: EventTarget | null) => {
        if (
            target instanceof Element &&
            !target.closest(
                ".inline-editor,[data-buffered-value],[data-ui-popup]",
            )
        )
            return commitInlineEditor();
        return true;
    };
    const anchor = {
        getBoundingClientRect: () =>
            DOMRect.fromRect({
                x: model?.x ?? 0,
                y: model?.y ?? 0,
                width: 0,
                height: 0,
            }),
    };
    return (
        <>
            {cloneElement(children, {
                onContextMenu: context,
                onContextMenuCapture: (event) => {
                    if (!prepare(event.target)) {
                        event.preventDefault();
                        event.stopPropagation();
                    }
                },
                onPointerDownCapture: (event) => {
                    // Keep focus on invalid text; context-changing commands also guard their mutations.
                    if (!prepare(event.target)) event.preventDefault();
                },
                onKeyDown: keyboard,
            })}
            <Menu.Root
                open={open}
                onOpenChange={setOpen}
                modal={false}
                triggerId="editor-context-anchor"
            >
                {/* Register the floating-tree identity; positioning and focus use the actual context target. */}
                <Menu.Trigger
                    id="editor-context-anchor"
                    hidden
                    tabIndex={-1}
                    aria-hidden="true"
                >
                    {model?.label}
                </Menu.Trigger>
                <Menu.Portal>
                    <Menu.Positioner
                        anchor={anchor}
                        className="ui-positioner"
                        side="bottom"
                        align="start"
                        collisionPadding={{
                            top: 8,
                            right: 8,
                            bottom: 8,
                            left: 8,
                        }}
                    >
                        <Menu.Popup
                            className="ui-popup"
                            data-ui-popup
                            data-testid="context-menu"
                            onContextMenu={(event) => event.preventDefault()}
                            aria-label={model?.label}
                            finalFocus={() => {
                                const active = document.activeElement;
                                // A closing animation must not steal focus from a newly focused field.
                                if (
                                    active instanceof HTMLElement &&
                                    active !== document.body &&
                                    active !== model?.focus &&
                                    active.id !== "editor-context-anchor" &&
                                    !active.closest("[data-ui-popup]")
                                )
                                    return false;
                                return model?.focus?.isConnected &&
                                    !model.focus.closest("[inert],[hidden]")
                                    ? model.focus
                                    : false;
                            }}
                            onKeyDown={(event) => {
                                if (event.key === "Escape")
                                    event.stopPropagation();
                            }}
                        >
                            <MenuItems items={model?.items ?? []} />
                        </Menu.Popup>
                    </Menu.Positioner>
                </Menu.Portal>
            </Menu.Root>
            {ui.confirmation && !blocked && (
                <ConfirmationDialog key={ui.confirmation.owner} />
            )}
            <TooltipLayer />
            <ToastHost />
        </>
    );
}

function ConfirmationDialog() {
    const { t } = useTranslation();
    const confirmation = useInterface((state) => state.confirmation)!;
    const cancel = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        cancel.current?.focus();
        const key = (event: globalThis.KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                resolveConfirmation(false);
            }
            if (event.key !== "Tab") return;
            const entries = [
                ...document.querySelectorAll<HTMLButtonElement>(
                    ".confirmation-dialog button:not(:disabled),.window-controls button:not(:disabled)",
                ),
            ].filter((element) => element.getClientRects().length);
            const index = entries.indexOf(
                document.activeElement as HTMLButtonElement,
            );
            event.preventDefault();
            entries[
                (index + (event.shiftKey ? -1 : 1) + entries.length) %
                    entries.length
            ]?.focus();
        };
        window.addEventListener("keydown", key, true);
        return () => {
            window.removeEventListener("keydown", key, true);
            if (previous?.isConnected) previous.focus({ preventScroll: true });
        };
    }, []);
    return (
        <div className="unsaved-backdrop">
            <dialog
                open
                className="unsaved-dialog confirmation-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="confirmation-title"
                data-testid="confirm-dialog"
                onContextMenu={(event) => event.preventDefault()}
            >
                <h2 id="confirmation-title">{confirmation.title}</h2>
                <p>{confirmation.message}</p>
                <div className="dialog-actions">
                    <button
                        type="button"
                        ref={cancel}
                        data-testid="confirm-cancel"
                        onClick={() => resolveConfirmation(false)}
                    >
                        {t("settings.cancel")}
                    </button>
                    <button
                        type="button"
                        className="danger"
                        data-testid="confirm-accept"
                        onClick={() => resolveConfirmation(true)}
                    >
                        {confirmation.accept}
                    </button>
                </div>
            </dialog>
        </div>
    );
}

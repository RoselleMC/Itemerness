import { useEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { Menubar } from "@base-ui/react/menubar";
import { Menu as MenuIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ApplicationMenu } from "../../window/useApplicationMenu.js";
import { MenuItems } from "../common/MenuItems.js";
import "./applicationMenubar.css";

export function ApplicationMenubar({
    menu,
    blocked,
}: {
    menu: ApplicationMenu;
    blocked: boolean;
}) {
    const { t } = useTranslation();
    const root = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState<string | null>(null);
    useEffect(() => {
        if (blocked) setOpen(null);
    }, [blocked]);
    useEffect(() => {
        let altAlone = false;
        const key = (event: KeyboardEvent) => {
            if (event.type === "keydown") {
                altAlone =
                    event.key === "Alt" &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.shiftKey;
            }
            if (blocked || event.defaultPrevented || event.isComposing) return;
            const group =
                event.altKey && !event.ctrlKey && !event.metaKey
                    ? { f: "file", e: "edit", v: "view", h: "help" }[
                          event.key.toLowerCase()
                      ]
                    : undefined;
            if (
                !group &&
                !(event.key === "F10" && !event.shiftKey) &&
                event.key !== "Alt"
            )
                return;
            if (event.key === "Alt" && event.type !== "keyup") return;
            if (event.key === "Alt" && !altAlone) return;
            if (event.key !== "Alt" && event.type === "keyup") return;
            event.preventDefault();
            const buttons = [
                ...(root.current?.querySelectorAll<HTMLButtonElement>(
                    "button[data-app-menu-trigger]",
                ) ?? []),
            ];
            const visible = buttons.filter(
                (button) => button.getClientRects().length,
            );
            const target =
                visible.find(
                    (button) => button.dataset.appMenuTrigger === group,
                ) ?? visible[0];
            target?.focus();
            if (group) setOpen(visible.length === 1 ? "compact" : group);
        };
        window.addEventListener("keydown", key);
        window.addEventListener("keyup", key);
        const reset = () => {
            altAlone = false;
        };
        window.addEventListener("blur", reset);
        return () => {
            window.removeEventListener("keydown", key);
            window.removeEventListener("keyup", key);
            window.removeEventListener("blur", reset);
        };
    }, [blocked]);
    const popup = (
        label: string,
        items: ApplicationMenu["groups"][number]["items"],
    ) => (
        <Menu.Portal>
            <Menu.Positioner
                className="ui-positioner"
                align="start"
                sideOffset={5}
                collisionPadding={8}
            >
                <Menu.Popup
                    className="ui-popup application-menu-popup"
                    data-ui-popup
                    data-application-menu
                    aria-label={label}
                >
                    <MenuItems items={items} />
                </Menu.Popup>
            </Menu.Positioner>
        </Menu.Portal>
    );
    return (
        <div
            ref={root}
            className="application-menubar"
            data-application-menu
            data-no-drag
            inert={blocked}
            onPointerDownCapture={menu.refreshContext}
        >
            <Menubar
                className="application-menu-full"
                modal={false}
                aria-label={t("applicationMenu.heading")}
            >
                {menu.groups.map((group) => (
                    <Menu.Root
                        key={group.id}
                        modal={false}
                        open={open === group.id}
                        onOpenChange={(next) => setOpen(next ? group.id : null)}
                    >
                        <Menu.Trigger
                            className="application-menu-trigger"
                            data-app-menu-trigger={group.id}
                            data-testid={`app-menu-${group.id}`}
                        >
                            {group.label}
                        </Menu.Trigger>
                        {popup(group.label, group.items)}
                    </Menu.Root>
                ))}
            </Menubar>
            <div className="application-menu-compact">
                <Menu.Root
                    modal={false}
                    open={open === "compact"}
                    onOpenChange={(next) => setOpen(next ? "compact" : null)}
                >
                    <Menu.Trigger
                        className="titlebar-tool"
                        data-app-menu-trigger="compact"
                        data-testid="app-menu-compact"
                        aria-label={t("applicationMenu.heading")}
                        data-tooltip={t("applicationMenu.heading")}
                    >
                        <MenuIcon size={18} />
                    </Menu.Trigger>
                    {popup(
                        t("applicationMenu.heading"),
                        menu.groups.map((group) => ({
                            id: `application-${group.id}`,
                            label: group.label,
                            children: group.items,
                        })),
                    )}
                </Menu.Root>
            </div>
        </div>
    );
}

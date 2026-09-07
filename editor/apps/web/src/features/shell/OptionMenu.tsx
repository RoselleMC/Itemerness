import { useEffect, useRef, type ReactNode } from "react";
import { Check, type LucideIcon } from "lucide-react";
import {
    describeContext,
    type MenuDescription,
} from "../../state/interface.js";

export function OptionMenu<T extends string>({
    id,
    label,
    Icon,
    value,
    options,
    open,
    onOpenChange,
    onChange,
    children,
    buttonClassName,
    contextMenu,
}: {
    id: string;
    label: string;
    Icon: LucideIcon;
    value: T;
    options: readonly { value: T; label: string; Icon?: LucideIcon }[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChange: (value: T) => void;
    children?: ReactNode;
    buttonClassName?: string;
    contextMenu?: MenuDescription;
}) {
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        menu.current
            ?.querySelector<HTMLElement>('[aria-checked="true"]')
            ?.focus();
        const dismiss = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                !root.current?.contains(event.target)
            )
                onOpenChange(false);
        };
        document.addEventListener("pointerdown", dismiss, true);
        return () => document.removeEventListener("pointerdown", dismiss, true);
    }, [open, onOpenChange]);
    const close = () => {
        onOpenChange(false);
        trigger.current?.focus();
    };
    return (
        <div
            ref={root}
            className="option-menu"
            data-no-drag
            onContextMenu={(event) => {
                if (contextMenu) describeContext(event, contextMenu);
            }}
            onBlur={(event) => {
                if (
                    event.relatedTarget instanceof Node &&
                    !event.currentTarget.contains(event.relatedTarget)
                )
                    onOpenChange(false);
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape" && open) {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                }
            }}
        >
            <button
                type="button"
                ref={trigger}
                className={buttonClassName ?? "titlebar-tool"}
                data-testid={id}
                aria-label={label}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={`${id}-menu`}
                onClick={() => onOpenChange(!open)}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        onOpenChange(true);
                    }
                }}
            >
                {children ?? <Icon size={17} aria-hidden="true" />}
                {!open && (
                    <span className="control-tooltip" role="tooltip">
                        {label}
                    </span>
                )}
            </button>
            {open && (
                <div
                    className="option-menu-popup ui-popup"
                    data-ui-popup
                    role="menu"
                    aria-label={label}
                    id={`${id}-menu`}
                    ref={menu}
                    onKeyDown={(event) => {
                        if (
                            !["ArrowUp", "ArrowDown", "Home", "End"].includes(
                                event.key,
                            )
                        )
                            return;
                        event.preventDefault();
                        const buttons = [
                            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                                "button",
                            ),
                        ];
                        const current = buttons.indexOf(
                            document.activeElement as HTMLButtonElement,
                        );
                        const next =
                            event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? buttons.length - 1
                                  : (current +
                                        (event.key === "ArrowDown" ? 1 : -1) +
                                        buttons.length) %
                                    buttons.length;
                        buttons[next]?.focus();
                    }}
                >
                    {options.map(
                        ({ value: choice, label: text, Icon: ChoiceIcon }) => (
                            <button
                                type="button"
                                key={choice}
                                role="menuitemradio"
                                aria-checked={value === choice}
                                tabIndex={value === choice ? 0 : -1}
                                data-testid={`${id}-${choice}`}
                                onClick={() => {
                                    onChange(choice);
                                    close();
                                }}
                            >
                                {ChoiceIcon && (
                                    <ChoiceIcon size={16} aria-hidden="true" />
                                )}
                                <span>{text}</span>
                                <Check
                                    size={15}
                                    className="menu-check"
                                    aria-hidden="true"
                                    style={{
                                        visibility:
                                            value === choice
                                                ? "visible"
                                                : "hidden",
                                    }}
                                />
                            </button>
                        ),
                    )}
                </div>
            )}
        </div>
    );
}

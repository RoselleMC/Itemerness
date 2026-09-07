import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
    Braces,
    LayoutTemplate,
    Package,
    Palette,
    PackageOpen,
    Languages,
    Settings,
    PanelLeftClose,
    PanelLeftOpen,
} from "lucide-react";
import { useEditorStore, type EditorMode } from "../../state/store.js";
import { describeContext } from "../../state/interface.js";

export type WorkspacePage =
    "editor" | "assets" | "translations" | "settings" | "diagnostics";
const MODES = [
    { mode: "items", Icon: Package },
    { mode: "themes", Icon: Palette },
    { mode: "layouts", Icon: LayoutTemplate },
    { mode: "data", Icon: Braces },
] as const satisfies readonly { mode: EditorMode; Icon: typeof Package }[];

export function PrimaryNavigation({
    expanded,
    onToggle,
    enabled,
    page,
    onPageChange,
}: {
    expanded: boolean;
    onToggle: () => void;
    enabled: boolean;
    page: WorkspacePage;
    onPageChange: (page: WorkspacePage) => void;
}) {
    const { t } = useTranslation();
    const mode = useEditorStore((state) => state.mode);
    const setMode = useEditorStore((state) => state.setMode);
    const packs = useEditorStore((state) => state.packs.length);
    const list = useRef<HTMLDivElement>(null);
    const label = (text: string) =>
        expanded ? (
            <span className="primary-navigation-label">{text}</span>
        ) : (
            <span className="navigation-tooltip" role="tooltip">
                {text}
            </span>
        );
    const ToggleIcon = expanded ? PanelLeftClose : PanelLeftOpen;
    return (
        <nav
            className="primary-navigation"
            data-testid="primary-navigation"
            data-expanded={expanded}
            data-enabled={enabled}
            aria-label={t("navigation.heading")}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: t("navigation.heading"),
                    items: [
                        {
                            id: "toggle-navigation",
                            label: t(
                                expanded
                                    ? "navigation.collapse"
                                    : "navigation.expand",
                            ),
                            icon: expanded ? PanelLeftClose : PanelLeftOpen,
                            run: onToggle,
                        },
                        ...MODES.map(({ mode: target, Icon }) => ({
                            id: `mode-${target}`,
                            label: t(`sidebar.mode.${target}`),
                            icon: Icon,
                            disabled: !enabled,
                            checked: page === "editor" && target === mode,
                            run: () => {
                                setMode(target);
                                onPageChange("editor");
                            },
                        })),
                        {
                            id: "assets",
                            label: t("assets.heading"),
                            icon: PackageOpen,
                            disabled: !enabled,
                            separator: true,
                            run: () => onPageChange("assets"),
                        },
                        {
                            id: "translations",
                            label: t("locales.heading"),
                            icon: Languages,
                            disabled: !enabled,
                            run: () => onPageChange("translations"),
                        },
                        {
                            id: "settings",
                            label: t("sidebar.settings"),
                            icon: Settings,
                            run: () => onPageChange("settings"),
                        },
                    ],
                })
            }
        >
            <div className="primary-navigation-inner">
                <div
                    id="primary-navigation-items"
                    className="primary-navigation-items"
                    ref={list}
                    onKeyDown={(event) => {
                        if (
                            !["ArrowUp", "ArrowDown", "Home", "End"].includes(
                                event.key,
                            )
                        )
                            return;
                        const buttons = [
                            ...(list.current?.querySelectorAll<HTMLButtonElement>(
                                "button:not(:disabled)",
                            ) ?? []),
                        ];
                        const current = buttons.indexOf(
                            document.activeElement as HTMLButtonElement,
                        );
                        if (current < 0) return;
                        event.preventDefault();
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
                    {MODES.map(({ mode: target, Icon }) => (
                        <button
                            type="button"
                            key={target}
                            data-testid={`mode-${target}`}
                            data-mode={target}
                            className="primary-navigation-item"
                            aria-current={
                                page === "editor" && mode === target
                                    ? "page"
                                    : undefined
                            }
                            aria-label={t(`sidebar.mode.${target}`)}
                            disabled={!enabled}
                            onClick={() => {
                                setMode(target);
                                onPageChange("editor");
                            }}
                        >
                            <Icon size={20} aria-hidden="true" />
                            {label(t(`sidebar.mode.${target}`))}
                        </button>
                    ))}
                </div>
                <div
                    className="primary-navigation-bottom"
                    data-testid="navigation-tools"
                >
                    {[
                        {
                            id: "assets",
                            Icon: PackageOpen,
                            label: t("sidebar.assets"),
                            count: enabled ? packs : 0,
                        },
                        {
                            id: "translations",
                            Icon: Languages,
                            label: t("sidebar.translations"),
                            count: 0,
                        },
                        {
                            id: "settings",
                            Icon: Settings,
                            label: t("sidebar.settings"),
                            count: 0,
                        },
                    ].map(({ id, Icon, label: text, count }) => (
                        <button
                            type="button"
                            key={id}
                            className="primary-navigation-item"
                            data-testid={`open-${id}`}
                            aria-current={page === id ? "page" : undefined}
                            aria-label={count ? `${text} (${count})` : text}
                            disabled={id !== "settings" && !enabled}
                            onClick={() => onPageChange(id as WorkspacePage)}
                        >
                            <Icon size={20} aria-hidden="true" />
                            {label(text)}
                            {count > 0 && (
                                <span className="tool-count" aria-hidden="true">
                                    {Math.min(count, 99)}
                                </span>
                            )}
                        </button>
                    ))}
                    <button
                        type="button"
                        className="primary-navigation-item navigation-toggle"
                        data-testid="toggle-navigation"
                        aria-expanded={expanded}
                        aria-controls="primary-navigation-items"
                        aria-label={t(
                            expanded
                                ? "navigation.collapse"
                                : "navigation.expand",
                        )}
                        onClick={onToggle}
                    >
                        <ToggleIcon size={20} aria-hidden="true" />
                        {label(
                            t(
                                expanded
                                    ? "navigation.collapse"
                                    : "navigation.expand",
                            ),
                        )}
                    </button>
                </div>
            </div>
        </nav>
    );
}

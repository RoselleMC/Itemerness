import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
    CircleAlert,
    Copy,
    Globe2,
    Minus,
    Sun,
    Moon,
    SunMoon,
    Square,
    X,
} from "lucide-react";
import {
    titlebarAction,
    windowAction,
    type WindowAction,
    type WindowPlatform,
} from "../../window/chrome.js";
import { ConnectionCenter } from "./ConnectionCenter.js";
import type { DocumentSync } from "../document/useDocumentSync.js";
import { OptionMenu } from "./OptionMenu.js";
import { SUPPORTED_UI_LANGUAGES, useUiLanguage } from "../../i18n/index.js";
import { useAppearance } from "../../window/appearance.js";
import { describeContext, useInterface } from "../../state/interface.js";
import { ApplicationMenubar } from "./ApplicationMenubar.js";
import type { ApplicationMenu } from "../../window/useApplicationMenu.js";

export function Titlebar({
    platform,
    documentSync,
    saveMenuError = false,
    onDisconnect,
    interactionBlocked = false,
    applicationMenu,
}: {
    platform: WindowPlatform;
    documentSync: DocumentSync;
    saveMenuError?: boolean;
    onDisconnect: () => void;
    interactionBlocked?: boolean;
    applicationMenu: ApplicationMenu;
}) {
    const { t } = useTranslation();
    const language = useUiLanguage();
    const languages = [
        { value: "system" as const, label: t("appearance.system") },
        ...SUPPORTED_UI_LANGUAGES.map(({ code, label }) => ({
            value: code,
            label,
        })),
    ];
    const appearance = useAppearance();
    const connectionRequest = useInterface((state) => state.connectionRequest);
    const [popup, setPopup] = useState<
        "connection" | "language" | "appearance" | null
    >(null);
    const [maximized, setMaximized] = useState(false);
    const [focused, setFocused] = useState(true);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        if (interactionBlocked) setPopup(null);
    }, [interactionBlocked]);

    const showConnection = useCallback(
        (open: boolean) => setPopup(open ? "connection" : null),
        [],
    );
    const showLanguage = useCallback(
        (open: boolean) => setPopup(open ? "language" : null),
        [],
    );
    useEffect(() => {
        if (connectionRequest) showConnection(true);
    }, [connectionRequest, showConnection]);
    const showAppearance = useCallback(
        (open: boolean) => setPopup(open ? "appearance" : null),
        [],
    );

    useEffect(() => {
        if (platform === "browser") return;
        const window = getCurrentWindow();
        let disposed = false;
        const cleanup: (() => void)[] = [];
        const report = () => {
            if (!disposed) setFailed(true);
        };
        const update = async () => {
            const value = await window.isMaximized();
            if (!disposed) setMaximized(value);
        };
        const register = (listener: Promise<() => void>) => {
            void listener
                .then((unlisten) =>
                    disposed ? unlisten() : cleanup.push(unlisten),
                )
                .catch(report);
        };
        void update().catch(report);
        void window
            .isFocused()
            .then((value) => {
                if (!disposed) setFocused(value);
            })
            .catch(report);
        register(window.onResized(() => void update().catch(report)));
        register(
            window.onFocusChanged(({ payload }) => {
                if (!disposed) setFocused(payload);
            }),
        );
        return () => {
            disposed = true;
            cleanup.forEach((unlisten) => unlisten());
        };
    }, [platform]);

    const perform = (action: WindowAction) => {
        void windowAction(action).catch(() => setFailed(true));
    };

    const saveStatus = (
        <button
            key="save"
            type="button"
            className="titlebar-tool save-status"
            data-testid="document-sync-status"
            data-sync-kind={documentSync.status.kind}
            aria-label={t(`sidebar.documentSync.${documentSync.status.kind}`)}
            onClick={() => {
                if (["conflict", "offline"].includes(documentSync.status.kind))
                    documentSync.resolve();
                else if (
                    documentSync.isDirty() ||
                    documentSync.status.kind === "error"
                )
                    void documentSync.save();
                else showConnection(true);
            }}
        >
            <span className="save-status-dot" aria-hidden="true" />
            <span className="sr-only" role="status">
                {t(`sidebar.documentSync.${documentSync.status.kind}`)}
            </span>
            <span className="control-tooltip" role="tooltip">
                {t(`sidebar.documentSync.${documentSync.status.kind}`)}
            </span>
        </button>
    );
    const languageControl = (
        <OptionMenu
            key="language"
            id="ui-language"
            label={t("sidebar.uiLanguage")}
            Icon={Globe2}
            value={language.mode}
            options={languages}
            open={popup === "language"}
            onOpenChange={showLanguage}
            onChange={language.setMode}
            contextMenu={{
                label: t("sidebar.uiLanguage"),
                items: languages.map(({ value, label }) => ({
                    id: `language-${value}`,
                    label,
                    icon: Globe2,
                    checked: language.mode === value,
                    run: () => {
                        language.setMode(value);
                    },
                })),
            }}
        />
    );
    const appearanceControl = (
        <OptionMenu
            key="appearance"
            id="appearance"
            label={t("appearance.heading")}
            Icon={
                appearance.mode === "system"
                    ? SunMoon
                    : appearance.mode === "light"
                      ? Sun
                      : Moon
            }
            value={appearance.mode}
            options={[
                { value: "light", label: t("appearance.light"), Icon: Sun },
                { value: "dark", label: t("appearance.dark"), Icon: Moon },
                {
                    value: "system",
                    label: t("appearance.system"),
                    Icon: SunMoon,
                },
            ]}
            open={popup === "appearance"}
            onOpenChange={showAppearance}
            onChange={appearance.setMode}
            contextMenu={{
                label: t("appearance.heading"),
                items: [
                    {
                        id: "light",
                        label: t("appearance.light"),
                        icon: Sun,
                        checked: appearance.mode === "light",
                        run: () => appearance.setMode("light"),
                    },
                    {
                        id: "dark",
                        label: t("appearance.dark"),
                        icon: Moon,
                        checked: appearance.mode === "dark",
                        run: () => appearance.setMode("dark"),
                    },
                    {
                        id: "system",
                        label: t("appearance.system"),
                        icon: SunMoon,
                        checked: appearance.mode === "system",
                        run: () => appearance.setMode("system"),
                    },
                ],
            }}
        />
    );
    // The free edge is opposite the platform's caption buttons. DOM order also follows this layout.
    const preferences = (
        <nav
            className="titlebar-tools"
            inert={interactionBlocked}
            aria-label={t("window.preferences")}
            data-no-drag
            data-edge={platform === "windows" ? "left" : "right"}
        >
            {platform === "windows"
                ? [saveStatus, languageControl, appearanceControl]
                : [appearanceControl, languageControl, saveStatus]}
        </nav>
    );

    return (
        <header
            className="titlebar"
            data-testid="titlebar"
            data-platform={platform}
            data-focused={focused}
            onMouseDown={(event) => {
                const action = titlebarAction(event);
                if (action) perform(action);
            }}
            onContextMenu={(event) => {
                describeContext(event, {
                    label: t("app.title"),
                    items: [
                        {
                            id: "save",
                            label: t("settings.save"),
                            disabled: !documentSync.ready,
                            run: documentSync.save,
                        },
                        {
                            id: "connection",
                            label: t("connection.heading"),
                            run: () => showConnection(true),
                        },
                        ...(platform !== "browser"
                            ? [
                                  {
                                      id: "minimize",
                                      label: t("window.minimize"),
                                      icon: Minus,
                                      separator: true,
                                      run: () => perform("minimize"),
                                  },
                                  {
                                      id: "maximize",
                                      label: t(
                                          maximized
                                              ? "window.restore"
                                              : "window.maximize",
                                      ),
                                      icon: Square,
                                      run: () => perform("zoom"),
                                  },
                                  {
                                      id: "close-window",
                                      label: t("window.close"),
                                      icon: X,
                                      run: () => perform("close"),
                                  },
                              ]
                            : []),
                    ],
                });
            }}
        >
            <div className="titlebar-lead" data-testid="titlebar-drag-area">
                {platform === "windows" && preferences}
                {platform !== "macos" && (
                    <ApplicationMenubar
                        menu={applicationMenu}
                        blocked={interactionBlocked}
                    />
                )}
                {(failed || appearance.error || saveMenuError) && (
                    <span
                        className="titlebar-error"
                        role="alert"
                        data-tooltip={t("window.failed")}
                        data-no-drag
                    >
                        <CircleAlert size={15} />
                        <span className="sr-only">{t("window.failed")}</span>
                    </span>
                )}
            </div>
            <ConnectionCenter
                open={popup === "connection"}
                setOpen={showConnection}
                documentSync={documentSync}
                onDisconnect={onDisconnect}
                interactionBlocked={interactionBlocked}
            />
            <div className="titlebar-trailing">
                {platform !== "windows" && preferences}
                {platform === "windows" && (
                    <div
                        className="window-controls"
                        data-testid="window-controls"
                        data-no-drag
                    >
                        <button
                            type="button"
                            aria-label={t("window.minimize")}
                            data-tooltip={t("window.minimize")}
                            data-testid="window-minimize"
                            onClick={() => perform("minimize")}
                        >
                            <Minus
                                size={14}
                                strokeWidth={1}
                                absoluteStrokeWidth
                            />
                        </button>
                        <button
                            type="button"
                            aria-label={t(
                                maximized
                                    ? "window.restore"
                                    : "window.maximize",
                            )}
                            data-tooltip={t(
                                maximized
                                    ? "window.restore"
                                    : "window.maximize",
                            )}
                            data-testid="window-maximize"
                            onClick={() => perform("zoom")}
                        >
                            {maximized ? (
                                <Copy
                                    size={13}
                                    strokeWidth={1}
                                    absoluteStrokeWidth
                                />
                            ) : (
                                <Square
                                    size={12}
                                    strokeWidth={1}
                                    absoluteStrokeWidth
                                />
                            )}
                        </button>
                        <button
                            type="button"
                            className="window-close"
                            aria-label={t("window.close")}
                            data-tooltip={t("window.close")}
                            data-testid="window-close"
                            onClick={() => perform("close")}
                        >
                            <X size={16} strokeWidth={1} absoluteStrokeWidth />
                        </button>
                    </div>
                )}
            </div>
        </header>
    );
}

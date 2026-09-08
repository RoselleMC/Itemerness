import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
    usePreferences,
    validPackCheckInterval,
} from "../../state/preferences.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { SelectField } from "../common/SelectField.js";
import { describeContext } from "../../state/interface.js";
import { ProjectSettings } from "./ProjectSettings.js";
import { CatalogControls } from "./CatalogControls.js";
import { LocalOperationsTool } from "./LocalOperationsTool.js";
import { ServerWorkspaceSettings } from "./ServerWorkspaceSettings.js";
import type { DocumentSync } from "../document/useDocumentSync.js";
import { SUPPORTED_UI_LANGUAGES, useUiLanguage } from "../../i18n/index.js";
import { useColorMode } from "../../window/appearance.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import "./settingsNavigation.css";

export function SettingsPage({
    sync,
    confirmReplace,
}: {
    sync: DocumentSync;
    confirmReplace(): Promise<boolean>;
}) {
    const { t } = useTranslation();
    const preferences = usePreferences();
    const { autoSave, setAutoSave, packCheckInterval, setPackCheckInterval } =
        preferences;
    const appearance = useColorMode();
    const language = useUiLanguage();
    const [active, setActive] = useState("settings-appearance");
    const root = useRef<HTMLDivElement>(null);
    const groups = [
        {
            id: "settings-editor",
            label: t("settingsNavigation.editor"),
            children: [
                ["appearance", t("appearance.heading")],
                ["editing", t("settings.editing")],
                ["connection", t("connection.heading")],
                ["resources", t("packManager:settingsHeading")],
                ...(sync.ready
                    ? [["workspace", t("serverWorkspace:heading")]]
                    : []),
            ],
        },
        {
            id: "settings-plugin",
            label: t("settingsNavigation.plugin"),
            children: [
                ...(sync.ready
                    ? [
                          ["identity", t("serverWorkspace:identityHeading")],
                          ["project", t("projectSettings.heading")],
                      ]
                    : []),
                ["catalog", t("catalogTransfer.heading")],
            ],
        },
        {
            id: "settings-tools",
            label: t("settingsNavigation.tools"),
            children: [["files", t("localOperations:title")]],
        },
    ];
    useEffect(() => {
        const container = root.current?.closest(".workspace-page-content");
        if (!container) return;
        const update = () => {
            const headings = [
                ...(root.current?.querySelectorAll<HTMLElement>(
                    "[data-settings-region]",
                ) ?? []),
            ];
            const top = container.getBoundingClientRect().top + 40;
            const current =
                headings
                    .filter(
                        (element) => element.getBoundingClientRect().top <= top,
                    )
                    .at(-1) ?? headings[0];
            if (current) setActive(current.id);
        };
        container.addEventListener("scroll", update, { passive: true });
        update();
        return () => container.removeEventListener("scroll", update);
    }, [sync.ready]);
    const region = (id: string, children: ReactNode) => (
        <div id={`settings-${id}`} data-settings-region>
            {children}
        </div>
    );
    return (
        <div className="settings-layout" ref={root}>
            <nav
                className="settings-toc"
                aria-label={t("settingsNavigation.contents")}
                data-testid="settings-toc"
            >
                <ul>
                    {groups.map((group) => (
                        <li key={group.id}>
                            <a
                                href={`#${group.id}`}
                                className="settings-toc-group"
                                onClick={(event) => {
                                    event.preventDefault();
                                    if (commitInlineEditor())
                                        document
                                            .getElementById(group.id)
                                            ?.scrollIntoView({
                                                block: "start",
                                            });
                                }}
                            >
                                {group.label}
                            </a>
                            <ul>
                                {group.children.map(([id, label]) => (
                                    <li key={id}>
                                        <a
                                            href={`#settings-${id}`}
                                            aria-current={
                                                active === `settings-${id}`
                                                    ? "location"
                                                    : undefined
                                            }
                                            onClick={(event) => {
                                                event.preventDefault();
                                                if (commitInlineEditor()) {
                                                    document
                                                        .getElementById(
                                                            `settings-${id}`,
                                                        )
                                                        ?.scrollIntoView({
                                                            block: "start",
                                                        });
                                                    setActive(`settings-${id}`);
                                                }
                                            }}
                                        >
                                            {label}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </li>
                    ))}
                </ul>
            </nav>
            <div className="settings-body" data-testid="settings-body">
                <h2 className="settings-group-heading" id="settings-editor">
                    {t("settingsNavigation.editor")}
                </h2>
                {region(
                    "appearance",
                    <section className="settings-section">
                        <h3>{t("appearance.heading")}</h3>
                        <div className="settings-row">
                            <span>{t("appearance.heading")}</span>
                            <SelectField
                                label={t("appearance.heading")}
                                value={appearance.mode}
                                data-testid="settings-appearance"
                                options={["system", "light", "dark"].map(
                                    (value) => ({
                                        value,
                                        label: t(`appearance.${value}`),
                                    }),
                                )}
                                onValueChange={(value) =>
                                    appearance.setMode(
                                        value as "system" | "light" | "dark",
                                    )
                                }
                            />
                        </div>
                        <div className="settings-row">
                            <span>{t("sidebar.uiLanguage")}</span>
                            <SelectField
                                label={t("sidebar.uiLanguage")}
                                value={language.mode}
                                data-testid="settings-language"
                                options={[
                                    {
                                        value: "system",
                                        label: t("appearance.system"),
                                    },
                                    ...SUPPORTED_UI_LANGUAGES.map(
                                        ({ code, label }) => ({
                                            value: code,
                                            label,
                                        }),
                                    ),
                                ]}
                                onValueChange={(value) =>
                                    language.setMode(
                                        value as "system" | "en-US" | "zh-CN",
                                    )
                                }
                            />
                        </div>
                    </section>,
                )}
                {region(
                    "editing",
                    <section
                        className="settings-section"
                        data-testid="editor-settings"
                        onContextMenu={(event) =>
                            describeContext(event, {
                                label: t("sidebar.settings"),
                                items: [
                                    {
                                        id: "auto-save",
                                        label: t("settings.autoSave"),
                                        checked: autoSave,
                                        run: () => setAutoSave(!autoSave),
                                    },
                                ],
                            })
                        }
                    >
                        <h3>{t("settings.editing")}</h3>
                        <label className="settings-row">
                            <span>{t("settings.autoSave")}</span>
                            <input
                                type="checkbox"
                                role="switch"
                                data-testid="auto-save-toggle"
                                checked={autoSave}
                                onChange={(event) =>
                                    setAutoSave(event.target.checked)
                                }
                            />
                        </label>
                        <div className="settings-row">
                            <span>{t("settings.canvasPanButtons")}</span>
                            <SelectField
                                value={preferences.canvasPanButtons}
                                label={t("settings.canvasPanButtons")}
                                data-testid="canvas-pan-buttons"
                                options={[
                                    {
                                        value: "middle",
                                        label: t("settings.panMiddle"),
                                    },
                                    {
                                        value: "middle-right",
                                        label: t("settings.panMiddleRight"),
                                    },
                                ]}
                                onValueChange={(value) =>
                                    preferences.setCanvasPanButtons(
                                        value === "middle"
                                            ? "middle"
                                            : "middle-right",
                                    )
                                }
                            />
                        </div>
                    </section>,
                )}
                {region(
                    "connection",
                    <section className="settings-section">
                        <h3>{t("connection.heading")}</h3>
                        <div className="settings-row">
                            <span>{t("connection.reconnectMode")}</span>
                            <SelectField
                                label={t("connection.reconnectMode")}
                                value={preferences.reconnectMode}
                                data-testid="reconnect-mode"
                                options={[
                                    {
                                        value: "automatic",
                                        label: t("connection.automatic"),
                                    },
                                    {
                                        value: "manual",
                                        label: t("connection.manual"),
                                    },
                                ]}
                                onValueChange={(value) =>
                                    preferences.setReconnectMode(
                                        value as "automatic" | "manual",
                                    )
                                }
                            />
                        </div>
                    </section>,
                )}
                {region(
                    "resources",
                    <section className="settings-section">
                        <h3>{t("packManager:settingsHeading")}</h3>
                        <div className="settings-row">
                            <span>{t("packManager:checkInterval")}</span>
                            <BufferedInput
                                label={t("packManager:checkInterval")}
                                owner="preferences:pack-check-interval"
                                testId="pack-check-interval"
                                value={String(packCheckInterval)}
                                inputMode="numeric"
                                validate={(raw) =>
                                    /^\d+$/.test(raw) &&
                                    validPackCheckInterval(Number(raw))
                                        ? null
                                        : t("packManager:intervalInvalid")
                                }
                                onCommit={(raw) =>
                                    setPackCheckInterval(Number(raw))
                                }
                            />
                        </div>
                    </section>,
                )}
                {sync.ready && region("workspace", <ServerWorkspaceSettings />)}
                <h2 className="settings-group-heading" id="settings-plugin">
                    {t("settingsNavigation.plugin")}
                </h2>
                {!sync.ready && (
                    <p className="muted">
                        {t("settingsNavigation.disconnected")}
                    </p>
                )}
                {sync.ready &&
                    region(
                        "identity",
                        <ServerWorkspaceSettings scope="remote" />,
                    )}
                {sync.ready && region("project", <ProjectSettings />)}
                {region(
                    "catalog",
                    <CatalogControls
                        sync={sync}
                        confirmReplace={confirmReplace}
                    />,
                )}
                <h2 className="settings-group-heading" id="settings-tools">
                    {t("settingsNavigation.tools")}
                </h2>
                {region("files", <LocalOperationsTool />)}
            </div>
        </div>
    );
}

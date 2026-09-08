import { useTranslation } from "react-i18next";
import { Bold, Italic, Underline, Strikethrough, Trash2 } from "lucide-react";
import { parseColor } from "@itemerness/mc-render";
import type { ProjectDocument, ThemeNode } from "@itemerness/protocol";
import { ColorWell } from "../common/ColorWell.js";
import { SelectField } from "../common/SelectField.js";
import { AddThemeEntry } from "./ThemeFields.js";
import { semanticRoleError, type ThemePatch } from "./themeEditing.js";

export function ThemeRoles({
    theme,
    document,
    update,
}: {
    theme: ThemeNode;
    document: ProjectDocument;
    update: ThemePatch;
}) {
    const { t } = useTranslation();
    const validateRole = (values: object) => (raw: string) => {
        const error = semanticRoleError(raw, Object.keys(values));
        return error ? t(`themeAuthoring.${error}`) : null;
    };
    return (
        <>
            <section>
                <h3>{t("inspector.theme.fonts")}</h3>
                {Object.entries(theme.fonts).map(([role, font]) => (
                    <div className="theme-role" key={role}>
                        <div className="theme-role-heading">
                            <code>{role}</code>
                            <button
                                type="button"
                                className="icon-button danger"
                                disabled={role === "text"}
                                aria-label={t("themeAuthoring.removeFontRole", {
                                    role,
                                })}
                                data-tooltip={t(
                                    role === "text"
                                        ? "themeAuthoring.requiredTextFont"
                                        : "themeAuthoring.removeFontRole",
                                    { role },
                                )}
                                onClick={() =>
                                    update((current) => {
                                        const fonts = { ...current.fonts };
                                        delete fonts[role];
                                        return { ...current, fonts };
                                    })
                                }
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                        <SelectField
                            label={`${t("inspector.theme.fonts")}: ${role}`}
                            value={font}
                            onValueChange={(value) =>
                                update((current) => ({
                                    ...current,
                                    fonts: { ...current.fonts, [role]: value },
                                }))
                            }
                            options={document.fonts.map((entry) => ({
                                value: entry.id,
                                label: entry.id,
                            }))}
                        />
                    </div>
                ))}
                <AddThemeEntry
                    key={`${theme.uuid}:fonts`}
                    label={t("themeAuthoring.addFontRole")}
                    owner="font-role"
                    disabled={!document.fonts.length}
                    validate={validateRole(theme.fonts)}
                    onAdd={(role) =>
                        update((current) => ({
                            ...current,
                            fonts: {
                                ...current.fonts,
                                [role]: document.fonts[0]!.id,
                            },
                        }))
                    }
                />
                {!document.fonts.length && (
                    <p className="error small">
                        {t("themeAuthoring.missingFonts")}
                    </p>
                )}
            </section>
            <section>
                <h3>{t("inspector.theme.colors")}</h3>
                {Object.entries(theme.styles).map(([role, style]) => {
                    const parsed = parseColor(style.color);
                    const hex = `#${(parsed ?? 0xffffff).toString(16).padStart(6, "0")}`;
                    const setStyle = (patch: Partial<typeof style>) =>
                        update((current) => ({
                            ...current,
                            styles: {
                                ...current.styles,
                                [role]: { ...current.styles[role]!, ...patch },
                            },
                        }));
                    return (
                        <div className="theme-role" key={role}>
                            <div className="theme-role-heading">
                                <code>{role}</code>
                                <button
                                    type="button"
                                    className="icon-button danger"
                                    aria-label={t(
                                        "themeAuthoring.removeStyleRole",
                                        { role },
                                    )}
                                    data-tooltip={t(
                                        "themeAuthoring.removeStyleRole",
                                        { role },
                                    )}
                                    onClick={() =>
                                        update((current) => {
                                            const styles = {
                                                ...current.styles,
                                            };
                                            delete styles[role];
                                            return { ...current, styles };
                                        })
                                    }
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                            <div className="theme-style-controls">
                                <ColorWell
                                    label={`${t("inspector.theme.colors")}: ${role}`}
                                    owner={`${theme.uuid}:${role}`}
                                    value={hex}
                                    onValueChange={(color) =>
                                        setStyle({ color })
                                    }
                                    onClear={() => setStyle({ color: null })}
                                    id={`color-${role}`}
                                />
                                <span className="dim small theme-color-value">
                                    {style.color ??
                                        t("themeAuthoring.inheritedColor")}
                                </span>
                                <span className="style-toggles">
                                    {(
                                        [
                                            { property: "bold", Icon: Bold },
                                            {
                                                property: "italic",
                                                Icon: Italic,
                                            },
                                            {
                                                property: "underlined",
                                                Icon: Underline,
                                            },
                                            {
                                                property: "strikethrough",
                                                Icon: Strikethrough,
                                            },
                                        ] as const
                                    ).map(({ property, Icon }) => (
                                        <button
                                            key={property}
                                            type="button"
                                            className={
                                                style[property] ? "on" : ""
                                            }
                                            aria-pressed={style[property]}
                                            data-testid={`theme-style-${role}-${property}`}
                                            aria-label={t(
                                                `themeAuthoring.${property}`,
                                            )}
                                            data-tooltip={t(
                                                `themeAuthoring.${property}`,
                                            )}
                                            onClick={() =>
                                                setStyle({
                                                    [property]:
                                                        !style[property],
                                                })
                                            }
                                        >
                                            <Icon size={14} />
                                        </button>
                                    ))}
                                </span>
                            </div>
                        </div>
                    );
                })}
                <AddThemeEntry
                    key={`${theme.uuid}:styles`}
                    label={t("themeAuthoring.addStyleRole")}
                    owner="style-role"
                    validate={validateRole(theme.styles)}
                    onAdd={(role) =>
                        update((current) => ({
                            ...current,
                            styles: {
                                ...current.styles,
                                [role]: {
                                    color: null,
                                    bold: false,
                                    italic: false,
                                    underlined: false,
                                    strikethrough: false,
                                },
                            },
                        }))
                    }
                />
            </section>
        </>
    );
}

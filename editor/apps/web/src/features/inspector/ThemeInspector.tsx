import { useTranslation } from "react-i18next";
import { NAMED_COLORS, parseColor } from "@itemerness/mc-render";
import { useEditorStore } from "../../state/store.js";
import { humanizePath } from "../common/messages.js";

/**
 * Theme editing, with the stage as the colour proof.
 *
 * A theme is mostly colour and typography decisions, and those are edited with the tools people
 * already know: a colour well per role, a font dropdown per role, sliders for widths. Every change
 * recompiles the preview immediately — the theme library previews against the currently selected
 * item, so an editor is always looking at their own content while restyling it.
 */

/** Roles in the order themes conventionally use them; unknown roles append after. */
const KNOWN_ROLES = [
    "item-name",
    "label",
    "value",
    "description",
    "requirement-met",
    "requirement-unmet",
    "frame",
] as const;

function toHex(color: string | null): string {
    const parsed = parseColor(color);
    if (parsed === null) return "#ffffff";
    return `#${parsed.toString(16).padStart(6, "0")}`;
}

export function ThemeInspector() {
    const { t } = useTranslation();
    const store = useEditorStore();
    const doc = store.document;
    const theme = doc.themes.find(
        (entry) => entry.id === store.selectedThemeId,
    );

    if (!theme) {
        return (
            <aside className="inspector">
                <p className="muted">{t("stage.noItem")}</p>
            </aside>
        );
    }

    const roles = [
        ...KNOWN_ROLES.filter((role) => role in theme.styles),
        ...Object.keys(theme.styles).filter(
            (role) => !(KNOWN_ROLES as readonly string[]).includes(role),
        ),
    ];

    const setStyle = (
        role: string,
        patch: Partial<(typeof theme.styles)[string]>,
    ) =>
        store.updateTheme(theme.uuid, (current) => ({
            ...current,
            styles: {
                ...current.styles,
                [role]: { ...current.styles[role]!, ...patch },
            },
        }));

    const roleLabel = (role: string) => {
        const key = `inspector.roles.${role}`;
        const translated = t(key);
        return translated === key ? humanizePath(role) : translated;
    };

    return (
        <aside className="inspector" aria-label={t("inspector.theme.heading")}>
            <section>
                <h3>{t("inspector.theme.heading")}</h3>
                <p className="library-title">
                    {humanizePath(theme.id.split(":").pop() ?? theme.id)}
                    <span className="tag">
                        {t(`inspector.renderer.${theme.renderer}`)}
                    </span>
                    {theme.requiresResourcePack ? (
                        <span className="tag tag-pack">
                            {t("inspector.appearance.requiresPack")}
                        </span>
                    ) : null}
                </p>
                <p className="muted small">
                    {t("inspector.theme.previewHint")}
                </p>
            </section>

            <section>
                <h3>{t("inspector.theme.colors")}</h3>
                <div className="color-rows">
                    {roles.map((role) => (
                        <label key={role} className="color-row">
                            <input
                                type="color"
                                value={toHex(theme.styles[role]?.color ?? null)}
                                onChange={(event) =>
                                    setStyle(role, {
                                        color: event.target.value,
                                    })
                                }
                                data-testid={`color-${role}`}
                            />
                            <span>{roleLabel(role)}</span>
                            <span className="dim small">
                                {theme.styles[role]?.color ?? "—"}
                            </span>
                            <span className="style-toggles">
                                <button
                                    type="button"
                                    className={
                                        theme.styles[role]?.bold ? "on" : ""
                                    }
                                    onClick={() =>
                                        setStyle(role, {
                                            bold: !theme.styles[role]?.bold,
                                        })
                                    }
                                    aria-label={t("inspector.theme.bold")}
                                >
                                    B
                                </button>
                                <button
                                    type="button"
                                    className={
                                        theme.styles[role]?.italic ? "on" : ""
                                    }
                                    onClick={() =>
                                        setStyle(role, {
                                            italic: !theme.styles[role]?.italic,
                                        })
                                    }
                                    aria-label={t("inspector.theme.italic")}
                                >
                                    <em>I</em>
                                </button>
                            </span>
                        </label>
                    ))}
                </div>
            </section>

            <section>
                <h3>{t("inspector.theme.fonts")}</h3>
                {Object.entries(theme.fonts).map(([role, fontId]) => (
                    <label key={role} className="field-inline">
                        {humanizePath(role)}
                        <select
                            value={fontId}
                            onChange={(event) =>
                                store.updateTheme(theme.uuid, (current) => ({
                                    ...current,
                                    fonts: {
                                        ...current.fonts,
                                        [role]: event.target.value,
                                    },
                                }))
                            }
                        >
                            {doc.fonts.map((font) => (
                                <option key={font.uuid} value={font.id}>
                                    {font.id}
                                </option>
                            ))}
                        </select>
                    </label>
                ))}
            </section>

            <section>
                <h3>{t("inspector.theme.fallback")}</h3>
                <select
                    value={theme.fallback ?? ""}
                    onChange={(event) =>
                        store.updateTheme(theme.uuid, (current) => ({
                            ...current,
                            fallback: event.target.value || null,
                        }))
                    }
                    data-testid="theme-fallback"
                >
                    <option value="">{t("inspector.none")}</option>
                    {doc.themes
                        .filter((entry) => entry.id !== theme.id)
                        .map((entry) => (
                            <option key={entry.uuid} value={entry.id}>
                                {humanizePath(
                                    entry.id.split(":").pop() ?? entry.id,
                                )}
                            </option>
                        ))}
                </select>
                <p className="muted small">
                    {t("inspector.theme.fallbackHint")}
                </p>
            </section>

            {theme.content ? (
                <section>
                    <h3>{t("inspector.theme.contentWidth")}</h3>
                    <WidthSliders
                        minimum={theme.content.minimumWidthPixels}
                        maximum={theme.content.maximumWidthPixels}
                        onChange={(minimum, maximum) =>
                            store.updateTheme(theme.uuid, (current) => ({
                                ...current,
                                content: {
                                    ...current.content!,
                                    minimumWidthPixels: minimum,
                                    maximumWidthPixels: maximum,
                                },
                            }))
                        }
                    />
                </section>
            ) : null}

            {theme.characterFrame ? (
                <section>
                    <h3>{t("inspector.theme.frame")}</h3>
                    <label className="field-inline">
                        {t("inspector.theme.preset")}
                        <select
                            value={theme.characterFrame.preset}
                            onChange={(event) =>
                                store.updateTheme(theme.uuid, (current) => ({
                                    ...current,
                                    characterFrame: {
                                        ...current.characterFrame!,
                                        preset: event.target.value as never,
                                    },
                                }))
                            }
                            data-testid="frame-preset"
                        >
                            {[
                                "UNICODE_SINGLE",
                                "UNICODE_DOUBLE",
                                "ASCII_SAFE",
                                "BRACKETED_SECTION",
                                "SEPARATOR_ONLY",
                            ].map((preset) => (
                                <option key={preset} value={preset}>
                                    {t(`inspector.framePresets.${preset}`)}
                                </option>
                            ))}
                        </select>
                    </label>
                    <WidthSliders
                        minimum={theme.characterFrame.minimumWidthPixels}
                        maximum={theme.characterFrame.maximumWidthPixels}
                        onChange={(minimum, maximum) =>
                            store.updateTheme(theme.uuid, (current) => ({
                                ...current,
                                characterFrame: {
                                    ...current.characterFrame!,
                                    minimumWidthPixels: minimum,
                                    maximumWidthPixels: maximum,
                                },
                            }))
                        }
                    />
                </section>
            ) : null}

            {theme.canvas ? (
                <details className="advanced">
                    <summary>{t("inspector.theme.canvas")}</summary>
                    <dl>
                        <dt>{t("inspector.theme.canvasSize")}</dt>
                        <dd>
                            {theme.canvas.widthPixels} ×{" "}
                            {theme.canvas.heightPixels} px
                        </dd>
                        <dt>{t("inspector.theme.reserveLines")}</dt>
                        <dd>{theme.canvas.reserveTooltipLines}</dd>
                        <dt>{t("inspector.theme.layers")}</dt>
                        <dd>{theme.canvas.layers.length}</dd>
                    </dl>
                </details>
            ) : null}
        </aside>
    );
}

function WidthSliders({
    minimum,
    maximum,
    onChange,
}: {
    minimum: number;
    maximum: number;
    onChange: (minimum: number, maximum: number) => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="slider-rows">
            <label className="slider-row">
                <span>{t("inspector.theme.minWidth")}</span>
                <input
                    type="range"
                    min={40}
                    max={220}
                    value={minimum}
                    onChange={(event) => {
                        const next = Number(event.target.value);
                        onChange(next, Math.max(next, maximum));
                    }}
                />
                <span className="dim small">{minimum}px</span>
            </label>
            <label className="slider-row">
                <span>{t("inspector.theme.maxWidth")}</span>
                <input
                    type="range"
                    min={60}
                    max={220}
                    value={maximum}
                    onChange={(event) => {
                        const next = Number(event.target.value);
                        onChange(Math.min(minimum, next), next);
                    }}
                    data-testid="max-width-slider"
                />
                <span className="dim small">{maximum}px</span>
            </label>
        </div>
    );
}

/** Named colours resolve through the same table the renderer uses; re-exported for tests. */
export const NAMED_COLOR_TABLE = NAMED_COLORS;

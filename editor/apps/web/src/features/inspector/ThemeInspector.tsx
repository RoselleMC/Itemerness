import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { NAMED_COLORS } from "@itemerness/mc-render";
import {
    namespacedIdSchema,
    supportsSegmentedFrameDecorations,
    type ThemeNode,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { SelectField } from "../common/SelectField.js";
import { describeContext } from "../../state/interface.js";
import { themeLayoutActions } from "../common/themeLayoutActions.js";
import { ThemeLayoutAdd, ThemeLayoutHeader } from "./ThemeLayoutHeader.js";
import { ThemeRoles } from "./ThemeRoles.js";
import { ThemeContent, ThemeGeometry } from "./ThemeGeometry.js";
import { AddThemeEntry, ThemeToggle } from "./ThemeFields.js";
import {
    incompatibleThemeSettings,
    switchThemeRenderer,
    type ThemePatch,
} from "./themeEditing.js";

export function ThemeInspector({
    previewSettings,
}: {
    previewSettings?: ReactNode;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const decorationsSupported = useConnectionStore((state) =>
        supportsSegmentedFrameDecorations(state.info?.capabilities),
    );
    const doc = store.document;
    const theme = doc.themes.find(
        (entry) => entry.id === store.selectedThemeId,
    );
    if (!theme)
        return (
            <aside className="inspector">
                <ThemeLayoutAdd kind="themes" testIdPrefix="empty-" />
                {previewSettings}
            </aside>
        );
    const update: ThemePatch = (mutate) =>
        store.updateTheme(theme.uuid, mutate);
    const isNative = theme.renderer === "NATIVE_TOOLTIP_STYLE";
    const usesTooltipStyle =
        isNative ||
        theme.renderer === "BITMAP_CANVAS" ||
        theme.renderer === "SEGMENTED_FRAME";
    const isPlain = theme.renderer === "PLAIN";
    const incompatible = incompatibleThemeSettings(theme);
    const rendererState = theme.extensions?.editorRendererState;
    const saved =
        rendererState &&
        typeof rendererState === "object" &&
        !Array.isArray(rendererState)
            ? (rendererState as Record<string, unknown>)
            : {};
    const requiresPack =
        !isPlain && theme.renderer !== "VANILLA_CHARACTER_FRAME";
    const fixedPolicy =
        theme.renderer === "VANILLA_CHARACTER_FRAME"
            ? "PRESERVE_OUTSIDE_FRAME"
            : theme.renderer === "SEGMENTED_FRAME" ||
                theme.renderer === "BITMAP_CANVAS"
              ? "REQUIRE_MANAGED"
              : null;
    const retained = [
        theme.characterFrame && theme.renderer !== "VANILLA_CHARACTER_FRAME"
            ? "characterFrame"
            : null,
        theme.segmentedFrame && theme.renderer !== "SEGMENTED_FRAME"
            ? "segmentedFrame"
            : null,
        theme.canvas && theme.renderer !== "BITMAP_CANVAS" ? "canvas" : null,
        saved.content && !isNative ? "content" : null,
        saved.requireExactFontMetrics && theme.renderer !== "BITMAP_CANVAS"
            ? "requireExactFontMetrics"
            : null,
        saved.tooltipStyle && !usesTooltipStyle ? "tooltipStyle" : null,
        isPlain && rendererState ? "plainSavedSettings" : null,
    ].filter((kind): kind is string => kind !== null);
    return (
        <aside
            className="inspector theme-inspector"
            aria-label={t("inspector.theme.heading")}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: theme.id,
                    items: themeLayoutActions("themes", theme.uuid, t),
                })
            }
        >
            <ThemeLayoutHeader kind="themes" uuid={theme.uuid} />
            <section>
                <label className="field-inline">
                    <span>{t("themeAuthoring.renderer")}</span>
                    <SelectField
                        label={t("themeAuthoring.renderer")}
                        value={theme.renderer}
                        data-testid="theme-renderer"
                        onValueChange={(renderer) =>
                            update((current) =>
                                switchThemeRenderer(
                                    current,
                                    renderer as ThemeNode["renderer"],
                                ),
                            )
                        }
                        options={[
                            "PLAIN",
                            "VANILLA_CHARACTER_FRAME",
                            "NATIVE_TOOLTIP_STYLE",
                            "SEGMENTED_FRAME",
                            "BITMAP_CANVAS",
                        ].map((renderer) => ({
                            value: renderer,
                            label: t(`inspector.renderer.${renderer}`),
                        }))}
                    />
                </label>
                <label className="toggle-row">
                    <input
                        type="checkbox"
                        checked={theme.requiresResourcePack}
                        disabled
                        aria-label={t("themeAuthoring.requiresResourcePack")}
                    />
                    {t("themeAuthoring.requiresResourcePack")}
                </label>
                {theme.requiresResourcePack !== requiresPack && (
                    <div className="error small">
                        <p>{t("themeAuthoring.packRequirementMismatch")}</p>
                        <button
                            type="button"
                            className="page-command"
                            onClick={() =>
                                update((current) =>
                                    switchThemeRenderer(
                                        current,
                                        current.renderer,
                                    ),
                                )
                            }
                        >
                            <RotateCcw size={14} />
                            {t("themeAuthoring.applyRendererRequirements")}
                        </button>
                    </div>
                )}
                <label className="field-inline">
                    <span>{t("themeAuthoring.vanillaTooltipLines")}</span>
                    <SelectField
                        label={t("themeAuthoring.vanillaTooltipLines")}
                        value={theme.vanillaTooltipLines}
                        data-testid="theme-vanilla-policy"
                        onValueChange={(vanillaTooltipLines) =>
                            update((current) => ({
                                ...current,
                                vanillaTooltipLines:
                                    vanillaTooltipLines as ThemeNode["vanillaTooltipLines"],
                            }))
                        }
                        options={(fixedPolicy
                            ? [fixedPolicy]
                            : [
                                  "PRESERVE",
                                  "PRESERVE_OUTSIDE_FRAME",
                                  "REQUIRE_MANAGED",
                              ]
                        ).map((policy) => ({
                            value: policy,
                            label: t(`themeAuthoring.${policy}`),
                        }))}
                    />
                </label>
                {theme.renderer === "BITMAP_CANVAS" && (
                    <ThemeToggle
                        name="requireExactFontMetrics"
                        checked={theme.requireExactFontMetrics}
                        onChange={(requireExactFontMetrics) =>
                            update((current) => ({
                                ...current,
                                requireExactFontMetrics,
                            }))
                        }
                    />
                )}
            </section>
            {incompatible.length > 0 && (
                <section
                    className="error small"
                    data-testid="theme-incompatible-settings"
                >
                    <h3>{t("themeAuthoring.incompatibleSettings")}</h3>
                    <dl>
                        {incompatible.map((field) => (
                            <div key={field}>
                                <dt>{t(`themeAuthoring.${field}`)}</dt>
                                <dd>
                                    {field === "content" && theme.content
                                        ? `${theme.content.minimumWidthPixels}..${theme.content.maximumWidthPixels}px; ${theme.content.leftPaddingPixels}/${theme.content.rightPaddingPixels}px`
                                        : field === "fallbackBidirectionalText"
                                          ? "false"
                                          : String(
                                                theme[
                                                    field as
                                                        | "tooltipStyle"
                                                        | "fallback"
                                                        | "requireExactFontMetrics"
                                                ],
                                            )}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    <button
                        type="button"
                        className="page-command"
                        data-testid="theme-normalize-settings"
                        onClick={() =>
                            update((current) =>
                                switchThemeRenderer(current, current.renderer),
                            )
                        }
                    >
                        <RotateCcw size={14} />
                        {t("themeAuthoring.normalizeSettings")}
                    </button>
                </section>
            )}
            <section>
                <h3>{t("themeAuthoring.requiredCapabilities")}</h3>
                <ul className="theme-capabilities">
                    {theme.requiredCapabilities.map((capability, index) => (
                        <li key={`${capability}:${index}`}>
                            <code>{capability}</code>
                            <button
                                type="button"
                                className="icon-button danger"
                                aria-label={t(
                                    "themeAuthoring.removeCapability",
                                    { capability },
                                )}
                                data-tooltip={t(
                                    "themeAuthoring.removeCapability",
                                    { capability },
                                )}
                                onClick={() =>
                                    update((current) => ({
                                        ...current,
                                        requiredCapabilities:
                                            current.requiredCapabilities.filter(
                                                (_, position) =>
                                                    position !== index,
                                            ),
                                    }))
                                }
                            >
                                <Trash2 size={14} />
                            </button>
                        </li>
                    ))}
                </ul>
                <AddThemeEntry
                    key={`${theme.uuid}:capabilities`}
                    label={t("themeAuthoring.addCapability")}
                    owner="capability"
                    validate={(value) =>
                        !namespacedIdSchema.safeParse(value).success
                            ? t("themeAuthoring.invalidCapability")
                            : theme.requiredCapabilities.includes(value)
                              ? t("themeAuthoring.duplicateCapability")
                              : null
                    }
                    onAdd={(capability) =>
                        update((current) => ({
                            ...current,
                            requiredCapabilities: [
                                ...current.requiredCapabilities,
                                capability,
                            ],
                        }))
                    }
                />
            </section>
            {!isPlain && (
                <section>
                    <h3>{t("inspector.theme.fallback")}</h3>
                    <SelectField
                        label={t("inspector.theme.fallback")}
                        value={theme.fallback ?? ""}
                        data-testid="theme-fallback"
                        onValueChange={(fallback) =>
                            update((current) => ({
                                ...current,
                                fallback: fallback || null,
                            }))
                        }
                        options={[
                            { value: "", label: t("inspector.none") },
                            ...doc.themes
                                .filter((entry) => entry.id !== theme.id)
                                .map((entry) => ({
                                    value: entry.id,
                                    label: entry.id,
                                })),
                        ]}
                    />
                    {!theme.fallback && (
                        <p className="error small">
                            {t("themeAuthoring.missingFallback")}
                        </p>
                    )}
                </section>
            )}
            {usesTooltipStyle && (
                <section>
                    <h3>{t("themeAuthoring.tooltipStyle")}</h3>
                    <SelectField
                        label={t("themeAuthoring.tooltipStyle")}
                        value={theme.tooltipStyle ?? ""}
                        data-testid="theme-tooltip-style"
                        disabled={
                            theme.renderer === "SEGMENTED_FRAME" &&
                            !decorationsSupported
                        }
                        onValueChange={(tooltipStyle) =>
                            update((current) => ({
                                ...current,
                                tooltipStyle: tooltipStyle || null,
                            }))
                        }
                        options={[
                            { value: "", label: t("inspector.none") },
                            ...doc.tooltipStyles.map((style) => ({
                                value: style.id,
                                label: style.id,
                            })),
                        ]}
                    />
                    {isNative && !theme.tooltipStyle && (
                        <p className="error small">
                            {t("themeAuthoring.missingTooltipStyle")}
                        </p>
                    )}
                </section>
            )}
            {isNative && (
                <ThemeContent theme={theme} document={doc} update={update} />
            )}
            <ThemeGeometry theme={theme} document={doc} update={update} />
            <ThemeRoles theme={theme} document={doc} update={update} />
            {retained.length > 0 && (
                <details className="advanced">
                    <summary>{t("themeAuthoring.retainedSettings")}</summary>
                    <ul>
                        {retained.map((kind) => (
                            <li key={kind}>{t(`themeAuthoring.${kind}`)}</li>
                        ))}
                    </ul>
                </details>
            )}
            {previewSettings}
        </aside>
    );
}

export const NAMED_COLOR_TABLE = NAMED_COLORS;

import { useTranslation } from "react-i18next";
import { Eraser } from "lucide-react";
import { type FontNode, type ProjectDocument } from "@itemerness/protocol";
import {
    AssetNumber,
    AssetSelect,
    AssetText,
    AssetToggle,
} from "./AssetFields.js";
import { fallbackCycle, fontMetricsError } from "../../state/assetLibrary.js";

export function FontForm({
    font,
    document,
    update,
}: {
    font: FontNode;
    document: ProjectDocument;
    update(change: (source: FontNode) => FontNode): void;
}) {
    const { t } = useTranslation();
    const builtin = font.metrics.startsWith("builtin:");
    return (
        <>
            <section>
                <h3>{t("assetAuthoring.metrics")}</h3>
                <AssetText
                    name="metrics"
                    value={font.metrics}
                    owner={font.uuid}
                    suggestions={[
                        ...new Set([
                            "explicit",
                            "space-provider",
                            "builtin:minecraft-default",
                            "builtin:minecraft-uniform",
                            ...document.fonts.map((entry) => entry.metrics),
                        ]),
                    ]}
                    validate={(value) => fontMetricsError(font.id, value)}
                    onChange={(metrics) =>
                        update((source) => ({ ...source, metrics }))
                    }
                />
                <fieldset className="asset-fieldset" disabled={builtin}>
                    <AssetSelect
                        name="fontFallback"
                        value={font.fallback ?? ""}
                        options={[
                            { value: "", label: t("inspector.none") },
                            ...document.fonts.map((entry) => ({
                                value: entry.id,
                                label: entry.id,
                                disabled: fallbackCycle(
                                    document,
                                    "fonts",
                                    font.id,
                                    entry.id,
                                ),
                            })),
                        ]}
                        onChange={(value) =>
                            update((source) => ({
                                ...source,
                                fallback: value || null,
                            }))
                        }
                    />
                    <AssetNumber
                        name="fallbackAdvancePixels"
                        value={font.fallbackAdvancePixels}
                        owner={font.uuid}
                        optional
                        onChange={(fallbackAdvancePixels) =>
                            update((source) => ({
                                ...source,
                                fallbackAdvancePixels,
                            }))
                        }
                    />
                </fieldset>
                {builtin && (
                    <p className="muted small">
                        {t("assetAuthoring.builtinFontPolicy")}
                    </p>
                )}
                {builtin &&
                    (font.fallback !== null ||
                        font.fallbackAdvancePixels !== null) && (
                        <button
                            type="button"
                            className="page-command"
                            data-testid="asset-clear-font-fallback"
                            onClick={() =>
                                update((source) => ({
                                    ...source,
                                    fallback: null,
                                    fallbackAdvancePixels: null,
                                }))
                            }
                        >
                            <Eraser size={15} />
                            {t("assetAuthoring.clearFallbackOverrides")}
                        </button>
                    )}
            </section>
            <section>
                <h3>{t("assetAuthoring.advanceMetadata")}</h3>
                <AssetToggle
                    name="advanceRangeEnabled"
                    checked={font.advances !== null}
                    onChange={(enabled) =>
                        update((source) => ({
                            ...source,
                            advances: enabled
                                ? { minimum: -1, maximum: 1 }
                                : null,
                        }))
                    }
                />
                {font.advances && (
                    <div className="asset-field-grid">
                        <AssetNumber
                            name="minimumAdvance"
                            value={font.advances.minimum}
                            owner={font.uuid}
                            integer
                            minimum={-2147483648}
                            maximum={font.advances.maximum - 1}
                            onChange={(minimum) =>
                                update((source) => ({
                                    ...source,
                                    advances: {
                                        ...source.advances!,
                                        minimum: minimum!,
                                    },
                                }))
                            }
                        />
                        <AssetNumber
                            name="maximumAdvance"
                            value={font.advances.maximum}
                            owner={font.uuid}
                            integer
                            minimum={font.advances.minimum + 1}
                            maximum={2147483647}
                            onChange={(maximum) =>
                                update((source) => ({
                                    ...source,
                                    advances: {
                                        ...source.advances!,
                                        maximum: maximum!,
                                    },
                                }))
                            }
                        />
                    </div>
                )}
            </section>
        </>
    );
}

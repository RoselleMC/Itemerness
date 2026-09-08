import { useTranslation } from "react-i18next";
import { itemLayout } from "@itemerness/protocol";
import type { ReactNode } from "react";
import { AlignLeft, AlignRight } from "lucide-react";
import { useEditorStore } from "../../state/store.js";
import { describeContext } from "../../state/interface.js";
import { themeLayoutActions } from "../common/themeLayoutActions.js";
import { ThemeLayoutAdd, ThemeLayoutHeader } from "./ThemeLayoutHeader.js";
import { LayoutNumber } from "./LayoutFields.js";
import { LayoutWrapping } from "./LayoutWrapping.js";
import { LayoutCanvas } from "./LayoutCanvas.js";
import "./layoutInspector.css";

export function LayoutInspector({
    previewSettings,
}: {
    previewSettings?: ReactNode;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const doc = store.document;
    const layout = doc.layouts.find(
        (entry) => entry.id === store.selectedLayoutId,
    );
    if (!layout)
        return (
            <aside className="inspector">
                <ThemeLayoutAdd kind="layouts" testIdPrefix="empty-" />
                {previewSettings}
            </aside>
        );
    const usedBy = doc.items.filter(
        (item) => itemLayout(doc, item) === layout.id,
    );
    return (
        <aside
            className="inspector layout-inspector"
            aria-label={t("inspector.layout.heading")}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: layout.id,
                    items: themeLayoutActions("layouts", layout.uuid, t),
                })
            }
        >
            <ThemeLayoutHeader kind="layouts" uuid={layout.uuid} />
            <section>
                <p className="library-title">
                    <span className="tag">
                        {t(`inspector.layoutKind.${layout.kind}`)}
                    </span>
                </p>
                <p className="muted small">
                    {t("inspector.layout.usedBy", { count: usedBy.length })}
                </p>
            </section>
            {layout.kind === "canvas" ? (
                <LayoutCanvas layout={layout} document={doc} />
            ) : (
                (() => {
                    const patch = (changes: Partial<typeof layout>) =>
                        store.updateLayout(layout.uuid, (current) =>
                            current.kind === "flow"
                                ? { ...current, ...changes }
                                : current,
                        );
                    return (
                        <>
                            <section>
                                <h3>{t("inspector.layout.width")}</h3>
                                <LayoutNumber
                                    name="minimumWidthPixels"
                                    value={layout.minimumWidthPixels}
                                    minimum={1}
                                    maximum={Math.min(
                                        layout.maximumWidthPixels,
                                        doc.budgets.maximumWidthPixels,
                                    )}
                                    owner={layout.uuid}
                                    onChange={(minimumWidthPixels) =>
                                        patch({ minimumWidthPixels })
                                    }
                                />
                                <LayoutNumber
                                    name="maximumWidthPixels"
                                    value={layout.maximumWidthPixels}
                                    minimum={Math.max(
                                        layout.minimumWidthPixels,
                                        layout.fieldLeftPaddingPixels + 1,
                                        layout.descriptionLeftPaddingPixels +
                                            layout.descriptionRightPaddingPixels +
                                            1,
                                    )}
                                    maximum={doc.budgets.maximumWidthPixels}
                                    owner={layout.uuid}
                                    onChange={(maximumWidthPixels) =>
                                        patch({ maximumWidthPixels })
                                    }
                                />
                                <input
                                    type="range"
                                    className="layout-width-slider"
                                    aria-label={t(
                                        "layoutAuthoring.maximumWidthPixels",
                                    )}
                                    min={Math.max(
                                        layout.minimumWidthPixels,
                                        layout.fieldLeftPaddingPixels + 1,
                                        layout.descriptionLeftPaddingPixels +
                                            layout.descriptionRightPaddingPixels +
                                            1,
                                    )}
                                    max={doc.budgets.maximumWidthPixels}
                                    value={layout.maximumWidthPixels}
                                    data-testid="layout-max-width"
                                    onChange={(event) =>
                                        patch({
                                            maximumWidthPixels: Number(
                                                event.target.value,
                                            ),
                                        })
                                    }
                                />
                                <LayoutNumber
                                    name="blockGapAfterPixels"
                                    value={layout.blockGapAfterPixels}
                                    step={10}
                                    owner={layout.uuid}
                                    onChange={(blockGapAfterPixels) =>
                                        patch({ blockGapAfterPixels })
                                    }
                                />
                            </section>
                            <section>
                                <h3>{t("inspector.layout.fields")}</h3>
                                <div className="field-inline">
                                    <span>
                                        {t("inspector.layout.valueAlignment")}
                                    </span>
                                    <div
                                        className="chip-group"
                                        role="group"
                                        aria-label={t(
                                            "inspector.layout.valueAlignment",
                                        )}
                                    >
                                        {(["LEFT", "RIGHT"] as const).map(
                                            (alignment) => {
                                                const Icon =
                                                    alignment === "LEFT"
                                                        ? AlignLeft
                                                        : AlignRight;
                                                return (
                                                    <button
                                                        key={alignment}
                                                        type="button"
                                                        className={`icon-button ${layout.fieldValueAlignment === alignment ? "chip-on" : ""}`}
                                                        aria-label={t(
                                                            `inspector.layout.align${alignment}`,
                                                        )}
                                                        aria-pressed={
                                                            layout.fieldValueAlignment ===
                                                            alignment
                                                        }
                                                        data-tooltip={t(
                                                            `inspector.layout.align${alignment}`,
                                                        )}
                                                        data-testid={`align-${alignment}`}
                                                        onClick={() =>
                                                            patch({
                                                                fieldValueAlignment:
                                                                    alignment,
                                                            })
                                                        }
                                                    >
                                                        <Icon size={16} />
                                                    </button>
                                                );
                                            },
                                        )}
                                    </div>
                                </div>
                                <LayoutNumber
                                    name="fieldLeftPaddingPixels"
                                    value={layout.fieldLeftPaddingPixels}
                                    maximum={layout.maximumWidthPixels - 1}
                                    owner={layout.uuid}
                                    onChange={(fieldLeftPaddingPixels) =>
                                        patch({ fieldLeftPaddingPixels })
                                    }
                                />
                                <LayoutNumber
                                    name="fieldIconGapPixels"
                                    value={layout.fieldIconGapPixels}
                                    owner={layout.uuid}
                                    onChange={(fieldIconGapPixels) =>
                                        patch({ fieldIconGapPixels })
                                    }
                                />
                            </section>
                            <section>
                                <h3>{t("inspector.layout.description")}</h3>
                                <LayoutNumber
                                    name="descriptionLeftPaddingPixels"
                                    value={layout.descriptionLeftPaddingPixels}
                                    maximum={
                                        layout.maximumWidthPixels -
                                        layout.descriptionRightPaddingPixels -
                                        1
                                    }
                                    owner={layout.uuid}
                                    onChange={(descriptionLeftPaddingPixels) =>
                                        patch({ descriptionLeftPaddingPixels })
                                    }
                                />
                                <LayoutNumber
                                    name="descriptionRightPaddingPixels"
                                    value={layout.descriptionRightPaddingPixels}
                                    maximum={
                                        layout.maximumWidthPixels -
                                        layout.descriptionLeftPaddingPixels -
                                        1
                                    }
                                    owner={layout.uuid}
                                    onChange={(descriptionRightPaddingPixels) =>
                                        patch({ descriptionRightPaddingPixels })
                                    }
                                />
                                <LayoutNumber
                                    name="descriptionGapBeforePixels"
                                    value={layout.descriptionGapBeforePixels}
                                    step={10}
                                    owner={layout.uuid}
                                    onChange={(descriptionGapBeforePixels) =>
                                        patch({ descriptionGapBeforePixels })
                                    }
                                />
                            </section>
                        </>
                    );
                })()
            )}
            <LayoutWrapping key={layout.uuid} layout={layout} document={doc} />
            {previewSettings}
        </aside>
    );
}

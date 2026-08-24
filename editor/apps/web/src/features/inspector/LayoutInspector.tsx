import { useTranslation } from "react-i18next";
import { useEditorStore } from "../../state/store.js";
import { humanizePath } from "../common/messages.js";

/**
 * Layout editing in spatial terms: widths as sliders, alignment as a two-state toggle, spacing as
 * small steppers. The stage previews an item that actually uses the layout, so dragging the width
 * slider visibly re-wraps real content rather than a synthetic sample.
 */
export function LayoutInspector() {
    const { t } = useTranslation();
    const store = useEditorStore();
    const doc = store.document;
    const layout = doc.layouts.find(
        (entry) => entry.id === store.selectedLayoutId,
    );

    if (!layout) {
        return (
            <aside className="inspector">
                <p className="muted">{t("stage.noItem")}</p>
            </aside>
        );
    }

    const usedBy = doc.items.filter(
        (item) => item.presentation.layout === layout.id,
    );

    if (layout.kind === "canvas") {
        return (
            <aside
                className="inspector"
                aria-label={t("inspector.layout.heading")}
            >
                <section>
                    <h3>{t("inspector.layout.heading")}</h3>
                    <p className="library-title">
                        {humanizePath(layout.id.split(":").pop() ?? layout.id)}
                        <span className="tag">
                            {t("inspector.layoutKind.canvas")}
                        </span>
                    </p>
                    <p className="muted small">
                        {t("inspector.layout.usedBy", { count: usedBy.length })}
                    </p>
                </section>
                <section>
                    <h3>{t("inspector.theme.canvasSize")}</h3>
                    <dl className="fact-list">
                        <dt>{t("inspector.theme.canvasSize")}</dt>
                        <dd>
                            {layout.widthPixels} × {layout.heightPixels} px
                        </dd>
                        <dt>{t("inspector.theme.reserveLines")}</dt>
                        <dd>{layout.reserveTooltipLines}</dd>
                        <dt>{t("inspector.layout.anchors")}</dt>
                        <dd>{Object.keys(layout.anchors).join(", ")}</dd>
                    </dl>
                    <p className="muted small">
                        {t("inspector.layout.canvasHint")}
                    </p>
                </section>
            </aside>
        );
    }

    const patch = (changes: Partial<typeof layout>) =>
        store.updateLayout(layout.uuid, (current) =>
            current.kind === "flow" ? { ...current, ...changes } : current,
        );

    const bodyWrapping =
        layout.wrapping.body ?? Object.values(layout.wrapping)[0];
    const wrappingName = layout.wrapping.body
        ? "body"
        : Object.keys(layout.wrapping)[0];

    return (
        <aside className="inspector" aria-label={t("inspector.layout.heading")}>
            <section>
                <h3>{t("inspector.layout.heading")}</h3>
                <p className="library-title">
                    {humanizePath(layout.id.split(":").pop() ?? layout.id)}
                    <span className="tag">
                        {t("inspector.layoutKind.flow")}
                    </span>
                </p>
                <p className="muted small">
                    {t("inspector.layout.usedBy", { count: usedBy.length })}
                </p>
            </section>

            <section>
                <h3>{t("inspector.layout.width")}</h3>
                <div className="slider-rows">
                    <label className="slider-row">
                        <span>{t("inspector.theme.minWidth")}</span>
                        <input
                            type="range"
                            min={40}
                            max={220}
                            value={layout.minimumWidthPixels}
                            onChange={(event) => {
                                const next = Number(event.target.value);
                                patch({
                                    minimumWidthPixels: next,
                                    maximumWidthPixels: Math.max(
                                        next,
                                        layout.maximumWidthPixels,
                                    ),
                                });
                            }}
                        />
                        <span className="dim small">
                            {layout.minimumWidthPixels}px
                        </span>
                    </label>
                    <label className="slider-row">
                        <span>{t("inspector.theme.maxWidth")}</span>
                        <input
                            type="range"
                            min={60}
                            max={220}
                            value={layout.maximumWidthPixels}
                            onChange={(event) => {
                                const next = Number(event.target.value);
                                patch({
                                    minimumWidthPixels: Math.min(
                                        layout.minimumWidthPixels,
                                        next,
                                    ),
                                    maximumWidthPixels: next,
                                });
                            }}
                            data-testid="layout-max-width"
                        />
                        <span className="dim small">
                            {layout.maximumWidthPixels}px
                        </span>
                    </label>
                </div>
            </section>

            <section>
                <h3>{t("inspector.layout.fields")}</h3>
                <p className="field-label">
                    {t("inspector.layout.valueAlignment")}
                </p>
                <div className="chip-group">
                    {(["LEFT", "RIGHT"] as const).map((alignment) => (
                        <button
                            key={alignment}
                            type="button"
                            className={`chip ${layout.fieldValueAlignment === alignment ? "chip-on" : ""}`}
                            onClick={() =>
                                patch({ fieldValueAlignment: alignment })
                            }
                            data-testid={`align-${alignment}`}
                        >
                            {t(`inspector.layout.align${alignment}`)}
                        </button>
                    ))}
                </div>
                <label className="field-inline">
                    {t("inspector.layout.fieldPadding")}
                    <input
                        type="number"
                        min={0}
                        max={64}
                        value={layout.fieldLeftPaddingPixels}
                        onChange={(event) =>
                            patch({
                                fieldLeftPaddingPixels:
                                    Number(event.target.value) || 0,
                            })
                        }
                    />
                </label>
                <label className="field-inline">
                    {t("inspector.layout.iconGap")}
                    <input
                        type="number"
                        min={0}
                        max={32}
                        value={layout.fieldIconGapPixels}
                        onChange={(event) =>
                            patch({
                                fieldIconGapPixels:
                                    Number(event.target.value) || 0,
                            })
                        }
                    />
                </label>
            </section>

            <section>
                <h3>{t("inspector.layout.description")}</h3>
                <label className="field-inline">
                    {t("inspector.layout.gapBefore")}
                    <input
                        type="number"
                        min={0}
                        max={64}
                        value={layout.descriptionGapBeforePixels}
                        onChange={(event) =>
                            patch({
                                descriptionGapBeforePixels:
                                    Number(event.target.value) || 0,
                            })
                        }
                    />
                </label>
                {bodyWrapping && wrappingName ? (
                    <>
                        <label className="field-inline">
                            {t("inspector.layout.maxLines")}
                            <input
                                type="number"
                                min={1}
                                max={64}
                                value={bodyWrapping.maximumLines}
                                onChange={(event) => {
                                    const next = Math.max(
                                        1,
                                        Number(event.target.value) || 1,
                                    );
                                    store.updateLayout(
                                        layout.uuid,
                                        (current) =>
                                            current.kind === "flow"
                                                ? {
                                                      ...current,
                                                      wrapping: {
                                                          ...current.wrapping,
                                                          [wrappingName]: {
                                                              ...bodyWrapping,
                                                              maximumLines:
                                                                  next,
                                                          },
                                                      },
                                                  }
                                                : current,
                                    );
                                }}
                            />
                        </label>
                        <label className="field-inline">
                            {t("inspector.layout.overflow")}
                            <select
                                value={bodyWrapping.overflow}
                                onChange={(event) =>
                                    store.updateLayout(
                                        layout.uuid,
                                        (current) =>
                                            current.kind === "flow"
                                                ? {
                                                      ...current,
                                                      wrapping: {
                                                          ...current.wrapping,
                                                          [wrappingName]: {
                                                              ...bodyWrapping,
                                                              overflow: event
                                                                  .target
                                                                  .value as never,
                                                          },
                                                      },
                                                  }
                                                : current,
                                    )
                                }
                            >
                                {(
                                    [
                                        "ELLIPSIS",
                                        "ALLOW_OVERFLOW",
                                        "ERROR",
                                    ] as const
                                ).map((policy) => (
                                    <option key={policy} value={policy}>
                                        {t(`inspector.overflow.${policy}`)}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </>
                ) : null}
            </section>
        </aside>
    );
}

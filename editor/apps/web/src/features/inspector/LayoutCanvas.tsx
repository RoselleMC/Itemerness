import { useTranslation } from "react-i18next";
import type { ProjectDocument } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import {
    AddLayoutEntry,
    LayoutEntryHeader,
    LayoutNumber,
    LayoutOverflow,
} from "./LayoutFields.js";
import {
    canvasThemeMismatches,
    layoutEntryReferences,
    layoutNameError,
    removeLayoutEntry,
    renameLayoutEntry,
    type CanvasLayout,
} from "./layoutEditing.js";

export function LayoutCanvas({
    layout,
    document,
}: {
    layout: CanvasLayout;
    document: ProjectDocument;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const patch = (changes: Partial<CanvasLayout>) =>
        store.updateLayout(layout.uuid, (current) =>
            current.kind === "canvas" ? { ...current, ...changes } : current,
        );
    return (
        <>
            <section>
                <h3>{t("inspector.theme.canvasSize")}</h3>
                {canvasThemeMismatches(document, layout).map((theme) => (
                    <p
                        key={theme.uuid}
                        className="error small"
                        role="status"
                        data-testid="layout-canvas-theme-mismatch"
                    >
                        {t("layoutAuthoring.canvasThemeMismatch", {
                            theme: theme.id,
                            width: theme.canvas!.widthPixels,
                            height: theme.canvas!.heightPixels,
                            lines: theme.canvas!.reserveTooltipLines,
                        })}
                    </p>
                ))}
                <LayoutNumber
                    name="widthPixels"
                    value={layout.widthPixels}
                    minimum={Math.max(
                        1,
                        ...Object.values(layout.anchors).map(
                            (anchor) => anchor.x + anchor.width,
                        ),
                    )}
                    maximum={Math.min(
                        layout.maximumWidthPixels,
                        document.budgets.maximumWidthPixels,
                    )}
                    owner={layout.uuid}
                    onChange={(widthPixels) => patch({ widthPixels })}
                />
                <LayoutNumber
                    name="heightPixels"
                    value={layout.heightPixels}
                    minimum={Math.max(
                        1,
                        ...Object.values(layout.anchors).map(
                            (anchor) => anchor.y + anchor.height,
                        ),
                    )}
                    maximum={Math.min(
                        layout.maximumHeightPixels,
                        document.budgets.maximumHeightPixels,
                    )}
                    owner={layout.uuid}
                    onChange={(heightPixels) => patch({ heightPixels })}
                />
                <LayoutNumber
                    name="maximumWidthPixels"
                    value={layout.maximumWidthPixels}
                    minimum={layout.widthPixels}
                    maximum={document.budgets.maximumWidthPixels}
                    owner={layout.uuid}
                    onChange={(maximumWidthPixels) =>
                        patch({ maximumWidthPixels })
                    }
                />
                <LayoutNumber
                    name="maximumHeightPixels"
                    value={layout.maximumHeightPixels}
                    minimum={layout.heightPixels}
                    maximum={document.budgets.maximumHeightPixels}
                    owner={layout.uuid}
                    onChange={(maximumHeightPixels) =>
                        patch({ maximumHeightPixels })
                    }
                />
                <LayoutNumber
                    name="reserveTooltipLines"
                    value={layout.reserveTooltipLines}
                    minimum={1}
                    maximum={document.budgets.maximumLines}
                    owner={layout.uuid}
                    onChange={(reserveTooltipLines) =>
                        patch({ reserveTooltipLines })
                    }
                />
            </section>
            <section>
                <h3>{t("inspector.layout.anchors")}</h3>
                {Object.entries(layout.anchors).map(([name, anchor]) => {
                    const owner = `layout-anchor-${name}`;
                    const change = (changes: Partial<typeof anchor>) =>
                        store.updateLayout(layout.uuid, (current) =>
                            current.kind === "canvas"
                                ? {
                                      ...current,
                                      anchors: {
                                          ...current.anchors,
                                          [name]: {
                                              ...current.anchors[name]!,
                                              ...changes,
                                          },
                                      },
                                  }
                                : current,
                        );
                    return (
                        <div
                            className="layout-entry"
                            key={`${layout.uuid}:${name}`}
                            data-testid={owner}
                            role="group"
                            aria-label={t("layoutAuthoring.anchorEntry", {
                                name,
                            })}
                        >
                            <LayoutEntryHeader
                                name={name}
                                owner={owner}
                                references={layoutEntryReferences(
                                    document,
                                    layout,
                                    "anchors",
                                    name,
                                )}
                                validate={(next) =>
                                    renameLayoutEntry(
                                        document,
                                        layout.uuid,
                                        "anchors",
                                        name,
                                        next,
                                    ).error
                                }
                                onRename={(next) =>
                                    store.updateDocument(
                                        (current) =>
                                            renameLayoutEntry(
                                                current,
                                                layout.uuid,
                                                "anchors",
                                                name,
                                                next,
                                            ).document ?? current,
                                    )
                                }
                                onDelete={() =>
                                    store.updateDocument(
                                        (current) =>
                                            removeLayoutEntry(
                                                current,
                                                layout.uuid,
                                                "anchors",
                                                name,
                                            ).document ?? current,
                                    )
                                }
                            />
                            {(["x", "y", "width", "height"] as const).map(
                                (property) => (
                                    <LayoutNumber
                                        key={property}
                                        name={property}
                                        value={anchor[property]}
                                        minimum={
                                            property === "x" || property === "y"
                                                ? 0
                                                : 1
                                        }
                                        maximum={
                                            property === "x"
                                                ? layout.widthPixels -
                                                  anchor.width
                                                : property === "y"
                                                  ? layout.heightPixels -
                                                    anchor.height
                                                  : property === "width"
                                                    ? layout.widthPixels -
                                                      anchor.x
                                                    : layout.heightPixels -
                                                      anchor.y
                                        }
                                        owner={`${layout.uuid}:${owner}`}
                                        testId={`${owner}-${property}`}
                                        onChange={(value) =>
                                            change({ [property]: value })
                                        }
                                    />
                                ),
                            )}
                            <LayoutOverflow
                                value={anchor.overflow}
                                onChange={(overflow) => change({ overflow })}
                                testId={`${owner}-overflow`}
                            />
                        </div>
                    );
                })}
                <AddLayoutEntry
                    key={layout.uuid}
                    kind="anchor"
                    validate={(name) =>
                        layoutNameError(name, Object.keys(layout.anchors))
                    }
                    onAdd={(name) =>
                        store.updateLayout(layout.uuid, (current) =>
                            current.kind === "canvas" &&
                            !Object.hasOwn(current.anchors, name)
                                ? {
                                      ...current,
                                      anchors: {
                                          ...current.anchors,
                                          [name]: {
                                              x: 0,
                                              y: 0,
                                              width: Math.min(
                                                  120,
                                                  current.widthPixels,
                                              ),
                                              height: Math.min(
                                                  10,
                                                  current.heightPixels,
                                              ),
                                              overflow: "ELLIPSIS",
                                          },
                                      },
                                  }
                                : current,
                        )
                    }
                />
            </section>
        </>
    );
}

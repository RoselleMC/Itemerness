import { useTranslation } from "react-i18next";
import type {
    LayoutNode,
    ProjectDocument,
    Wrapping,
} from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { SelectField } from "../common/SelectField.js";
import { SOURCE_INT_MAX } from "./presentationNumbers.js";
import {
    AddLayoutEntry,
    LayoutEntryHeader,
    LayoutNumber,
    LayoutOverflow,
} from "./LayoutFields.js";
import {
    addWrapping,
    defaultWrappingName,
    layoutEntryReferences,
    removeLayoutEntry,
    renameLayoutEntry,
} from "./layoutEditing.js";

export function LayoutWrapping({
    layout,
    document,
}: {
    layout: LayoutNode;
    document: ProjectDocument;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    return (
        <section className="layout-wrapping-section">
            <h3>{t("layoutAuthoring.wrapping")}</h3>
            {Object.entries(layout.wrapping).map(([name, wrapping]) => {
                const owner = `layout-wrapping-${name}`;
                const patch = (changes: Partial<Wrapping>) =>
                    store.updateLayout(layout.uuid, (current) => ({
                        ...current,
                        wrapping: {
                            ...current.wrapping,
                            [name]: { ...current.wrapping[name]!, ...changes },
                        },
                    }));
                return (
                    <div
                        className="layout-entry"
                        key={`${layout.uuid}:${name}`}
                        data-testid={owner}
                        role="group"
                        aria-label={t("layoutAuthoring.wrappingEntry", {
                            name,
                        })}
                    >
                        <LayoutEntryHeader
                            name={name}
                            owner={owner}
                            references={layoutEntryReferences(
                                document,
                                layout,
                                "wrapping",
                                name,
                            )}
                            validate={(next) =>
                                renameLayoutEntry(
                                    document,
                                    layout.uuid,
                                    "wrapping",
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
                                            "wrapping",
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
                                            "wrapping",
                                            name,
                                        ).document ?? current,
                                )
                            }
                        />
                        {defaultWrappingName(layout) === name && (
                            <p className="muted small layout-entry-status">
                                {t("layoutAuthoring.defaultWrapping")}
                            </p>
                        )}
                        <label className="field-inline">
                            <span>{t("layoutAuthoring.widthMode")}</span>
                            <SelectField
                                label={t("layoutAuthoring.widthMode")}
                                value={
                                    wrapping.widthPixels === null
                                        ? "content"
                                        : "fixed"
                                }
                                data-testid={`${owner}-width-mode`}
                                onValueChange={(value) =>
                                    patch({
                                        widthPixels:
                                            value === "content"
                                                ? null
                                                : Math.max(
                                                      1,
                                                      Math.min(
                                                          layout.maximumWidthPixels,
                                                          document.budgets
                                                              .maximumWidthPixels,
                                                      ),
                                                  ),
                                    })
                                }
                                options={[
                                    {
                                        value: "content",
                                        label: t(
                                            "layoutAuthoring.contentWidth",
                                        ),
                                    },
                                    {
                                        value: "fixed",
                                        label: t("layoutAuthoring.fixedWidth"),
                                        disabled:
                                            wrapping.continuationIndentPixels >=
                                            Math.min(
                                                layout.maximumWidthPixels,
                                                document.budgets
                                                    .maximumWidthPixels,
                                            ),
                                    },
                                ]}
                            />
                        </label>
                        {wrapping.widthPixels !== null && (
                            <LayoutNumber
                                name="widthPixels"
                                value={wrapping.widthPixels}
                                minimum={wrapping.continuationIndentPixels + 1}
                                maximum={document.budgets.maximumWidthPixels}
                                owner={`${layout.uuid}:${owner}`}
                                testId={`${owner}-widthPixels`}
                                onChange={(widthPixels) =>
                                    patch({ widthPixels })
                                }
                            />
                        )}
                        <LayoutNumber
                            name="maximumLines"
                            value={wrapping.maximumLines}
                            minimum={1}
                            maximum={document.budgets.maximumLines}
                            owner={`${layout.uuid}:${owner}`}
                            testId={`${owner}-maximumLines`}
                            onChange={(maximumLines) => patch({ maximumLines })}
                        />
                        <LayoutNumber
                            name="lineHeightPixels"
                            value={wrapping.lineHeightPixels}
                            minimum={1}
                            maximum={document.budgets.maximumHeightPixels}
                            owner={`${layout.uuid}:${owner}`}
                            testId={`${owner}-lineHeightPixels`}
                            onChange={(lineHeightPixels) =>
                                patch({ lineHeightPixels })
                            }
                        />
                        <LayoutNumber
                            name="continuationIndentPixels"
                            value={wrapping.continuationIndentPixels}
                            maximum={
                                wrapping.widthPixels === null
                                    ? SOURCE_INT_MAX
                                    : wrapping.widthPixels - 1
                            }
                            owner={`${layout.uuid}:${owner}`}
                            testId={`${owner}-continuationIndentPixels`}
                            onChange={(continuationIndentPixels) =>
                                patch({ continuationIndentPixels })
                            }
                        />
                        <LayoutOverflow
                            value={wrapping.overflow}
                            onChange={(overflow) => patch({ overflow })}
                            testId={`${owner}-overflow`}
                        />
                        <label className="toggle-row">
                            <input
                                type="checkbox"
                                checked={wrapping.preserveExplicitLines}
                                data-testid={`${owner}-preserveExplicitLines`}
                                onChange={(event) =>
                                    patch({
                                        preserveExplicitLines:
                                            event.target.checked,
                                    })
                                }
                            />
                            {t("layoutAuthoring.preserveExplicitLines")}
                        </label>
                    </div>
                );
            })}
            <AddLayoutEntry
                key={layout.uuid}
                kind="wrapping"
                validate={(name) =>
                    addWrapping(document, layout.uuid, name).error
                }
                onAdd={(name) =>
                    store.updateDocument(
                        (current) =>
                            addWrapping(current, layout.uuid, name).document ??
                            current,
                    )
                }
            />
        </section>
    );
}

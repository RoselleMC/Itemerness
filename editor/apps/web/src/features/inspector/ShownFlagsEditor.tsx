import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import type { ItemNode } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { SuggestionInput } from "../common/SuggestionInput.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import {
    MAX_SHOWN_FLAGS,
    PROJECTION_OWNED_COMPONENTS,
    normalizeShownFlag,
    shownFlagIssue,
    withShownFlags,
} from "../../state/shownFlags.js";

/**
 * Vanilla tooltip components this item keeps visible. Every rendered item hides all other vanilla
 * lines, so the list is empty for most items. Suggestions come from the connected server's own
 * component registry when it advertises one; any namespaced id can still be typed.
 */
export function ShownFlagsEditor({ item }: { item: ItemNode }) {
    const { t } = useTranslation();
    const updateItem = useEditorStore((state) => state.updateItem);
    const serverComponents = useConnectionStore(
        (state) => state.info?.dataComponentTypes,
    );
    const [raw, setRaw] = useState("");
    const [error, setError] = useState<string | null>(null);
    const shown = item.presentation.shownFlags ?? [];
    const suggestions = (serverComponents ?? []).filter(
        (id) => !PROJECTION_OWNED_COMPONENTS.includes(id) && !shown.includes(id),
    );
    const write = (next: (current: readonly string[]) => string[]) => {
        if (!commitInlineEditor()) return;
        updateItem(item.uuid, (current) => ({
            ...current,
            presentation: withShownFlags(
                current.presentation,
                next(current.presentation.shownFlags ?? []),
            ),
        }));
    };
    const add = () => {
        const candidate = normalizeShownFlag(raw);
        const issue = shownFlagIssue(shown, candidate);
        if (issue) {
            setError(
                t(`inspector.shownFlags.${issue}`, { count: MAX_SHOWN_FLAGS }),
            );
            return;
        }
        write((current) => [...current, candidate]);
        setRaw("");
        setError(null);
    };
    return (
        <section data-testid="shown-flags">
            <h3>{t("inspector.shownFlags.heading")}</h3>
            {shown.length ? (
                <ul className="theme-capabilities">
                    {shown.map((component) => (
                        <li key={component}>
                            <code data-testid="shown-flag">{component}</code>
                            <button
                                type="button"
                                className="icon-button danger"
                                aria-label={t("inspector.shownFlags.remove", {
                                    component,
                                })}
                                data-tooltip={t("inspector.shownFlags.remove", {
                                    component,
                                })}
                                data-testid={`shown-flag-remove-${component}`}
                                onClick={() =>
                                    write((current) =>
                                        current.filter(
                                            (entry) => entry !== component,
                                        ),
                                    )
                                }
                            >
                                <Trash2 size={14} />
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="muted small" data-testid="shown-flags-empty">
                    {t("inspector.shownFlags.empty")}
                </p>
            )}
            <div className="theme-add-entry">
                <div className="theme-add-row">
                    <SuggestionInput
                        label={t("inspector.shownFlags.add")}
                        placeholder={t("inspector.shownFlags.add")}
                        value={raw}
                        suggestions={suggestions}
                        aria-invalid={error !== null}
                        data-testid="shown-flag-input"
                        onValueChange={(value) => {
                            setRaw(value);
                            setError(null);
                        }}
                        onKeyDown={(event) => {
                            if (
                                event.key === "Enter" &&
                                !event.currentTarget.hasAttribute(
                                    "aria-activedescendant",
                                )
                            ) {
                                event.preventDefault();
                                event.stopPropagation();
                                add();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="icon-button"
                        aria-label={t("inspector.shownFlags.add")}
                        data-tooltip={t("inspector.shownFlags.add")}
                        data-testid="shown-flag-add"
                        onClick={add}
                    >
                        <Plus size={15} />
                    </button>
                </div>
                {error && (
                    <p role="alert" className="error small">
                        {error}
                    </p>
                )}
            </div>
            <p className="muted small">{t("inspector.shownFlags.hint")}</p>
        </section>
    );
}

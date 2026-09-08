import { useTranslation } from "react-i18next";
import { useEditorStore } from "../../state/store.js";
import { describeContext } from "../../state/interface.js";
import type { PresentationLibraryKind } from "../../state/presentationLibrary.js";
import {
    addPresentationAction,
    presentationEntryActions,
} from "../common/presentationLibraryActions.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { humanizePath } from "../common/messages.js";

export function PresentationLibrary({
    kind,
    query,
}: {
    kind: PresentationLibraryKind;
    query: string;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const entries =
        kind === "formats"
            ? store.document.formats
            : store.document.viewerFacts;
    const selected =
        kind === "formats"
            ? store.selectedFormatUuid
            : store.selectedViewerFactUuid;
    return (
        <div
            className="presentation-library"
            onContextMenu={(event) =>
                describeContext(event, {
                    label: t(`sidebar.mode.${kind}`),
                    items: [addPresentationAction(kind, t)],
                })
            }
        >
            <ul className="item-list" data-testid={`${kind}-tree`}>
                {entries
                    .filter((entry) =>
                        entry.id.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((entry) => (
                        <li key={entry.uuid}>
                            <button
                                type="button"
                                className={`item-row ${selected === entry.uuid ? "selected" : ""}`}
                                data-testid={`${kind}-${entry.id}`}
                                onClick={() => {
                                    if (!commitInlineEditor()) return;
                                    if (kind === "formats")
                                        store.selectFormat(entry.uuid);
                                    else store.selectViewerFact(entry.uuid);
                                }}
                                onContextMenu={(event) => {
                                    if (!commitInlineEditor()) {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        return;
                                    }
                                    describeContext(event, {
                                        label: entry.id,
                                        items: presentationEntryActions(
                                            kind,
                                            entry.uuid,
                                            t,
                                        ),
                                    });
                                }}
                            >
                                <span className="item-row-text">
                                    <span className="item-row-name">
                                        {humanizePath(
                                            entry.id.split(":").pop() ??
                                                entry.id,
                                        )}
                                    </span>
                                    <span className="item-row-note">
                                        {t(
                                            `presentationLibrary.${"kind" in entry ? `formatKinds.${entry.kind}` : `factTypes.${entry.type}`}`,
                                        )}
                                    </span>
                                </span>
                            </button>
                        </li>
                    ))}
            </ul>
        </div>
    );
}

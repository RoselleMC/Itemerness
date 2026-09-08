import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { useEditorStore } from "../../state/store.js";
import {
    builtinFactType,
    libraryIdError,
    presentationLibraryReferences,
    renamePresentationEntry,
    type PresentationLibraryKind,
} from "../../state/presentationLibrary.js";
import { presentationEntryActions } from "../common/presentationLibraryActions.js";
import { BufferedInput } from "../common/BufferedInput.js";
import type { FormatNode, ViewerFactNode } from "@itemerness/protocol";
import { confirmAction } from "../../state/interface.js";

export function PresentationLibraryHeader({
    kind,
    node,
    locked = false,
}: {
    kind: PresentationLibraryKind;
    node: FormatNode | ViewerFactNode;
    locked?: boolean;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const actions = presentationEntryActions(kind, node.uuid, t);
    const references = presentationLibraryReferences(
        store.document,
        kind,
        node.id,
    );
    const builtin = kind === "facts" && builtinFactType(node.id) !== null;
    const [revision, setRevision] = useState(0);
    const pending = useRef(false);
    const applyRename = (id: string) => {
        const current = useEditorStore.getState();
        const source = (
            kind === "formats"
                ? current.document.formats
                : current.document.viewerFacts
        ).find((entry) => entry.uuid === node.uuid);
        if (source?.id !== node.id) return;
        current.updateDocument((document) =>
            renamePresentationEntry(document, kind, node.uuid, id),
        );
    };
    const rename = (id: string) => {
        if (!builtin) return applyRename(id);
        if (pending.current) return false;
        pending.current = true;
        void confirmAction({
            title: t("presentationLibrary.renameBuiltin"),
            message: t("presentationLibrary.renameBuiltinConfirm", {
                id: node.id,
            }),
            accept: t("presentationLibrary.rename"),
        }).then((accepted) => {
            pending.current = false;
            setRevision((value) => value + 1);
            if (accepted) applyRename(id);
        });
        return false;
    };
    return (
        <section>
            <div className="presentation-node-heading">
                <h3>{t(`sidebar.mode.${kind}`)}</h3>
                <div className="inspector-actions">
                    {(["duplicate", "delete"] as const).map((command) => {
                        const action = actions.find(
                            (entry) => entry.id === `${command}-${kind}`,
                        );
                        const Icon = command === "duplicate" ? Copy : Trash2;
                        return (
                            <button
                                key={command}
                                type="button"
                                className="icon-button"
                                aria-label={action?.label}
                                data-tooltip={action?.label}
                                disabled={locked || action?.disabled}
                                data-testid={`${command}-${kind}`}
                                onClick={() => action?.run?.()}
                            >
                                <Icon size={15} />
                            </button>
                        );
                    })}
                </div>
            </div>
            {builtin && (
                <p className="tag">{t("presentationLibrary.builtin")}</p>
            )}
            {locked ? (
                <p className="presentation-entry-id">{node.id}</p>
            ) : (
                <BufferedInput
                    key={`${node.uuid}:${revision}`}
                    value={node.id}
                    owner={`${node.uuid}:id`}
                    label={t("presentationLibrary.id")}
                    testId={`${kind}-id`}
                    validate={(raw) => {
                        const error = libraryIdError(
                            store.document,
                            kind,
                            node.uuid,
                            raw,
                        );
                        return error
                            ? t(`presentationLibrary.errors.${error}`)
                            : null;
                    }}
                    onCommit={rename}
                />
            )}
            <p className="muted small">
                {t("presentationLibrary.references", {
                    count: references.length,
                })}
            </p>
            {references.length > 0 && (
                <details className="presentation-references">
                    <summary>
                        {t("presentationLibrary.referenceLocations")}
                    </summary>
                    <ul>
                        {references.map((reference) => (
                            <li key={reference}>{reference}</li>
                        ))}
                    </ul>
                </details>
            )}
        </section>
    );
}

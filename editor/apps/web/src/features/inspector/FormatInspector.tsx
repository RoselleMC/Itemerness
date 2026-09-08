import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FormatNode } from "@itemerness/protocol";
import { Check, Plus, X } from "lucide-react";
import { useEditorStore } from "../../state/store.js";
import { describeContext } from "../../state/interface.js";
import {
    addPresentationEntry,
    presentationEntryActions,
} from "../common/presentationLibraryActions.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { SelectField } from "../common/SelectField.js";
import { PresentationLibraryHeader } from "./PresentationLibraryHeader.js";
import { FormatFields } from "./FormatFields.js";
import {
    formatError,
    formatVariant,
    retainFormatVariant,
} from "./formatEditing.js";
import "./presentationLibrary.css";

export function FormatInspector({
    previewSettings,
}: {
    previewSettings?: ReactNode;
}) {
    const store = useEditorStore();
    const format = store.document.formats.find(
        (entry) => entry.uuid === store.selectedFormatUuid,
    );
    const { t } = useTranslation();
    if (!format)
        return (
            <aside className="inspector">
                <button
                    type="button"
                    className="action-button"
                    onClick={() => addPresentationEntry("formats")}
                >
                    <Plus size={15} />
                    {t("presentationLibrary.add.formats")}
                </button>
                {previewSettings}
            </aside>
        );
    return (
        <FormatEditor
            key={`${store.workspaceEpoch}:${format.uuid}`}
            format={format}
            previewSettings={previewSettings}
        />
    );
}

function FormatEditor({
    format,
    previewSettings,
}: {
    format: FormatNode;
    previewSettings?: ReactNode;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const [candidate, setCandidate] = useState<FormatNode | null>(null);
    const [error, setError] = useState<string | null>(null);
    const draft = useRef(candidate);
    const applying = useRef(false);
    const stage = (next: FormatNode | null) => {
        draft.current = next;
        setCandidate(next);
        setError(null);
    };
    useEffect(() => {
        window.dispatchEvent(new Event("itemerness:inline-dirty"));
        const finish = (event: Event) => {
            if (draft.current && !applying.current) {
                event.preventDefault();
                setError("applyVariant");
            }
        };
        window.addEventListener("itemerness:commit-inline", finish);
        return () => {
            window.removeEventListener("itemerness:commit-inline", finish);
            queueMicrotask(() =>
                window.dispatchEvent(new Event("itemerness:inline-dirty")),
            );
        };
    }, [candidate]);
    const update = (next: FormatNode) => {
        const base = candidate ?? format;
        const current =
            draft.current ??
            useEditorStore
                .getState()
                .document.formats.find((entry) => entry.uuid === format.uuid);
        if (!current || current.kind !== next.kind) return;
        const values = base as unknown as Record<string, unknown>;
        const changes = Object.fromEntries(
            Object.entries(next).filter(
                ([key, value]) => value !== values[key],
            ),
        );
        next = { ...current, ...changes } as FormatNode;
        if (draft.current) {
            stage(next);
            return;
        }
        const failure = formatError(store.document, next);
        if (failure) {
            stage(next);
            setError(failure);
            return;
        }
        store.updateDocument((document) => ({
            ...document,
            formats: document.formats.map((entry) =>
                entry.uuid === format.uuid ? next : entry,
            ),
        }));
    };
    const apply = () => {
        applying.current = true;
        const committed = commitInlineEditor();
        applying.current = false;
        const next = draft.current;
        if (!committed || !next) return;
        const current = useEditorStore.getState();
        const failure = formatError(current.document, next);
        setError(failure);
        if (failure) return;
        current.updateDocument((document) => ({
            ...document,
            formats: document.formats.map((entry) =>
                entry.uuid === format.uuid
                    ? retainFormatVariant(entry, next)
                    : entry,
            ),
        }));
        stage(null);
    };
    const shown = candidate ?? format;
    return (
        <aside
            className="inspector presentation-inspector"
            aria-label={t("sidebar.mode.formats")}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: format.id,
                    items: presentationEntryActions("formats", format.uuid, t),
                })
            }
        >
            <PresentationLibraryHeader
                kind="formats"
                node={format}
                locked={candidate !== null}
            />
            <section
                data-buffered-value={candidate ? true : undefined}
                data-dirty={candidate ? true : undefined}
            >
                <label className="field">
                    <span>{t("presentationLibrary.formatType")}</span>
                    <SelectField
                        label={t("presentationLibrary.formatType")}
                        value={shown.kind}
                        data-testid="format-kind"
                        options={(
                            [
                                "integer",
                                "decimal",
                                "boolean",
                                "namespacedKey",
                                "list",
                            ] as const
                        ).map((kind) => ({
                            value: kind,
                            label: t(`presentationLibrary.formatKinds.${kind}`),
                        }))}
                        onValueChange={(kind) => {
                            applying.current = true;
                            const committed = commitInlineEditor();
                            applying.current = false;
                            if (committed)
                                stage(
                                    kind === format.kind
                                        ? null
                                        : formatVariant(
                                              format,
                                              kind as FormatNode["kind"],
                                          ),
                                );
                        }}
                    />
                </label>
                <FormatFields
                    key={`${shown.uuid}:${shown.kind}`}
                    document={store.document}
                    format={shown}
                    onChange={update}
                />
                {candidate && (
                    <div className="presentation-variant-actions">
                        <button
                            type="button"
                            className="action-button"
                            data-testid="format-apply"
                            onClick={apply}
                        >
                            <Check size={15} />
                            {t("presentationLibrary.apply")}
                        </button>
                        <button
                            type="button"
                            className="action-button"
                            data-testid="format-cancel"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => stage(null)}
                        >
                            <X size={15} />
                            {t("presentationLibrary.cancel")}
                        </button>
                    </div>
                )}
                {error && (
                    <p className="error small" role="alert">
                        {t(`presentationLibrary.errors.${error}`)}
                    </p>
                )}
            </section>
            {previewSettings}
        </aside>
    );
}

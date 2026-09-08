import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Plus, Trash2, X } from "lucide-react";
import type { ProjectDocument, SpacingNode } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import {
    AssetNumber,
    AssetSelect,
    AssetText,
    codePointError,
    parseCodePoint,
} from "./AssetFields.js";
import { IntegrationUpgradeButton } from "../inspector/DataIntegrationEditor.js";
import { confirmAction } from "../../state/interface.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { usePendingDocumentChange } from "../common/usePendingDocumentChange.js";

export function spacingError(
    value: SpacingNode,
    document?: ProjectDocument,
): string | null {
    if (document && !document.fonts.some((font) => font.id === value.font))
        return "missingFont";
    for (const name of ["negative", "positive"] as const) {
        const range = value[name];
        if (
            codePointError(String(range.firstCodePoint)) ||
            codePointError(String(range.lastCodePoint))
        )
            return "codePoint";
        if (range.firstCodePoint > range.lastCodePoint)
            return "spacingCodePoints";
        if (
            range.minimumAdvancePixels > range.maximumAdvancePixels ||
            (name === "negative"
                ? range.maximumAdvancePixels >= 0
                : range.minimumAdvancePixels <= 0)
        )
            return "spacingAdvances";
        if (
            range.lastCodePoint - range.firstCodePoint !==
            range.maximumAdvancePixels - range.minimumAdvancePixels
        )
            return "spacingSize";
    }
    return null;
}

export function ResourcePolicies({
    document,
    section,
}: {
    document: ProjectDocument;
    section: "spacing" | "measurement";
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    if (section === "measurement") {
        if (document.schemaVersion === 1)
            return (
                <section className="asset-policy">
                    <h3>{t("assetAuthoring.measurement")}</h3>
                    <p className="muted small">
                        {t("assetAuthoring.schemaTwo")}
                    </p>
                    <IntegrationUpgradeButton document={document} />
                </section>
            );
        return (
            <section className="asset-policy">
                <h3>{t("assetAuthoring.measurement")}</h3>
                <AssetSelect
                    name="clientVersion"
                    value={document.measurement?.clientVersion ?? ""}
                    options={[
                        { value: "", label: t("assetAuthoring.serverDefault") },
                        { value: "server", label: t("assetAuthoring.server") },
                        ...["1.21.11", "26.1.1", "26.1.2", "26.2"].map((version) => ({ value: version, label: version })),
                    ]}
                    onChange={(value) =>
                        store.updateDocument((current) => {
                            const measurement = { ...current.measurement! };
                            if (value)
                                measurement.clientVersion = value as NonNullable<ProjectDocument["measurement"]>["clientVersion"];
                            else delete measurement.clientVersion;
                            return { ...current, measurement };
                        })
                    }
                />
                <AssetNumber
                    name="boldExtraAdvancePixels"
                    value={document.measurement!.boldExtraAdvancePixels}
                    minimum={0}
                    maximum={4096}
                    owner={document.documentId}
                    onChange={(value) =>
                        store.updateDocument((current) => ({
                            ...current,
                            measurement: {
                                ...current.measurement!,
                                boldExtraAdvancePixels: value!,
                            },
                        }))
                    }
                />
                <dl className="asset-fixed-values">
                    <dt>{t("assetAuthoring.missingGlyph")}</dt>
                    <dd>{t("assetAuthoring.errorPolicy")}</dd>
                </dl>
            </section>
        );
    }
    return <SpacingPolicy document={document} />;
}

function SpacingPolicy({ document }: { document: ProjectDocument }) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const [draft, setDraft] = useState<SpacingNode | null>(null);
    const pending = useRef(draft);
    const [error, setError] = useState<string | null>(null);
    const finishFields = usePendingDocumentChange(draft !== null, () =>
        setError("pendingDraft"),
    );
    const setPending = (value: SpacingNode | null) => {
        pending.current = value;
        setDraft(value);
        setError(null);
    };
    const update = (change: (source: SpacingNode) => SpacingNode) => {
        if (pending.current) setPending(change(pending.current));
        else
            store.updateDocument((current) =>
                current.spacing
                    ? { ...current, spacing: change(current.spacing) }
                    : current,
            );
    };
    const value = draft ?? document.spacing;
    if (!value)
        return (
            <section className="asset-policy">
                <h3>{t("assetAuthoring.spacing")}</h3>
                <button
                    type="button"
                    className="page-command"
                    data-testid="asset-create-spacing"
                    disabled={!document.fonts.length}
                    onClick={() => {
                        if (commitInlineEditor())
                            setPending({
                                font:
                                    document.fonts.find(
                                        (font) =>
                                            font.metrics === "space-provider",
                                    )?.id ?? document.fonts[0]!.id,
                                negative: {
                                    firstCodePoint: 0xf800,
                                    lastCodePoint: 0xf800,
                                    minimumAdvancePixels: -1,
                                    maximumAdvancePixels: -1,
                                },
                                positive: {
                                    firstCodePoint: 0xf801,
                                    lastCodePoint: 0xf801,
                                    minimumAdvancePixels: 1,
                                    maximumAdvancePixels: 1,
                                },
                            });
                    }}
                >
                    <Plus size={15} />
                    {t("assetAuthoring.createSpacing")}
                </button>
            </section>
        );
    const patchRange = (
        name: "negative" | "positive",
        changes: Partial<SpacingNode["negative"]>,
    ) =>
        update((current) => ({
            ...current,
            [name]: { ...current[name], ...changes },
        }));
    const referenced = document.themes.some(
        (theme) => theme.segmentedFrame || theme.canvas,
    );
    const issue = error ?? spacingError(value, document);
    return (
        <div
            className="asset-policy"
            data-buffered-value={draft ? true : undefined}
            data-dirty={draft ? true : undefined}
        >
            <div className="asset-detail-heading">
                <h3>{t("assetAuthoring.spacing")}</h3>
                {!draft && (
                    <button
                        type="button"
                        className="icon-button"
                        aria-label={t("assetAuthoring.removeSpacing")}
                        data-tooltip={t(
                            referenced
                                ? "assetAuthoring.errors.referenced"
                                : "assetAuthoring.removeSpacing",
                        )}
                        disabled={referenced}
                        data-testid="asset-remove-spacing"
                        onClick={async () => {
                            if (
                                commitInlineEditor() &&
                                (await confirmAction({
                                    title: t("assetAuthoring.removeSpacing"),
                                    message: t(
                                        "assetAuthoring.removeSpacingConfirm",
                                    ),
                                    accept: t("menus.delete"),
                                }))
                            )
                                store.updateDocument((current) =>
                                    current.themes.some(
                                        (theme) =>
                                            theme.segmentedFrame ||
                                            theme.canvas,
                                    )
                                        ? current
                                        : { ...current, spacing: null },
                                );
                        }}
                    >
                        <Trash2 size={15} />
                    </button>
                )}
            </div>
            <AssetSelect
                name="spacingFont"
                value={value.font}
                options={document.fonts.map((font) => ({
                    value: font.id,
                    label: font.id,
                }))}
                onChange={(font) => update((current) => ({ ...current, font }))}
            />
            {(["negative", "positive"] as const).map((name) => (
                <section key={name}>
                    <h3>{t(`assetAuthoring.${name}`)}</h3>
                    <div className="asset-field-grid">
                        {(["firstCodePoint", "lastCodePoint"] as const).map(
                            (field) => (
                                <AssetText
                                    key={field}
                                    name={field}
                                    value={`U+${value[name][field].toString(16).toUpperCase()}`}
                                    owner={`${document.documentId}:${name}`}
                                    testId={`asset-${name}-${field}`}
                                    validate={codePointError}
                                    onChange={(raw) =>
                                        patchRange(name, {
                                            [field]: parseCodePoint(raw),
                                        })
                                    }
                                />
                            ),
                        )}
                        {(
                            [
                                "minimumAdvancePixels",
                                "maximumAdvancePixels",
                            ] as const
                        ).map((field) => (
                            <AssetNumber
                                key={field}
                                name={field}
                                value={value[name][field]}
                                owner={`${document.documentId}:${name}`}
                                testId={`asset-${name}-${field}`}
                                integer
                                minimum={name === "negative" ? -2147483648 : 1}
                                maximum={name === "negative" ? -1 : 2147483647}
                                onChange={(number) =>
                                    patchRange(name, { [field]: number! })
                                }
                            />
                        ))}
                    </div>
                </section>
            ))}
            {issue && (
                <p className="error small" role="alert">
                    {t(`assetAuthoring.errors.${issue}`)}
                </p>
            )}
            {draft && (
                <div className="asset-draft-actions">
                    <button
                        type="button"
                        className="page-command"
                        data-testid="asset-apply-spacing"
                        onClick={() => {
                            if (!finishFields() || !pending.current) return;
                            const failure = spacingError(
                                pending.current,
                                useEditorStore.getState().document,
                            );
                            setError(failure);
                            if (failure) return;
                            const spacing = pending.current;
                            store.updateDocument((current) => ({
                                ...current,
                                spacing,
                            }));
                            setPending(null);
                        }}
                    >
                        <Check size={15} />
                        {t("assetAuthoring.apply")}
                    </button>
                    <button
                        type="button"
                        className="page-command"
                        data-testid="asset-cancel-spacing"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => setPending(null)}
                    >
                        <X size={15} />
                        {t("assetAuthoring.cancel")}
                    </button>
                </div>
            )}
        </div>
    );
}

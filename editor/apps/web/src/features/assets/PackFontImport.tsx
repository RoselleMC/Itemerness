import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileInput, X } from "lucide-react";
import type { MountedPack } from "@itemerness/mc-assets";
import { useEditorStore } from "../../state/store.js";
import {
    packFontIds,
    proposePackFontImport,
    readPackFont,
} from "../../state/packFontImport.js";
import { SelectField } from "../common/SelectField.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { AssetTexture } from "./AssetTexture.js";
import "./packFontImport.css";

export function PackFontImport({
    pack,
    onClose,
}: {
    pack: MountedPack;
    onClose(): void;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const fonts = useMemo(() => packFontIds(pack), [pack]);
    const [font, setFont] = useState(fonts[0] ?? "");
    const [failure, setFailure] = useState<string | null>(null);
    const source = useMemo(() => {
        try {
            return {
                value: font ? readPackFont(pack, font) : null,
                error: null,
            };
        } catch (error) {
            return {
                value: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }, [pack, font]);
    const proposal = useMemo(() => {
        try {
            return {
                value: source.value
                    ? proposePackFontImport(store.document, source.value)
                    : null,
                error: null,
            };
        } catch (error) {
            return {
                value: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }, [source, store.document]);
    const issue = failure ?? source.error ?? proposal.error;
    const apply = () => {
        if (!commitInlineEditor() || !source.value) return;
        const current = useEditorStore.getState();
        if (
            current.workspaceEpoch !== store.workspaceEpoch ||
            !current.packs.some((slot) => slot.pack === pack)
        )
            return;
        try {
            const next = proposePackFontImport(current.document, source.value);
            if (next.added === 0) return;
            current.updateDocument(() => next.document);
            onClose();
        } catch (error) {
            setFailure(error instanceof Error ? error.message : String(error));
        }
    };
    return (
        <section
            className="pack-font-import"
            data-testid="pack-font-import"
            aria-label={t("packFontImport.heading")}
        >
            <header>
                <h3>{t("packFontImport.heading")}</h3>
                <button
                    type="button"
                    className="icon-button"
                    onClick={onClose}
                    aria-label={t("common.close")}
                    data-tooltip={t("common.close")}
                >
                    <X size={16} />
                </button>
            </header>
            <p className="muted small">{pack.name}</p>
            {fonts.length === 0 ? (
                <p>{t("packFontImport.empty")}</p>
            ) : (
                <>
                    <SelectField
                        label={t("packFontImport.font")}
                        value={font}
                        options={fonts.map((id) => ({ value: id, label: id }))}
                        onValueChange={(id) => {
                            setFont(id);
                            setFailure(null);
                        }}
                        data-testid="pack-font-select"
                    />
                    {source.value && (
                        <>
                            <p className="small">
                                {t("packFontImport.summary", {
                                    count: source.value.glyphs.length,
                                    bitmaps: source.value.bitmaps.length,
                                })}
                            </p>
                            <AssetTexture
                                sourcePack={pack}
                                texture={
                                    source.value.bitmaps[0]?.texture ?? null
                                }
                            />
                        </>
                    )}
                    {proposal.value && (
                        <>
                            <p className="small" data-testid="pack-font-count">
                                {t("packFontImport.changes", {
                                    count: proposal.value.added,
                                    existing: proposal.value.existing,
                                })}
                            </p>
                            {proposal.value.conflicts.length > 0 && (
                                <details className="pack-font-conflicts">
                                    <summary>
                                        {t("packFontImport.conflicts", {
                                            count: proposal.value.conflicts
                                                .length,
                                        })}
                                    </summary>
                                    <ul>
                                        {proposal.value.conflicts.map((id) => (
                                            <li key={id}>
                                                <code>{id}</code>
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </>
                    )}
                    {issue && (
                        <p role="alert" className="error small">
                            {t(`packFontImport.errors.${issue}`, {
                                defaultValue: t("packFontImport.invalid", {
                                    message: issue,
                                }),
                            })}
                        </p>
                    )}
                    <button
                        type="button"
                        className="page-command"
                        disabled={!!issue || !proposal.value?.added}
                        onClick={apply}
                        data-testid="pack-font-apply"
                    >
                        <FileInput size={16} />
                        {t("packFontImport.apply")}
                    </button>
                </>
            )}
        </section>
    );
}

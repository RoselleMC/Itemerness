import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "../../state/store.js";
import { describeContext } from "../../state/interface.js";
import { copyAction } from "../common/contextActions.js";
import { Eraser, Languages, Plus } from "lucide-react";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { SelectField } from "../common/SelectField.js";
import {
    LocaleCreationForm,
    LocaleHeader,
    MessageKeyControl,
    type LocaleCreation,
} from "./LocaleControls.js";
import "./locales.css";
import {
    collectDocumentMessageKeys,
    resolveMessage,
} from "../common/messages.js";

/**
 * The content locale matrix.
 *
 * Message keys are rows and languages are columns, with three states per cell that a plain
 * "translated / untranslated" toggle would collapse: present, absent, and present only because a
 * fallback supplies it. That third state is the one that quietly ships English text to Chinese
 * players, so it gets its own colour rather than counting as done.
 *
 * This is content translation, not interface translation. Editing here changes the project
 * document; the editor's own language lives in `src/i18n`.
 */
export function LocaleMatrix() {
    const { t } = useTranslation();
    const document = useEditorStore((state) => state.document);
    const updateDocument = useEditorStore((state) => state.updateDocument);
    const setMessage = useEditorStore((state) => state.setMessage);
    const [filter, setFilter] = useState("");
    const epoch = useEditorStore((state) => state.workspaceEpoch);
    const [creation, setCreation] = useState<LocaleCreation | null>(null);
    const [revealLocale, setRevealLocale] = useState<string | null>(null);
    const [activeLocaleUuid, setActiveLocaleUuid] = useState<string | null>(
        null,
    );
    const activeLocale =
        document.locales.find((locale) => locale.uuid === activeLocaleUuid) ??
        document.locales.find(
            (locale) => locale.locale === document.defaultLocale,
        ) ??
        document.locales[0];
    useEffect(() => {
        setCreation(null);
        setRevealLocale(null);
        setActiveLocaleUuid(null);
    }, [epoch]);

    const keys = useMemo(
        () => collectDocumentMessageKeys(document),
        [document],
    );
    const visible = keys.filter((key) =>
        key.toLowerCase().includes(filter.toLowerCase()),
    );

    return (
        <section className="locale-matrix" aria-label={t("locales.heading")}>
            <header className="panel-header">
                <input
                    type="search"
                    aria-label={t("locales.search")}
                    placeholder={t("locales.search")}
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    data-testid="locale-filter"
                />
                <div className="locale-toolbar-actions">
                    <button
                        type="button"
                        data-testid="add-locale"
                        onClick={() => {
                            if (commitInlineEditor())
                                setCreation({ kind: "locale" });
                        }}
                    >
                        <Languages size={16} />
                        {t("localeEditing.addLocale")}
                    </button>
                    <button
                        type="button"
                        disabled={!document.locales.length}
                        data-testid="add-message"
                        onClick={() => {
                            if (commitInlineEditor())
                                setCreation({ kind: "message" });
                        }}
                    >
                        <Plus size={16} />
                        {t("localeEditing.addMessage")}
                    </button>
                </div>
            </header>
            {creation && (
                <LocaleCreationForm
                    key={`${creation.kind}-${creation.kind === "locale" ? (creation.sourceUuid ?? "") : ""}-${epoch}`}
                    creation={creation}
                    close={() => setCreation(null)}
                    createdMessage={setFilter}
                    createdLocale={(code) => {
                        setRevealLocale(code);
                        setActiveLocaleUuid(
                            useEditorStore
                                .getState()
                                .document.locales.find(
                                    (locale) => locale.locale === code,
                                )?.uuid ?? null,
                        );
                    }}
                />
            )}
            {activeLocale && (
                <div className="locale-narrow-selector">
                    <SelectField
                        label={t("localeEditing.language")}
                        value={activeLocale.uuid}
                        options={document.locales.map((locale) => ({
                            value: locale.uuid,
                            label: locale.locale,
                        }))}
                        data-testid="locale-narrow-language"
                        onValueChange={(uuid) => {
                            if (commitInlineEditor()) setActiveLocaleUuid(uuid);
                        }}
                    />
                </div>
            )}
            <div
                className="locale-table-scroll"
                tabIndex={0}
                aria-label={t("locales.heading")}
            >
                <table data-testid="locale-table">
                    <thead>
                        <tr>
                            <th>{t("locales.key")}</th>
                            {document.locales.map((locale) => {
                                const translated = keys.filter((key) =>
                                    Object.hasOwn(locale.messages, key),
                                ).length;
                                return (
                                    <th
                                        key={locale.uuid}
                                        data-active-locale={
                                            locale.uuid === activeLocale?.uuid
                                        }
                                    >
                                        <LocaleHeader
                                            locale={locale}
                                            translated={translated}
                                            total={keys.length}
                                            reveal={
                                                revealLocale === locale.locale
                                            }
                                            duplicate={(sourceUuid) =>
                                                setCreation({
                                                    kind: "locale",
                                                    sourceUuid,
                                                })
                                            }
                                        />
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((key) => (
                            <tr key={key}>
                                <th
                                    scope="row"
                                    tabIndex={0}
                                    onContextMenu={(event) =>
                                        describeContext(event, {
                                            label: key,
                                            items: [
                                                copyAction(
                                                    "copy-key",
                                                    t("menus.copyKey"),
                                                    key,
                                                ),
                                            ],
                                        })
                                    }
                                >
                                    <MessageKeyControl
                                        messageKey={key}
                                        renamed={(next) => {
                                            if (
                                                filter &&
                                                !next
                                                    .toLowerCase()
                                                    .includes(
                                                        filter.toLowerCase(),
                                                    )
                                            )
                                                setFilter(next);
                                        }}
                                    />
                                </th>
                                {document.locales.map((locale) => {
                                    const resolved = resolveMessage(
                                        document,
                                        locale.locale,
                                        key,
                                    );
                                    const inherited =
                                        resolved.source === "fallback" ||
                                        resolved.source === "default";
                                    const status = inherited
                                        ? t("locales.inheritedFrom", {
                                              locale: resolved.sourceLocale,
                                          })
                                        : resolved.source === "missing"
                                          ? t("locales.missing")
                                          : resolved.text === ""
                                            ? t("locales.emptyTranslation")
                                            : null;
                                    const statusId = `message-status-${locale.uuid}-${key}`;
                                    return (
                                        <td
                                            key={locale.locale}
                                            data-active-locale={
                                                locale.uuid ===
                                                activeLocale?.uuid
                                            }
                                            className={`cell-${inherited ? "fallback" : resolved.source}`}
                                            data-message-source={
                                                resolved.source
                                            }
                                            onContextMenu={(event) =>
                                                describeContext(event, {
                                                    label: key,
                                                    textExtras: true,
                                                    items: [
                                                        {
                                                            ...copyAction(
                                                                "copy-key",
                                                                t(
                                                                    "menus.copyKey",
                                                                ),
                                                                key,
                                                            ),
                                                            separator: true,
                                                        },
                                                        {
                                                            id: "clear-translation",
                                                            label: t(
                                                                "menus.clearTranslation",
                                                            ),
                                                            icon: Eraser,
                                                            disabled:
                                                                !Object.hasOwn(
                                                                    locale.messages,
                                                                    key,
                                                                ),
                                                            run: () =>
                                                                updateDocument(
                                                                    (
                                                                        draft,
                                                                    ) => ({
                                                                        ...draft,
                                                                        locales:
                                                                            draft.locales.map(
                                                                                (
                                                                                    entry,
                                                                                ) => {
                                                                                    if (
                                                                                        entry.locale !==
                                                                                        locale.locale
                                                                                    )
                                                                                        return entry;
                                                                                    const messages =
                                                                                        {
                                                                                            ...entry.messages,
                                                                                        };
                                                                                    delete messages[
                                                                                        key
                                                                                    ];
                                                                                    return {
                                                                                        ...entry,
                                                                                        messages,
                                                                                    };
                                                                                },
                                                                            ),
                                                                    }),
                                                                ),
                                                        },
                                                    ],
                                                })
                                            }
                                        >
                                            <textarea
                                                rows={2}
                                                aria-label={`${key} (${locale.locale})`}
                                                aria-describedby={
                                                    status
                                                        ? statusId
                                                        : undefined
                                                }
                                                value={
                                                    resolved.source === "own"
                                                        ? resolved.text
                                                        : ""
                                                }
                                                placeholder={
                                                    resolved.source ===
                                                    "missing"
                                                        ? t("locales.missing")
                                                        : inherited
                                                          ? resolved.text ||
                                                            t(
                                                                "locales.emptyTranslation",
                                                            )
                                                          : undefined
                                                }
                                                onChange={(event) =>
                                                    setMessage(
                                                        locale.locale,
                                                        key,
                                                        event.target.value,
                                                    )
                                                }
                                                data-testid={`message-${locale.locale}-${key}`}
                                            />
                                            {status && (
                                                <div
                                                    id={statusId}
                                                    className={
                                                        resolved.source ===
                                                        "missing"
                                                            ? "sr-only"
                                                            : "muted small"
                                                    }
                                                >
                                                    {status}
                                                </div>
                                            )}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

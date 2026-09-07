import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LocaleNode, ProjectDocument } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { describeContext } from "../../state/interface.js";
import { copyAction } from "../common/contextActions.js";
import { Eraser } from "lucide-react";

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
    const [filter, setFilter] = useState("");

    const keys = useMemo(
        () =>
            [
                ...new Set(
                    document.locales.flatMap((locale) =>
                        Object.keys(locale.messages),
                    ),
                ),
            ].sort(),
        [document.locales],
    );
    const visible = keys.filter((key) =>
        key.toLowerCase().includes(filter.toLowerCase()),
    );

    const resolveThroughFallback = (
        locale: LocaleNode,
        key: string,
    ): "own" | "fallback" | "missing" => {
        if (locale.messages[key] !== undefined) return "own";
        const seen = new Set<string>([locale.locale]);
        let current = locale.fallback;
        while (current && !seen.has(current)) {
            seen.add(current);
            const node = document.locales.find(
                (entry) => entry.locale === current,
            );
            if (!node) break;
            if (node.messages[key] !== undefined) return "fallback";
            current = node.fallback;
        }
        return "missing";
    };

    const setMessage = (localeCode: string, key: string, value: string) => {
        updateDocument((draft: ProjectDocument) => ({
            ...draft,
            locales: draft.locales.map((locale) =>
                locale.locale === localeCode
                    ? {
                          ...locale,
                          messages: { ...locale.messages, [key]: value },
                      }
                    : locale,
            ),
        }));
    };

    return (
        <section className="locale-matrix" aria-label={t("locales.heading")}>
            <header className="panel-header">
                <input
                    type="search"
                    placeholder={t("locales.search")}
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    data-testid="locale-filter"
                />
            </header>
            <table data-testid="locale-table">
                <thead>
                    <tr>
                        <th>{t("locales.key")}</th>
                        {document.locales.map((locale) => {
                            const translated = keys.filter(
                                (key) => locale.messages[key] !== undefined,
                            ).length;
                            return (
                                <th key={locale.locale}>
                                    <div>{locale.locale}</div>
                                    {locale.locale ===
                                    document.defaultLocale ? (
                                        <span className="tag">
                                            {t("locales.defaultLocale")}
                                        </span>
                                    ) : null}
                                    {locale.fallback ? (
                                        <span className="muted small">
                                            {t("locales.fallbackChain", {
                                                locale: locale.fallback,
                                            })}
                                        </span>
                                    ) : null}
                                    <div className="muted small">
                                        {t("locales.stats", {
                                            translated,
                                            total: keys.length,
                                        })}
                                    </div>
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
                                <code>{key}</code>
                            </th>
                            {document.locales.map((locale) => {
                                const state = resolveThroughFallback(
                                    locale,
                                    key,
                                );
                                return (
                                    <td
                                        key={locale.locale}
                                        className={`cell-${state}`}
                                        onContextMenu={(event) =>
                                            describeContext(event, {
                                                label: key,
                                                textExtras: true,
                                                items: [
                                                    {
                                                        ...copyAction(
                                                            "copy-key",
                                                            t("menus.copyKey"),
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
                                                            locale.messages[
                                                                key
                                                            ] === undefined,
                                                        run: () =>
                                                            updateDocument(
                                                                (draft) => ({
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
                                        <input
                                            value={locale.messages[key] ?? ""}
                                            placeholder={
                                                state === "fallback"
                                                    ? t("locales.fallbackOnly")
                                                    : t("locales.missing")
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
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    );
}

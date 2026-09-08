import { useEffect, useRef, useState, type FormEvent } from "react";
import { Copy, Languages, Plus, Star, Trash2, X } from "lucide-react";
import {
    localeSchema,
    messageKeySchema,
    type LocaleNode,
} from "@itemerness/protocol";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "../../state/store.js";
import {
    confirmAction,
    describeContext,
    runMenuAction,
    type MenuAction,
} from "../../state/interface.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { SelectField } from "../common/SelectField.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import { copyAction } from "../common/contextActions.js";
import { collectDocumentMessageKeys } from "../common/messages.js";
import {
    addLocale,
    canSetFallback,
    hasDynamicMessageReference,
    localeInUse,
    messageInUse,
    removeLocale,
    removeMessage,
    renameLocale,
    renameMessage,
} from "./localeEditing.js";

export type LocaleCreation =
    { kind: "locale"; sourceUuid?: string } | { kind: "message" };

export function LocaleCreationForm({
    creation,
    close,
    createdMessage,
    createdLocale,
}: {
    creation: LocaleCreation;
    close(): void;
    createdMessage(key: string): void;
    createdLocale(code: string): void;
}) {
    const { t } = useTranslation();
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const label = t(
        `localeEditing.${creation.kind === "locale" ? "localeCode" : "messageKey"}`,
    );
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!commitInlineEditor()) return;
        const store = useEditorStore.getState();
        const document = store.document;
        if (creation.kind === "locale") {
            if (!localeSchema.safeParse(value).success)
                return setError(t("localeEditing.invalidLocale"));
            if (document.locales.some((entry) => entry.locale === value))
                return setError(t("localeEditing.duplicateLocale"));
            store.updateDocument((document) =>
                addLocale(document, value, creation.sourceUuid),
            );
            createdLocale(value);
        } else {
            if (!messageKeySchema.safeParse(value).success)
                return setError(t("localeEditing.invalidMessage"));
            if (collectDocumentMessageKeys(document).includes(value))
                return setError(t("localeEditing.duplicateMessage"));
            if (
                !document.locales.some(
                    (entry) => entry.locale === document.defaultLocale,
                )
            )
                return;
            store.setMessage(document.defaultLocale, value, "");
            createdMessage(value);
        }
        close();
    };
    return (
        <form
            className="locale-creation"
            onSubmit={submit}
            data-testid="locale-creation"
        >
            <label>
                {label}
                <input
                    autoFocus
                    value={value}
                    aria-label={label}
                    aria-invalid={!!error}
                    onChange={(event) => {
                        setValue(event.target.value);
                        setError(null);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.stopPropagation();
                            close();
                        }
                    }}
                    data-testid="locale-create-value"
                />
            </label>
            <button type="submit">
                <Plus size={15} />
                {t(
                    creation.kind === "locale" && creation.sourceUuid
                        ? "localeEditing.duplicateLocaleAction"
                        : "localeEditing.create",
                )}
            </button>
            <button
                type="button"
                className="icon-button"
                aria-label={t("localeEditing.cancel")}
                data-tooltip={t("localeEditing.cancel")}
                onClick={close}
            >
                <X size={16} />
            </button>
            {error && (
                <span className="error small" role="alert">
                    {error}
                </span>
            )}
        </form>
    );
}

export function LocaleHeader({
    locale,
    translated,
    total,
    duplicate,
    reveal = false,
}: {
    locale: LocaleNode;
    translated: number;
    total: number;
    duplicate(uuid: string): void;
    reveal?: boolean;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const header = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (reveal)
            header.current?.scrollIntoView({
                block: "nearest",
                inline: "nearest",
            });
    }, [reveal]);
    const actions: MenuAction[] = [
        copyAction("copy-locale", t("menus.copyId"), locale.locale),
        {
            id: "duplicate-locale",
            label: t("localeEditing.duplicateLocaleAction"),
            icon: Copy,
            run: () => {
                if (commitInlineEditor()) duplicate(locale.uuid);
            },
        },
        {
            id: "default-locale",
            label: t("localeEditing.setDefault"),
            icon: Star,
            checked: store.document.defaultLocale === locale.locale,
            run: () => {
                if (commitInlineEditor())
                    store.updateDocument((document) => ({
                        ...document,
                        defaultLocale:
                            document.locales.find(
                                (entry) => entry.uuid === locale.uuid,
                            )?.locale ?? document.defaultLocale,
                    }));
            },
        },
        {
            id: "delete-locale",
            label: t("localeEditing.deleteLocale"),
            icon: Trash2,
            danger: true,
            disabled: localeInUse(store.document, locale.locale),
            run: async () => {
                if (
                    !commitInlineEditor() ||
                    !(await confirmAction({
                        title: t("localeEditing.deleteLocale"),
                        message: t("localeEditing.deleteConfirm", {
                            id: locale.locale,
                        }),
                        accept: t("menus.delete"),
                    }))
                )
                    return;
                const current = useEditorStore.getState();
                current.updateDocument((document) =>
                    removeLocale(document, locale.uuid),
                );
                if (current.viewerLocale === locale.locale)
                    current.setViewerLocale(current.document.defaultLocale);
            },
        },
    ];
    return (
        <div
            ref={header}
            className="locale-column-controls"
            onContextMenu={(event) =>
                describeContext(event, { label: locale.locale, items: actions })
            }
        >
            <div className="locale-object-heading">
                <Languages size={15} />
                <BufferedInput
                    value={locale.locale}
                    label={t("localeEditing.localeCode")}
                    owner={locale.uuid}
                    testId={`locale-code-${locale.uuid}`}
                    validate={(code) =>
                        !localeSchema.safeParse(code).success
                            ? t("localeEditing.invalidLocale")
                            : store.document.locales.some(
                                    (entry) =>
                                        entry.uuid !== locale.uuid &&
                                        entry.locale === code,
                                )
                              ? t("localeEditing.duplicateLocale")
                              : null
                    }
                    onCommit={(code) => {
                        const wasSelected =
                            useEditorStore.getState().viewerLocale ===
                            locale.locale;
                        store.updateDocument((document) =>
                            renameLocale(document, locale.uuid, code),
                        );
                        if (wasSelected) store.setViewerLocale(code);
                    }}
                />
            </div>
            <div className="locale-object-actions">
                {actions.slice(1).map((action) => (
                    <button
                        key={action.id}
                        type="button"
                        className="icon-button"
                        aria-label={action.label}
                        data-tooltip={
                            action.disabled && action.id === "delete-locale"
                                ? t("localeEditing.localeInUse")
                                : action.label
                        }
                        disabled={action.disabled}
                        aria-pressed={
                            action.id === "default-locale"
                                ? action.checked
                                : undefined
                        }
                        data-testid={`${action.id}-${locale.locale}`}
                        onClick={() => runMenuAction(action)}
                    >
                        {action.icon && <action.icon size={15} />}
                    </button>
                ))}
                {store.document.defaultLocale === locale.locale && (
                    <span className="tag">{t("locales.defaultLocale")}</span>
                )}
            </div>
            <label className="locale-fallback">
                <span>{t("localeEditing.fallback")}</span>
                <SelectField
                    label={`${t("localeEditing.fallback")} (${locale.locale})`}
                    value={locale.fallback ?? ""}
                    options={[
                        { value: "", label: t("localeEditing.noFallback") },
                        ...store.document.locales
                            .filter((entry) => entry.uuid !== locale.uuid)
                            .map((entry) => ({
                                value: entry.locale,
                                label: entry.locale,
                                disabled: !canSetFallback(
                                    store.document,
                                    locale.uuid,
                                    entry.locale,
                                ),
                            })),
                    ]}
                    data-testid={`locale-fallback-${locale.locale}`}
                    onValueChange={(value) => {
                        if (!commitInlineEditor()) return;
                        store.updateDocument((document) =>
                            !canSetFallback(
                                document,
                                locale.uuid,
                                value || null,
                            )
                                ? document
                                : {
                                      ...document,
                                      locales: document.locales.map((entry) =>
                                          entry.uuid === locale.uuid
                                              ? {
                                                    ...entry,
                                                    fallback: value || null,
                                                }
                                              : entry,
                                      ),
                                  },
                        );
                    }}
                />
            </label>
            <div className="muted small">
                {t("locales.stats", { translated, total })}
            </div>
        </div>
    );
}

export function MessageKeyControl({
    messageKey,
    renamed,
}: {
    messageKey: string;
    renamed(next: string): void;
}) {
    const { t } = useTranslation();
    const store = useEditorStore();
    const dynamic = hasDynamicMessageReference(store.document, messageKey);
    const remove: MenuAction = {
        id: "delete-message",
        label: t("localeEditing.deleteMessage"),
        icon: Trash2,
        danger: true,
        disabled: messageInUse(store.document, messageKey),
        run: async () => {
            if (
                !commitInlineEditor() ||
                !(await confirmAction({
                    title: t("localeEditing.deleteMessage"),
                    message: t("localeEditing.deleteConfirm", {
                        id: messageKey,
                    }),
                    accept: t("menus.delete"),
                }))
            )
                return;
            useEditorStore
                .getState()
                .updateDocument((document) =>
                    removeMessage(document, messageKey),
                );
        },
    };
    return (
        <div
            className="locale-message-key"
            onContextMenu={(event) =>
                describeContext(event, {
                    label: messageKey,
                    items: [
                        copyAction("copy-key", t("menus.copyKey"), messageKey),
                        remove,
                    ],
                })
            }
        >
            {dynamic ? (
                <code data-tooltip={t("localeEditing.dynamicReference")}>
                    {messageKey}
                </code>
            ) : (
                <BufferedInput
                    value={messageKey}
                    label={t("localeEditing.messageKey")}
                    owner={messageKey}
                    testId={`message-key-${messageKey}`}
                    validate={(next) =>
                        !messageKeySchema.safeParse(next).success
                            ? t("localeEditing.invalidMessage")
                            : next !== messageKey &&
                                collectDocumentMessageKeys(
                                    store.document,
                                ).includes(next)
                              ? t("localeEditing.duplicateMessage")
                              : null
                    }
                    onCommit={(next) => {
                        store.updateDocument((document) =>
                            renameMessage(document, messageKey, next),
                        );
                        renamed(next);
                    }}
                />
            )}
            <button
                type="button"
                className="icon-button"
                aria-label={remove.label}
                data-tooltip={
                    remove.disabled
                        ? t("localeEditing.messageInUse")
                        : remove.label
                }
                disabled={remove.disabled}
                data-testid={`delete-message-${messageKey}`}
                onClick={() => runMenuAction(remove)}
            >
                <Trash2 size={15} />
            </button>
        </div>
    );
}

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { itemKey } from "@itemerness/protocol";
import { useEditorStore } from "../../state/store.js";
import { useConnectionStore } from "../../state/connection.js";
import { contextOwner } from "../../state/interface.js";
import {
    closeItemCreation,
    useItemCreationDialog,
    type ItemCreationRequest,
} from "../../state/itemCreationDialog.js";
import {
    freshBlankItemId,
    initialItemBinding,
    itemCreationIssue,
    type ItemCreationOptions,
} from "../../state/itemCreation.js";
import { freshItemCopyId } from "../../state/itemIdentity.js";
import { SelectField } from "../common/SelectField.js";
import { itemDisplayName, resolveMessage } from "../common/messages.js";
import { ItemIcon } from "../common/ItemIcon.js";
import "./new-item.css";

const KEEP = "__source__";
const INHERIT = "__project__";

export function NewItemDialog() {
    const request = useItemCreationDialog((state) => state.request);
    useEffect(() => closeItemCreation, []);
    return request
        ? createPortal(
              <NewItemForm key={request.owner} request={request} />,
              document.body,
          )
        : null;
}

function NewItemForm({ request }: { request: ItemCreationRequest }) {
    const { t } = useTranslation();
    const document = request.document;
    const [sourceUuid, setSourceUuid] = useState("");
    const [id, setId] = useState(() => freshBlankItemId(document));
    const [name, setName] = useState(() => t("sidebar.newItemName"));
    const idChanged = useRef(false);
    const nameChanged = useRef(false);
    const firstField = useRef<HTMLInputElement>(null);
    const applying = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const initialBinding = (kind: "theme" | "layout") =>
        initialItemBinding(document, kind) === null ? INHERIT : "";
    const [theme, setTheme] = useState(() => initialBinding("theme"));
    const [layout, setLayout] = useState(() => initialBinding("layout"));
    const source = document.items.find((item) => item.uuid === sourceUuid);

    useEffect(() => {
        const previous = window.document.activeElement;
        firstField.current?.focus({ preventScroll: true });
        const cancelStale = () => {
            if (!applying.current && request.owner !== contextOwner())
                closeItemCreation();
        };
        const stopDocument = useEditorStore.subscribe(cancelStale);
        const stopConnection = useConnectionStore.subscribe(cancelStale);
        const blockCommit = (event: Event) => {
            if (!applying.current) {
                event.preventDefault();
                setError("finishCreation");
            }
        };
        window.addEventListener("itemerness:commit-inline", blockCommit);
        window.dispatchEvent(new Event("itemerness:inline-dirty"));
        return () => {
            stopDocument();
            stopConnection();
            window.removeEventListener("itemerness:commit-inline", blockCommit);
            queueMicrotask(() => {
                window.dispatchEvent(new Event("itemerness:inline-dirty"));
                if (
                    previous instanceof HTMLElement &&
                    previous.isConnected &&
                    request.owner === contextOwner()
                )
                    previous.focus({ preventScroll: true });
            });
        };
    }, [request]);

    const options: ItemCreationOptions = {
        id,
        ...(sourceUuid ? { sourceUuid } : {}),
        ...(theme === KEEP ? {} : { theme: theme === INHERIT ? null : theme }),
        ...(layout === KEEP
            ? {}
            : { layout: layout === INHERIT ? null : layout }),
    };
    const issue = itemCreationIssue(document, name, options);
    const changeSource = (uuid: string) => {
        const next = document.items.find((item) => item.uuid === uuid);
        setSourceUuid(uuid);
        if (!idChanged.current)
            setId(
                next
                    ? freshItemCopyId(document, next)
                    : freshBlankItemId(document),
            );
        if (!nameChanged.current)
            setName(
                next
                    ? resolveMessage(
                          document,
                          document.defaultLocale,
                          next.presentation.nameMessage,
                      ).text
                    : t("sidebar.newItemName"),
            );
        setTheme(next ? KEEP : initialBinding("theme"));
        setLayout(next ? KEEP : initialBinding("layout"));
        setError(null);
    };
    const create = () => {
        if (request.owner !== contextOwner()) {
            closeItemCreation();
            return;
        }
        if (issue) {
            setError(issue);
            return;
        }
        applying.current = true;
        try {
            useEditorStore.getState().addItem(name, options);
            closeItemCreation();
        } catch (reason) {
            setError(
                reason instanceof Error ? reason.message : "creationFailed",
            );
        } finally {
            applying.current = false;
        }
    };
    const choice = (kind: "theme" | "layout") => {
        const entries = document[kind === "theme" ? "themes" : "layouts"];
        const projectDefault =
            document[kind === "theme" ? "defaultTheme" : "defaultLayout"];
        const original = source?.presentation[kind];
        return (
            <label className="field">
                <span>{t(`itemCreation.${kind}`)}</span>
                <SelectField
                    label={t(`itemCreation.${kind}`)}
                    value={kind === "theme" ? theme : layout}
                    onValueChange={kind === "theme" ? setTheme : setLayout}
                    data-testid={`new-item-${kind}`}
                    options={[
                        {
                            value: "",
                            label: t("itemCreation.choose"),
                            disabled: true,
                        },
                        ...(source
                            ? [
                                  {
                                      value: KEEP,
                                      label: t("itemCreation.keep", {
                                          value:
                                              original ??
                                              t("itemCreation.projectDefault", {
                                                  value: projectDefault ?? "?",
                                              }),
                                      }),
                                  },
                              ]
                            : []),
                        ...(document.schemaVersion === 2 && projectDefault
                            ? [
                                  {
                                      value: INHERIT,
                                      label: t("itemCreation.projectDefault", {
                                          value: projectDefault,
                                      }),
                                  },
                              ]
                            : []),
                        ...entries.map((entry) => ({
                            value: entry.id,
                            label: entry.id,
                        })),
                    ]}
                />
            </label>
        );
    };
    return (
        <div className="unsaved-backdrop new-item-backdrop">
            <dialog
                open
                aria-modal="false"
                aria-labelledby="new-item-heading"
                className="unsaved-dialog new-item-dialog"
                data-testid="new-item-dialog"
                data-buffered-value
                data-dirty="true"
                onCancel={(event) => {
                    event.preventDefault();
                    closeItemCreation();
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        closeItemCreation();
                    }
                }}
            >
                <header>
                    <h2 id="new-item-heading">{t("sidebar.addItem")}</h2>
                    <button
                        type="button"
                        className="icon-button"
                        data-testid="new-item-close"
                        aria-label={t("common.close")}
                        data-tooltip={t("common.close")}
                        onClick={closeItemCreation}
                    >
                        <X size={16} />
                    </button>
                </header>
                <div className="new-item-fields">
                    <label className="field">
                        <span>{t("itemCreation.startingPoint")}</span>
                        <SelectField
                            label={t("itemCreation.startingPoint")}
                            value={sourceUuid}
                            onValueChange={changeSource}
                            data-testid="new-item-source"
                            options={[
                                { value: "", label: t("itemCreation.blank") },
                                ...document.items.map((item) => ({
                                    value: item.uuid,
                                    label: `${itemDisplayName(document, document.defaultLocale, item.presentation.nameMessage)} (${itemKey(document, item)}) - ${t(item.enabled ? "itemCreation.enabled" : "sidebar.disabled")}`,
                                })),
                            ]}
                        />
                    </label>
                    {source && (
                        <div
                            className="new-item-source-summary"
                            data-testid="new-item-source-summary"
                        >
                            <ItemIcon
                                materialId={source.definition.material}
                                label={source.definition.material}
                                size={24}
                            />
                            <code>{source.definition.material}</code>
                            <span>
                                {t(
                                    source.enabled
                                        ? "itemCreation.enabled"
                                        : "sidebar.disabled",
                                )}
                            </span>
                        </div>
                    )}
                    <label className="field">
                        <span>{t("itemCreation.id")}</span>
                        <input
                            ref={firstField}
                            value={id}
                            data-testid="new-item-id"
                            aria-required="true"
                            spellCheck={false}
                            autoComplete="off"
                            onChange={(event) => {
                                idChanged.current = true;
                                setId(event.target.value);
                            }}
                        />
                    </label>
                    <label className="field">
                        <span>
                            {t("itemCreation.name", {
                                locale: document.defaultLocale,
                            })}
                        </span>
                        <input
                            value={name}
                            data-testid="new-item-name"
                            aria-required="true"
                            onChange={(event) => {
                                nameChanged.current = true;
                                setName(event.target.value);
                            }}
                        />
                    </label>
                    {choice("layout")}
                    {choice("theme")}
                    <dl className="new-item-status">
                        <dt>{t("itemCreation.newStatus")}</dt>
                        <dd>{t("sidebar.disabled")}</dd>
                    </dl>
                    {(error || issue) && (
                        <p
                            className="error"
                            role="alert"
                            data-testid="new-item-error"
                        >
                            {t(`itemCreation.errors.${error ?? issue}`)}
                        </p>
                    )}
                </div>
                <footer className="dialog-actions">
                    <button
                        type="button"
                        data-testid="new-item-cancel"
                        onClick={closeItemCreation}
                    >
                        {t("settings.cancel")}
                    </button>
                    <button
                        type="button"
                        className="primary-command"
                        data-testid="new-item-create"
                        disabled={!!issue}
                        onClick={create}
                    >
                        <Plus size={15} />
                        {t("itemCreation.create")}
                    </button>
                </footer>
            </dialog>
        </div>
    );
}

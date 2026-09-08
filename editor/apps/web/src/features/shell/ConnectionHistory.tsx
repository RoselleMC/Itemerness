import { useTranslation } from "react-i18next";
import { Server, X } from "lucide-react";
import {
    useConnectionHistory,
    type ConnectionHistoryEntry,
} from "../../state/connectionHistory.js";

export function ConnectionHistory({
    onSelect,
}: {
    onSelect(url: string, expectedServerId?: string): void;
}) {
    const { t } = useTranslation();
    const { entries, remove } = useConnectionHistory();
    if (!entries.length) return null;
    const select = (entry: ConnectionHistoryEntry, url: string) =>
        onSelect(url, entry.persistent ? entry.serverId : undefined);
    return (
        <section
            className="connection-history"
            aria-label={t("connection.history")}
            data-testid="connection-history"
        >
            <h3>{t("connection.history")}</h3>
            <ul>
                {entries.map((entry) => (
                    <li key={entry.key} data-server-id={entry.serverId}>
                        <div className="connection-history-row">
                            <button
                                type="button"
                                className="history-server"
                                onClick={() =>
                                    select(entry, entry.addresses[0]!.url)
                                }
                            >
                                <Server size={15} />
                                <span>
                                    <strong>{entry.name}</strong>
                                    <small>{entry.addresses[0]!.url}</small>
                                </span>
                            </button>
                            <button
                                type="button"
                                className="icon-button"
                                aria-label={t("connection.forgetServer", {
                                    name: entry.name,
                                })}
                                data-tooltip={t("connection.forgetServer", {
                                    name: entry.name,
                                })}
                                onClick={() => remove(entry.key)}
                            >
                                <X size={14} />
                            </button>
                        </div>
                        {entry.addresses.length > 1 && (
                            <details>
                                <summary>
                                    {t("connection.addressCount", {
                                        count: entry.addresses.length,
                                    })}
                                </summary>
                                <ul>
                                    {entry.addresses.map(
                                        ({ url, lastUsedAt }) => (
                                            <li
                                                className="connection-history-row"
                                                key={url}
                                            >
                                                <button
                                                    type="button"
                                                    className="history-server"
                                                    onClick={() =>
                                                        select(entry, url)
                                                    }
                                                >
                                                    <span>
                                                        <small>{url}</small>
                                                        <small>
                                                            {new Intl.DateTimeFormat(
                                                                undefined,
                                                                {
                                                                    dateStyle:
                                                                        "medium",
                                                                },
                                                            ).format(
                                                                lastUsedAt,
                                                            )}
                                                        </small>
                                                    </span>
                                                </button>
                                                <button
                                                    type="button"
                                                    className="icon-button"
                                                    aria-label={t(
                                                        "connection.forgetAddress",
                                                        { address: url },
                                                    )}
                                                    data-tooltip={t(
                                                        "connection.forgetAddress",
                                                        { address: url },
                                                    )}
                                                    onClick={() =>
                                                        remove(entry.key, url)
                                                    }
                                                >
                                                    <X size={14} />
                                                </button>
                                            </li>
                                        ),
                                    )}
                                </ul>
                            </details>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
}

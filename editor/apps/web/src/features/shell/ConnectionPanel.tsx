import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    CheckCircle2,
    CircleAlert,
    Plug,
    Unplug,
    RefreshCw,
} from "lucide-react";
import { useConnectionStore } from "../../state/connection.js";
import { ConnectionHistory } from "./ConnectionHistory.js";

export function ConnectionPanel({
    onDisconnect,
}: {
    onDisconnect: () => void;
}) {
    const { t } = useTranslation();
    const connection = useConnectionStore();
    const formRef = useRef<HTMLFormElement>(null);
    const [url, setUrl] = useState(() => {
        try {
            return (
                connection.address ??
                localStorage.getItem("itemerness.api-url") ??
                ""
            );
        } catch {
            return "";
        }
    });
    const [token, setToken] = useState("");
    const [expectedServerId, setExpectedServerId] = useState<string>();
    const busy = connection.status === "connecting";
    const connected =
        connection.client !== null || connection.status === "connected";

    useEffect(() => {
        if (busy || connected) setToken("");
        // Disabled/replaced fields must not leave focus on the document body after a transition.
        const focus = formRef.current?.querySelector<HTMLElement>(
            busy || connected
                ? '[data-testid="disconnect-plugin"]'
                : "#plugin-api-url",
        );
        focus?.focus();
    }, [busy, connected]);

    return (
        <form
            className="connection-panel"
            noValidate
            ref={formRef}
            onSubmit={(event) => {
                event.preventDefault();
                if (connected || busy) return;
                void connection.connect(url, token, expectedServerId);
            }}
        >
            <label htmlFor="plugin-api-url">{t("connection.address")}</label>
            <input
                id="plugin-api-url"
                data-testid="plugin-api-url"
                type="url"
                required
                placeholder="http://192.168.1.10:18087"
                value={url}
                disabled={busy || connected}
                onChange={(event) => {
                    setUrl(event.target.value);
                    setExpectedServerId(undefined);
                }}
                spellCheck={false}
            />
            {/^http:\/\//i.test(url.trim()) && (
                <p
                    className="connection-transport-warning"
                    data-testid="connection-transport-warning"
                >
                    <CircleAlert size={15} aria-hidden="true" />
                    {t("connection.unencrypted")}
                </p>
            )}
            {!connected && (
                <>
                    <label htmlFor="plugin-api-token">
                        {t("connection.token")}
                    </label>
                    <input
                        id="plugin-api-token"
                        data-testid="plugin-api-token"
                        type="password"
                        minLength={32}
                        maxLength={256}
                        value={token}
                        disabled={busy}
                        onChange={(event) => setToken(event.target.value)}
                        autoComplete="off"
                    />
                </>
            )}
            <div className="connection-actions">
                {connection.recovery !== "none" &&
                    connection.recovery !== "blocked" && (
                        <button
                            type="button"
                            data-testid="retry-connection"
                            onClick={connection.retry}
                        >
                            <RefreshCw size={15} />
                            {t("connection.retry")}
                        </button>
                    )}
                {!connected && !busy && (
                    <button type="submit" data-testid="connect-plugin">
                        <Plug size={15} />
                        {t("connection.connect")}
                    </button>
                )}
                {(connected || busy) && (
                    <button
                        type="button"
                        data-testid="disconnect-plugin"
                        onClick={() => {
                            onDisconnect();
                            setToken("");
                        }}
                    >
                        <Unplug size={15} />
                        {t(
                            busy
                                ? "connection.cancel"
                                : "connection.disconnect",
                        )}
                    </button>
                )}
                <span role="status" data-testid="connection-status">
                    {t(`connection.${connection.status}`)}
                </span>
            </div>
            {connection.recovery === "waiting" && (
                <p className="muted connection-retry-status" role="status">
                    {t("connection.retryScheduled", {
                        count: connection.attempts,
                    })}
                </p>
            )}
            {connection.info && (
                <>
                    <dl className="connection-meta">
                        <dt>{t("connection.server")}</dt>
                        <dd>{connection.info.serverId}</dd>
                        <dt>{t("connection.platform")}</dt>
                        <dd>
                            {connection.info.platform}{" "}
                            {connection.info.minecraftVersion}
                        </dd>
                        <dt>{t("connection.pluginVersion")}</dt>
                        <dd>{connection.info.pluginVersion}</dd>
                        <dt>{t("connection.apiVersion")}</dt>
                        <dd data-testid="connection-protocol">
                            {connection.protocol}
                        </dd>
                        <dt>{t("connection.authentication")}</dt>
                        <dd
                            data-testid="connection-authentication"
                            className={
                                connection.info.authentication === "none"
                                    ? "connection-auth-warning"
                                    : undefined
                            }
                        >
                            {t(
                                connection.info.authentication === "none"
                                    ? "connection.noAuthentication"
                                    : "connection.bearerAuthentication",
                            )}
                        </dd>
                    </dl>
                    <div
                        className="connection-capability"
                        data-available={connection.info.capabilities.includes(
                            "preview.compile",
                        )}
                    >
                        {connection.info.capabilities.includes(
                            "preview.compile",
                        ) ? (
                            <CheckCircle2 size={15} />
                        ) : (
                            <CircleAlert size={15} />
                        )}
                        <span>
                            {t(
                                connection.info.capabilities.includes(
                                    "preview.compile",
                                )
                                    ? "connection.previewAvailable"
                                    : "connection.previewUnavailable",
                            )}
                        </span>
                    </div>
                </>
            )}
            {connection.error && (
                <p
                    className="connection-error"
                    role="alert"
                    data-testid="connection-error"
                >
                    {t(`connection.errors.${connection.error}`, {
                        defaultValue: t("connection.errors.CONNECTION_FAILED"),
                    })}
                </p>
            )}
            {!connected && !busy && (
                <ConnectionHistory
                    onSelect={(address, serverId) => {
                        setUrl(address);
                        setToken("");
                        setExpectedServerId(serverId);
                        formRef.current
                            ?.querySelector<HTMLInputElement>(
                                "#plugin-api-token",
                            )
                            ?.focus();
                    }}
                />
            )}
        </form>
    );
}

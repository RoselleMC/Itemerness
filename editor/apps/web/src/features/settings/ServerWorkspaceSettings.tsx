import { Copy, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConnectionStore } from "../../state/connection.js";
import {
    useServerWorkspaceState,
    updateWorkspaceSettings,
    forgetServerWorkspace,
} from "../../state/serverWorkspace.js";
import { confirmAction } from "../../state/interface.js";
import { BufferedInput } from "../common/BufferedInput.js";
import { copyAction } from "../common/contextActions.js";
import {
    saveServerAlias,
    useServerAliasState,
} from "../../state/serverAlias.js";
import { RefreshCw } from "lucide-react";

export function ServerWorkspaceSettings({
    scope = "local",
}: {
    scope?: "local" | "remote";
}) {
    const { t } = useTranslation("serverWorkspace");
    const info = useConnectionStore((s) => s.info);
    const client = useConnectionStore((s) => s.client);
    const aliasState = useServerAliasState();
    const aliasBusy = aliasState.client === client && aliasState.busy;
    const aliasError = aliasState.client === client ? aliasState.error : null;
    const profile = useServerWorkspaceState();
    if (!info) return null;
    const active =
        profile.serverId === info.serverId && profile.status !== "idle";
    const disabled = !active || profile.status === "loading";
    return (
        <section
            className="settings-section"
            data-testid={
                scope === "local"
                    ? "server-workspace-settings"
                    : "server-identity-settings"
            }
        >
            <div className="settings-row">
                <h3>{t(scope === "local" ? "heading" : "identityHeading")}</h3>
                {scope === "local" && (
                    <button
                        type="button"
                        className="icon-button"
                        disabled={disabled}
                        aria-label={t("reset")}
                        data-tooltip={t("reset")}
                        onClick={async () => {
                            if (
                                await confirmAction({
                                    title: t("resetHeading"),
                                    message: t("resetBody"),
                                    accept: t("reset"),
                                })
                            )
                                await forgetServerWorkspace(
                                    info.serverId,
                                    profile.epoch,
                                );
                        }}
                    >
                        <RotateCcw size={15} />
                    </button>
                )}
            </div>
            {scope === "remote" && (
                <>
                    <div className="settings-row">
                        <span>{t("identity")}</span>
                        <div className="server-identity">
                            <code data-testid="server-identity">
                                {info.serverId}
                            </code>
                            <button
                                className="icon-button"
                                type="button"
                                aria-label={t("copyIdentity")}
                                data-tooltip={t("copyIdentity")}
                                onClick={() =>
                                    void copyAction(
                                        "copy-server-id",
                                        t("copyIdentity"),
                                        info.serverId,
                                    ).run?.()
                                }
                            >
                                <Copy size={15} />
                            </button>
                        </div>
                    </div>
                    <div className="settings-row">
                        <span>{t("alias")}</span>
                        <BufferedInput
                            owner={`server:${info.serverId}`}
                            testId="server-alias"
                            label={t("alias")}
                            value={info.serverAlias ?? ""}
                            disabled={
                                !info.capabilities.includes(
                                    "server.alias.write",
                                )
                            }
                            readOnly={aliasBusy}
                            validate={(raw) =>
                                raw.length <= 80 &&
                                !/[\u0000-\u001f\u007f-\u009f]/.test(raw)
                                    ? null
                                    : t("aliasInvalid")
                            }
                            onCommit={(alias) =>
                                void saveServerAlias(alias.trim())
                            }
                        />
                    </div>
                    {aliasBusy && (
                        <p role="status" className="muted">
                            {t("aliasSaving")}
                        </p>
                    )}
                    {aliasError && (
                        <div className="server-alias-error" role="alert">
                            <span className="error">
                                {t(aliasError)}
                                {aliasError === "aliasConflict" && (
                                    <>
                                        <br />
                                        {t("aliasCurrent", {
                                            alias:
                                                info.serverAlias ||
                                                info.serverName ||
                                                info.serverId,
                                        })}
                                    </>
                                )}
                            </span>
                            <button
                                type="button"
                                className="icon-button"
                                aria-label={t("retryAlias")}
                                data-tooltip={t("retryAlias")}
                                disabled={aliasBusy}
                                onClick={() =>
                                    void saveServerAlias(aliasState.attempted)
                                }
                            >
                                <RefreshCw size={15} />
                            </button>
                        </div>
                    )}
                </>
            )}
            {scope === "local" && (
                <>
                    <label className="settings-row">
                        <span>{t("remember")}</span>
                        <input
                            type="checkbox"
                            role="switch"
                            data-testid="remember-server-workspace"
                            disabled={disabled}
                            checked={active && profile.settings.remember}
                            onChange={(event) =>
                                updateWorkspaceSettings({
                                    remember: event.target.checked,
                                })
                            }
                        />
                    </label>
                    <div className="settings-row" role="status">
                        <span>{t("storage")}</span>
                        <span
                            className={
                                profile.status === "error" ? "error" : "muted"
                            }
                        >
                            {t(
                                !active
                                    ? "temporary"
                                    : profile.status === "loading"
                                      ? "loading"
                                      : profile.status === "saving"
                                        ? "saving"
                                        : profile.status === "error"
                                          ? "storageFailed"
                                          : profile.settings.remember
                                            ? "saved"
                                            : "notRemembered",
                            )}
                        </span>
                    </div>
                </>
            )}
        </section>
    );
}

import { create } from "zustand";
import i18next from "i18next";
import { useConnectionStore } from "./connection.js";
import { notify } from "./toasts.js";
import type { PluginClient } from "../api/client.js";

export const useServerAliasState = create<{
    client: PluginClient | null;
    busy: boolean;
    error: string | null;
    attempted: string;
}>(() => ({ client: null, busy: false, error: null, attempted: "" }));
let pending = Promise.resolve();
export async function flushServerAlias() {
    await pending;
}
export async function saveServerAlias(alias: string) {
    const { client, info } = useConnectionStore.getState();
    if (
        !client ||
        !info ||
        (useServerAliasState.getState().client === client &&
            useServerAliasState.getState().busy)
    )
        return;
    const expectedAlias = info.serverAlias ?? "";
    if (alias === expectedAlias) {
        useServerAliasState.setState({ client, error: null });
        return;
    }
    const current = () => useConnectionStore.getState().client === client;
    useServerAliasState.setState({
        client,
        busy: true,
        error: null,
        attempted: alias,
    });
    pending = client
        .saveServerAlias(alias, expectedAlias)
        .then((serverAlias) => {
            if (!current()) return;
            useConnectionStore.setState((s) => ({
                info: s.info && { ...s.info, serverAlias },
            }));
            notify(
                String(i18next.t("serverWorkspace:aliasSaved")),
                "success",
                "server-alias",
            );
        })
        .catch((error) => {
            if (!current()) return;
            const key =
                error instanceof Error &&
                error.message === "SERVER_ALIAS_CONFLICT"
                    ? "aliasConflict"
                    : "aliasFailed";
            useServerAliasState.setState({ error: key });
            notify(
                String(i18next.t(`serverWorkspace:${key}`)),
                "error",
                "server-alias",
            );
        })
        .finally(() => {
            if (useServerAliasState.getState().client === client)
                useServerAliasState.setState({ busy: false });
        });
    await pending;
}

import { create } from "zustand";
import type { Handshake } from "@itemerness/protocol";
import { PluginClient } from "../api/client.js";
import { useEditorStore } from "./store.js";
import { usePreferences } from "./preferences.js";
import { useConnectionHistory } from "./connectionHistory.js";

interface ConnectionState {
    status: "offline" | "connecting" | "connected" | "reconnecting" | "error";
    client: PluginClient | null;
    info: Handshake | null;
    protocol: string | null;
    error: string | null;
    address: string | null;
    recovery: "none" | "waiting" | "retrying" | "manual" | "blocked";
    attempts: number;
    retryAt: number | null;
    retryRequest: number;
    connect(
        url: string,
        token: string,
        expectedServerId?: string,
    ): Promise<void>;
    interrupted(client: PluginClient, error: unknown): void;
    restored(client: PluginClient): void;
    retry(): void;
    disconnect(): void;
}

let generation = 0;
let pending: PluginClient | null = null;

export const useConnectionStore = create<ConnectionState>((set, get) => ({
    status: "offline",
    client: null,
    info: null,
    protocol: null,
    error: null,
    address: null,
    recovery: "none",
    attempts: 0,
    retryAt: null,
    retryRequest: 0,
    async connect(url, token, expectedServerId) {
        get().disconnect();
        const attempt = ++generation;
        set({ status: "connecting", address: null });
        let candidate: PluginClient | null = null;
        try {
            candidate = new PluginClient(url, token);
            set({ address: candidate.baseUrl });
            pending = candidate;
            const negotiated = await candidate.handshake();
            if (
                expectedServerId &&
                negotiated.info.serverId !== expectedServerId
            )
                throw new Error("SERVER_IDENTITY_CHANGED");
            if (attempt !== generation) {
                candidate.close();
                return;
            }
            set({
                client: candidate,
                status: "connected",
                ...negotiated,
                error: null,
            });
            useConnectionHistory
                .getState()
                .remember(negotiated.info, candidate.baseUrl);
            // Remember only an address whose API handshake succeeded, even if the popup was closed.
            try {
                localStorage.setItem("itemerness.api-url", candidate.baseUrl);
            } catch {
                /* Optional history. */
            }
        } catch (error) {
            candidate?.close();
            if (attempt === generation)
                set({
                    status: "error",
                    error:
                        error instanceof Error
                            ? error.message
                            : typeof error === "string"
                              ? error
                              : "CONNECTION_FAILED",
                });
        } finally {
            if (attempt === generation) pending = null;
        }
    },
    interrupted(client, error) {
        if (get().client !== client) return;
        client.suspendWrites(true);
        const message =
            error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : "CONNECTION_FAILED";
        const blocked = message === "SERVER_IDENTITY_CHANGED";
        const manual = usePreferences.getState().reconnectMode === "manual";
        const attempts = get().attempts + 1;
        set({
            status: blocked || manual ? "error" : "reconnecting",
            recovery: blocked ? "blocked" : manual ? "manual" : "waiting",
            error: message,
            attempts,
            retryAt:
                blocked || manual
                    ? null
                    : Date.now() +
                      Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)),
        });
    },
    restored(client) {
        if (get().client !== client) return;
        const recovered = get().recovery !== "none";
        client.suspendWrites(false);
        set({
            status: "connected",
            recovery: "none",
            error: null,
            attempts: 0,
            retryAt: null,
        });
        const info = get().info;
        const known = useConnectionHistory
            .getState()
            .entries.find((entry) => entry.serverId === info?.serverId);
        if (
            info &&
            (recovered ||
                known?.name !==
                    (info.serverAlias || info.serverName || info.serverId))
        )
            useConnectionHistory.getState().remember(info, client.baseUrl);
    },
    retry() {
        if (!get().client || get().recovery === "blocked") return;
        set({
            status: "reconnecting",
            recovery: "retrying",
            retryAt: null,
            retryRequest: get().retryRequest + 1,
        });
    },
    disconnect() {
        generation += 1;
        pending?.close();
        pending = null;
        get().client?.close();
        set({
            client: null,
            info: null,
            protocol: null,
            status: "offline",
            error: null,
            recovery: "none",
            attempts: 0,
            retryAt: null,
        });
        useEditorStore.getState().resetDraft();
    },
}));

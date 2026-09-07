import { create } from "zustand";
import type { Handshake } from "@itemerness/protocol";
import { PluginClient } from "../api/client.js";
import { useEditorStore } from "./store.js";

interface ConnectionState {
    status: "offline" | "connecting" | "connected" | "error";
    client: PluginClient | null;
    info: Handshake | null;
    protocol: string | null;
    error: string | null;
    address: string | null;
    connect(url: string, token: string): Promise<void>;
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
    async connect(url, token) {
        get().disconnect();
        const attempt = ++generation;
        set({ status: "connecting", address: null });
        let candidate: PluginClient | null = null;
        try {
            candidate = new PluginClient(url, token);
            set({ address: candidate.baseUrl });
            pending = candidate;
            const negotiated = await candidate.handshake();
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
        });
        useEditorStore.getState().resetDraft();
    },
}));

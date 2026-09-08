import { create } from "zustand";
import type { Handshake } from "@itemerness/protocol";
import { normalizeApiUrl } from "../api/client.js";

const KEY = "itemerness.connection-history.v1";
export interface ConnectionHistoryEntry {
    key: string;
    serverId: string;
    name: string;
    platform: string;
    persistent: boolean;
    addresses: { url: string; lastUsedAt: number }[];
}
function readHistory(): ConnectionHistoryEntry[] {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw || raw.length > 128 * 1024) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.slice(0, 20).flatMap((entry) => {
            if (
                !entry ||
                typeof entry.serverId !== "string" ||
                entry.serverId.length > 128 ||
                typeof entry.name !== "string" ||
                entry.name.length > 128 ||
                typeof entry.platform !== "string" ||
                entry.platform.length > 80 ||
                !Array.isArray(entry.addresses)
            )
                return [];
            const addresses = entry.addresses
                .slice(0, 5)
                .flatMap((address: unknown) => {
                    if (!address || typeof address !== "object") return [];
                    const { url, lastUsedAt } = address as Record<
                        string,
                        unknown
                    >;
                    if (
                        typeof url !== "string" ||
                        url.length > 2048 ||
                        typeof lastUsedAt !== "number" ||
                        !Number.isSafeInteger(lastUsedAt) ||
                        lastUsedAt < 0 ||
                        lastUsedAt > 8_640_000_000_000_000
                    )
                        return [];
                    try {
                        return [{ url: normalizeApiUrl(url), lastUsedAt }];
                    } catch {
                        return [];
                    }
                });
            if (!addresses.length) return [];
            const persistent = entry.persistent === true;
            return [
                {
                    serverId: entry.serverId,
                    name: entry.name,
                    platform: entry.platform,
                    persistent,
                    addresses,
                    key: persistent
                        ? entry.serverId
                        : `endpoint:${addresses[0]!.url}`,
                },
            ];
        });
    } catch {
        return [];
    }
}
function persist(entries: ConnectionHistoryEntry[]) {
    try {
        localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
        /* History is optional. */
    }
}
export const useConnectionHistory = create<{
    entries: ConnectionHistoryEntry[];
    remember(info: Handshake, url: string): void;
    remove(key: string, url?: string): void;
}>((set, get) => ({
    entries: readHistory(),
    remember(info, address) {
        const url = normalizeApiUrl(address);
        const persistent = info.capabilities.includes(
            "server.identity.persistent",
        );
        const key = persistent ? info.serverId : `endpoint:${url}`;
        const previous = get().entries.find((entry) => entry.key === key);
        const entry: ConnectionHistoryEntry = {
            key,
            serverId: info.serverId,
            persistent,
            name: info.serverAlias || info.serverName || info.serverId,
            platform: info.platform,
            addresses: [
                { url, lastUsedAt: Date.now() },
                ...(previous?.addresses ?? []).filter(
                    (item) => item.url !== url,
                ),
            ].slice(0, 5),
        };
        // A reused address belongs only to its most recently validated installation.
        const rest = get()
            .entries.filter((item) => item.key !== key)
            .map((item) => ({
                ...item,
                addresses: item.addresses.filter(
                    (address) => address.url !== url,
                ),
            }))
            .filter((item) => item.addresses.length);
        const entries = [entry, ...rest].slice(0, 20);
        set({ entries });
        persist(entries);
    },
    remove(key, url) {
        const removed = get()
            .entries.find((entry) => entry.key === key)
            ?.addresses.filter((address) => !url || address.url === url);
        const entries = get().entries.flatMap((entry) => {
            if (entry.key !== key) return [entry];
            if (!url) return [];
            const addresses = entry.addresses.filter(
                (address) => address.url !== url,
            );
            return addresses.length ? [{ ...entry, addresses }] : [];
        });
        set({ entries });
        persist(entries);
        try {
            const lastUrl = localStorage.getItem("itemerness.api-url");
            if (removed?.some((address) => address.url === lastUrl))
                localStorage.removeItem("itemerness.api-url");
        } catch {
            /* History is optional. */
        }
    },
}));

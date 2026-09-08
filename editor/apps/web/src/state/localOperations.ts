import { create } from "zustand";
import {
    configurationValue,
    decodeLocalConfiguration,
    editLocalConfiguration,
    parseLocalConfiguration,
    type ConfigurationPath,
    type LocalConfiguration,
} from "../features/settings/localConfiguration.js";
import { saveLocalExport } from "../features/settings/saveLocalExport.js";

interface LocalSession {
    id: number;
    configuration: LocalConfiguration;
    savedText: string;
    past: string[];
    future: string[];
    lastEdit: { key: string; at: number } | null;
}
interface LocalOperationsState {
    session: LocalSession | null;
    dirty: boolean;
    busy: boolean;
    error: string | null;
    open(name: string, bytes: Uint8Array): boolean;
    edit(
        path: ConfigurationPath,
        value: unknown,
        options?: { remove?: boolean; discrete?: boolean },
    ): void;
    undo(): void;
    redo(): void;
    discard(): void;
    exportCurrent(): Promise<boolean>;
    clearError(): void;
}
let nextSession = 0;
function bounded(entries: string[]): string[] {
    let bytes = 0;
    let start = entries.length;
    while (start > 0 && entries.length - start < 100) {
        const size = entries[start - 1]!.length * 2;
        if (bytes + size > 32 * 1024 * 1024) break;
        bytes += size;
        start--;
    }
    return entries.slice(start);
}

// This store intentionally has no persistence, document, connection or autosave integration.
export const useLocalOperationsStore = create<LocalOperationsState>(
    (set, get) => ({
        session: null,
        dirty: false,
        busy: false,
        error: null,
        open(name, bytes) {
            if (get().busy) return false;
            try {
                const configuration = decodeLocalConfiguration(name, bytes);
                set({
                    session: {
                        id: ++nextSession,
                        configuration,
                        savedText: configuration.text,
                        past: [],
                        future: [],
                        lastEdit: null,
                    },
                    dirty: false,
                    error: null,
                });
                return true;
            } catch (error) {
                set({
                    error:
                        error instanceof Error &&
                        ["FILE_SIZE_INVALID", "FILE_ENCODING_INVALID"].includes(
                            error.message,
                        )
                            ? error.message
                            : "FILE_READ_FAILED",
                });
                return false;
            }
        },
        edit(path, value, options = {}) {
            const session = get().session;
            if (!session) return;
            if (
                !options.remove &&
                Object.is(
                    configurationValue(session.configuration, path),
                    value,
                )
            )
                return;
            try {
                const configuration = editLocalConfiguration(
                    session.configuration,
                    path,
                    value,
                    options.remove,
                );
                if (configuration.text === session.configuration.text) return;
                const key = JSON.stringify(path);
                const now = Date.now();
                const merge =
                    !options.discrete &&
                    session.lastEdit?.key === key &&
                    now - session.lastEdit.at < 750;
                const past = merge
                    ? session.past
                    : bounded([...session.past, session.configuration.text]);
                set({
                    session: {
                        ...session,
                        configuration,
                        past,
                        future: [],
                        lastEdit: options.discrete ? null : { key, at: now },
                    },
                    dirty: configuration.text !== session.savedText,
                    error: null,
                });
            } catch {
                set({ error: "FIELD_EDIT_FAILED" });
            }
        },
        undo() {
            const session = get().session;
            const text = session?.past.at(-1);
            if (!session || text === undefined) return;
            const configuration = parseLocalConfiguration(
                session.configuration.name,
                text,
                session.configuration.kind,
            );
            set({
                session: {
                    ...session,
                    configuration,
                    past: session.past.slice(0, -1),
                    future: bounded([
                        ...session.future,
                        session.configuration.text,
                    ]),
                    lastEdit: null,
                },
                dirty: text !== session.savedText,
                error: null,
            });
        },
        redo() {
            const session = get().session;
            const text = session?.future.at(-1);
            if (!session || text === undefined) return;
            const configuration = parseLocalConfiguration(
                session.configuration.name,
                text,
                session.configuration.kind,
            );
            set({
                session: {
                    ...session,
                    configuration,
                    past: bounded([
                        ...session.past,
                        session.configuration.text,
                    ]),
                    future: session.future.slice(0, -1),
                    lastEdit: null,
                },
                dirty: text !== session.savedText,
                error: null,
            });
        },
        discard() {
            set({ session: null, dirty: false, error: null });
        },
        async exportCurrent() {
            const state = get();
            const session = state.session;
            if (
                !session ||
                state.busy ||
                session.configuration.diagnostics.some(
                    (issue) => !issue.warning,
                )
            )
                return false;
            const { text, kind } = session.configuration;
            set({ busy: true, error: null });
            try {
                const saved = await saveLocalExport(
                    kind,
                    new TextEncoder().encode(text),
                );
                const current = get().session;
                if (saved && current?.id === session.id)
                    set({
                        session: { ...current, savedText: text },
                        dirty: current.configuration.text !== text,
                    });
                return saved;
            } catch (error) {
                if (get().session?.id === session.id)
                    set({
                        error:
                            error instanceof Error &&
                            error.message === "EXPORT_SIZE_INVALID"
                                ? "EXPORT_SIZE_INVALID"
                                : "EXPORT_SAVE_FAILED",
                    });
                return false;
            } finally {
                set({ busy: false });
            }
        },
        clearError() {
            set({ error: null });
        },
    }),
);

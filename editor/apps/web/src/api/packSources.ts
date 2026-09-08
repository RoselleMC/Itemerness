import { invoke, isTauri } from "@tauri-apps/api/core";
import { zip } from "fflate";

export interface PackSource {
    id: string;
    name: string;
    path: string;
    kind: "archive" | "directory" | "snapshot";
    native: boolean;
    reloadable: boolean;
    handle?: BrowserHandle;
    requestAccess?(): Promise<void>;
    read(): Promise<Uint8Array>;
    stamp(): Promise<string>;
    watch(enabled: boolean): Promise<void>;
    release(): void;
}
export interface NativePackSelection {
    id: string;
    name: string;
    path: string;
    directory: boolean;
}
export function nativePackSource(selection: NativePackSelection): PackSource {
    return {
        ...selection,
        kind: selection.directory ? "directory" : "archive",
        native: true,
        reloadable: true,
        read: async () =>
            new Uint8Array(
                await invoke<ArrayBuffer>("read_resource_pack", {
                    id: selection.id,
                }),
            ),
        stamp: () =>
            invoke<string>("resource_pack_stamp", { id: selection.id }),
        watch: (enabled) =>
            invoke("watch_resource_pack", { id: selection.id, enabled }),
        release: () => {
            void invoke("release_resource_pack", { id: selection.id }).catch(
                () => {},
            );
        },
    };
}

interface FileHandle {
    kind: "file";
    name: string;
    getFile(): Promise<File>;
}
interface DirectoryHandle {
    kind: "directory";
    name: string;
    values(): AsyncIterable<BrowserHandle>;
}
export type BrowserHandle = (FileHandle | DirectoryHandle) & {
    requestPermission?: (options: { mode: "read" }) => Promise<string>;
};
type PickerWindow = Window & {
    showOpenFilePicker?: (options: unknown) => Promise<FileHandle[]>;
    showDirectoryPicker?: () => Promise<DirectoryHandle>;
};
const MAX_BYTES = 512 * 1024 * 1024;

async function directoryFiles(
    handle: DirectoryHandle,
    prefix = "",
    depth = 0,
    result: [string, File][] = [],
    budget = { entries: 0, bytes: 0 },
): Promise<[string, File][]> {
    if (depth > 32) throw new Error("PACK_DEPTH_LIMIT");
    for await (const child of handle.values()) {
        if (++budget.entries > 65000) throw new Error("PACK_ENTRY_LIMIT");
        const name = prefix + child.name;
        if (child.kind === "directory")
            await directoryFiles(child, name + "/", depth + 1, result, budget);
        else {
            const file = await child.getFile();
            budget.bytes += file.size;
            if (file.size > 64 * 1024 * 1024 || budget.bytes > MAX_BYTES)
                throw new Error("PACK_SIZE_LIMIT");
            result.push([name, file]);
        }
    }
    return result;
}
async function archiveFiles(files: [string, File][]): Promise<Uint8Array> {
    if (files.length > 65000 || !files.some(([name]) => name === "pack.mcmeta"))
        throw new Error("PACK_METADATA_MISSING");
    if (
        files.some(([, file]) => file.size > 64 * 1024 * 1024) ||
        files.reduce((total, [, file]) => total + file.size, 0) > MAX_BYTES
    )
        throw new Error("PACK_SIZE_LIMIT");
    const entries: Record<string, [Uint8Array, { mtime: Date }]> =
        Object.create(null);
    for (const [name, file] of files)
        entries[name] = [
            new Uint8Array(await file.arrayBuffer()),
            { mtime: new Date("1980-01-01T00:00:00") },
        ];
    return new Promise((resolve, reject) =>
        zip(entries, { level: 0 }, (error, bytes) =>
            error ? reject(error) : resolve(bytes),
        ),
    );
}
export function browserHandleSource(handle: BrowserHandle): PackSource {
    return {
        handle,
        requestAccess: async () => {
            if (
                handle.requestPermission &&
                (await handle.requestPermission({ mode: "read" })) !== "granted"
            )
                throw new Error("PACK_PERMISSION_REQUIRED");
        },
        id: crypto.randomUUID(),
        name: handle.name,
        path: handle.name,
        kind: handle.kind === "directory" ? "directory" : "archive",
        native: false,
        reloadable: true,
        read: async () =>
            handle.kind === "directory"
                ? archiveFiles(await directoryFiles(handle))
                : fileBytes(await handle.getFile()),
        stamp: async () => {
            const files =
                handle.kind === "directory"
                    ? await directoryFiles(handle)
                    : ([[handle.name, await handle.getFile()]] as [
                          string,
                          File,
                      ][]);
            return JSON.stringify(
                files
                    .map(([name, file]) => [name, file.size, file.lastModified])
                    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
            );
        },
        watch: async () => {},
        release: () => {},
    };
}
async function fileBytes(file: File) {
    if (file.size > MAX_BYTES) throw new Error("PACK_SIZE_LIMIT");
    return new Uint8Array(await file.arrayBuffer());
}
export function browserFileSource(file: File): PackSource {
    return {
        id: crypto.randomUUID(),
        name: file.name,
        path: file.name,
        kind: "snapshot",
        native: false,
        reloadable: false,
        read: () => fileBytes(file),
        stamp: async () => `${file.size}:${file.lastModified}`,
        watch: async () => {},
        release: () => {},
    };
}
export function browserDirectorySource(files: File[]): PackSource {
    const root = files[0]?.webkitRelativePath.split("/")[0] ?? "Resource pack";
    return {
        id: crypto.randomUUID(),
        name: root,
        path: root,
        kind: "snapshot",
        native: false,
        reloadable: false,
        read: () =>
            archiveFiles(
                files.map((file) => [
                    file.webkitRelativePath.slice(root.length + 1),
                    file,
                ]),
            ),
        stamp: async () => "snapshot",
        watch: async () => {},
        release: () => {},
    };
}
export async function pickPackSources(
    directory: boolean,
): Promise<PackSource[] | null> {
    if (isTauri())
        return (
            await invoke<NativePackSelection[]>("pick_resource_packs", {
                directory,
            })
        ).map(nativePackSource);
    const picker = window as PickerWindow;
    try {
        if (directory && picker.showDirectoryPicker)
            return [browserHandleSource(await picker.showDirectoryPicker())];
        if (!directory && picker.showOpenFilePicker)
            return (
                await picker.showOpenFilePicker({
                    multiple: true,
                    types: [
                        {
                            description: "Minecraft resource pack",
                            accept: { "application/zip": [".zip", ".jar"] },
                        },
                    ],
                })
            ).map(browserHandleSource);
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
            return [];
        throw error;
    }
    return null;
}
export async function droppedPackSources(
    items: DataTransferItem[],
): Promise<PackSource[]> {
    // Request handles during the original drop event, before browser drag data is released.
    const pending = items
        .filter((item) => item.kind === "file")
        .map((item) => {
            const extended = item as DataTransferItem & {
                getAsFileSystemHandle?: () => Promise<BrowserHandle | null>;
            };
            const file = item.getAsFile();
            return extended.getAsFileSystemHandle
                ? extended
                      .getAsFileSystemHandle()
                      .then((handle) =>
                          handle
                              ? browserHandleSource(handle)
                              : file
                                ? browserFileSource(file)
                                : null,
                      )
                : Promise.resolve(file ? browserFileSource(file) : null);
        });
    return (await Promise.all(pending)).filter(
        (source): source is PackSource => source !== null,
    );
}

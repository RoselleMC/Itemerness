import { useRef, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { Upload, FolderOpen } from "lucide-react";
import { ResourceDeclarations } from "./ResourceDeclarations.js";
import { LocalAssetMounts } from "./LocalAssetMounts.js";
import { commitInlineEditor } from "../common/inlineEdit.js";
import {
    browserFileSource,
    browserDirectorySource,
    droppedPackSources,
    pickPackSources,
} from "../../api/packSources.js";
import { addPackSources } from "../../state/assetMounts.js";
import { useEditorStore } from "../../state/store.js";
import { notify } from "../../state/toasts.js";
import { describeContext } from "../../state/interface.js";
import { useServerWorkspaceState } from "../../state/serverWorkspace.js";
import "./resourceAuthoring.css";
import "./packManager.css";

export function AssetPanel() {
    const { t } = useTranslation();
    const [tab, setTab] = useState("local");
    const [dragging, setDragging] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const directoryInput = useRef<HTMLInputElement>(null);
    const epoch = useEditorStore((state) => state.workspaceEpoch);
    const restoring = useServerWorkspaceState(
        (s) => s.epoch === epoch && s.status === "loading",
    );
    const fail = (error: unknown) => {
        if (epoch !== useEditorStore.getState().workspaceEpoch) return;
        const detail = error instanceof Error ? error.message : String(error);
        useEditorStore.setState({ mountError: detail });
        notify(t("packManager:importFailed"), "error", "pack-import");
    };
    const pick = async (directory: boolean) => {
        if (restoring || !commitInlineEditor()) return;
        try {
            const sources = await pickPackSources(directory);
            if (sources) await addPackSources(sources, epoch);
            else (directory ? directoryInput : input).current?.click();
        } catch (error) {
            fail(error);
        }
    };
    return (
        <div
            className="resource-pack-page"
            data-testid="asset-dropzone"
            data-dragging={dragging}
            onDragOver={(event) => {
                if (event.dataTransfer.types.includes("Files")) {
                    event.preventDefault();
                    setDragging(true);
                }
            }}
            onDragLeave={(event) => {
                if (
                    !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                    )
                )
                    setDragging(false);
            }}
            onDrop={(event) => {
                if (isTauri() || !event.dataTransfer.types.includes("Files"))
                    return;
                event.preventDefault();
                setDragging(false);
                if (restoring || !commitInlineEditor()) return;
                void droppedPackSources([...event.dataTransfer.items])
                    .then((sources) => addPackSources(sources, epoch))
                    .catch(fail);
            }}
            onContextMenu={(event) =>
                describeContext(event, {
                    label: t("assets.heading"),
                    items: [
                        {
                            id: "import-assets",
                            label: t("assets.import"),
                            icon: Upload,
                            disabled: restoring,
                            run: () => pick(false),
                        },
                        {
                            id: "import-folder",
                            label: t("packManager:openDirectory"),
                            icon: FolderOpen,
                            disabled: restoring,
                            run: () => pick(true),
                        },
                    ],
                })
            }
        >
            <input
                ref={input}
                type="file"
                hidden
                multiple
                accept=".zip,.jar"
                data-testid="asset-file-input"
                aria-label={t("assets.import")}
                onChange={(event) => {
                    void addPackSources(
                        [...(event.target.files ?? [])].map(browserFileSource),
                        epoch,
                    ).catch(fail);
                    event.target.value = "";
                }}
            />
            <input
                ref={directoryInput}
                type="file"
                hidden
                multiple
                {...{ webkitdirectory: "" }}
                data-testid="asset-directory-input"
                aria-label={t("packManager:openDirectory")}
                onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    if (files.length)
                        void addPackSources(
                            [browserDirectorySource(files)],
                            epoch,
                        ).catch(fail);
                    event.target.value = "";
                }}
            />
            <Tabs.Root
                className="asset-page-tabs"
                value={tab}
                onValueChange={(value, event) => {
                    if (!commitInlineEditor()) {
                        event.cancel();
                        return;
                    }
                    if (value === "local" || value === "runtime") setTab(value);
                }}
            >
                <Tabs.List aria-label={t("assetAuthoring.pageTabs")}>
                    <Tabs.Tab value="local" data-testid="asset-tab-local">
                        {t("assetAuthoring.localMounts")}
                    </Tabs.Tab>
                    <Tabs.Tab value="runtime" data-testid="asset-tab-runtime">
                        {t("assetAuthoring.runtimeDeclarations")}
                    </Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel value="local" keepMounted>
                    <LocalAssetMounts
                        restoring={restoring}
                        onImport={() => void pick(false)}
                        onOpenDirectory={() => void pick(true)}
                    />
                </Tabs.Panel>
                <Tabs.Panel value="runtime" keepMounted>
                    <ResourceDeclarations />
                </Tabs.Panel>
            </Tabs.Root>
        </div>
    );
}

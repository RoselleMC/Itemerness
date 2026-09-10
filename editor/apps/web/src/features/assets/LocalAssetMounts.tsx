import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
    ArrowDown,
    ArrowUp,
    CheckCircle2,
    FileInput,
    Upload,
    FolderOpen,
    GripVertical,
    LockKeyhole,
    RefreshCw,
    Trash2,
    TriangleAlert,
    X,
} from "lucide-react";
import {
    packFormatDeclarationStatus,
    type MountedPack,
} from "@itemerness/mc-assets";
import { useEditorStore } from "../../state/store.js";
import {
    useAssetMounts,
    loadVanilla,
    reloadPackSource,
    removePackSource,
    setPackAutoReload,
    type SourceMount,
} from "../../state/assetMounts.js";
import { VANILLA_VERSIONS, isVanillaVersion } from "../../api/vanillaAssets.js";
import { describeContext } from "../../state/interface.js";
import { copyAction } from "../common/contextActions.js";
import { useDragReorder } from "../common/dragReorder.js";
import { SelectField } from "../common/SelectField.js";
import { PackFontImport } from "./PackFontImport.js";
import { PackMetadataStatus } from "./PackMetadataStatus.js";
import { MINECRAFT_RESOURCE_FORMATS } from "@itemerness/mc-assets";
import { useConnectionStore } from "../../state/connection.js";
import { PackIcon } from "./PackIcon.js";
import { PackSelfCheck } from "./PackSelfCheck.js";

import { ToggleSwitch } from "../common/ToggleSwitch.js";

export function LocalAssetMounts({
    onImport,
    onOpenDirectory,
    restoring = false,
}: {
    onImport(): void;
    onOpenDirectory(): void;
    restoring?: boolean;
}) {
    const { t } = useTranslation();
    const state = useEditorStore();
    const { sources, vanilla } = useAssetMounts();
    const serverVersion = useConnectionStore(
        (state) => state.info?.minecraftVersion,
    );
    const [importId, setImportId] = useState<string | null>(null);
    const custom = state.packs.filter((slot) => slot.pack.kind !== "vanilla");
    const base = state.packs.find((slot) => slot.pack.kind === "vanilla")?.pack;
    const missing = sources.filter((mount) => !mount.packId);
    const drag = useDragReorder(
        custom.length,
        state.movePackTo,
        t("assets.priority"),
    );
    const importPack = custom.find((slot) => slot.pack.id === importId)?.pack;
    return (
        <section
            className="assets pack-manager"
            aria-label={t("assets.heading")}
        >
            <div
                className="pack-list-heading"
                data-testid="mounted-pack-heading"
            >
                <h3>{t("assets.mounted")}</h3>
                <span>{custom.length}</span>
                <div className="pack-page-actions">
                    <button
                        type="button"
                        disabled={restoring}
                        className="icon-button"
                        aria-label={t("assets.import")}
                        data-tooltip={t("assets.import")}
                        onClick={onImport}
                    >
                        <Upload size={18} />
                    </button>
                    <button
                        type="button"
                        disabled={restoring}
                        className="icon-button"
                        aria-label={t("packManager:openDirectory")}
                        data-tooltip={t("packManager:openDirectory")}
                        onClick={onOpenDirectory}
                    >
                        <FolderOpen size={18} />
                    </button>
                </div>
            </div>
            {state.mountError && (
                <div
                    className="pack-page-error"
                    role="alert"
                    data-testid="mount-error"
                >
                    <span>{state.mountError}</span>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label={t("common.close")}
                        onClick={() =>
                            useEditorStore.setState({ mountError: null })
                        }
                    >
                        <X size={15} />
                    </button>
                </div>
            )}
            {!custom.length && !missing.length && (
                <p className="pack-empty" data-testid="assets-empty">
                    {t("packManager:empty")}
                </p>
            )}
            <ol className="pack-list" data-testid="pack-list">
                {custom.map((slot, index) => {
                    const mount = sources.find(
                        (source) => source.packId === slot.pack.id,
                    );
                    const remove = () =>
                        mount
                            ? removePackSource(mount.source.id)
                            : state.removePack(slot.pack.id);
                    return (
                        <li
                            key={mount?.source.id ?? slot.pack.id}
                            className="pack-row"
                            {...drag.itemProps(index)}
                            tabIndex={0}
                            data-testid={`pack-${index}`}
                            onContextMenu={(event) =>
                                describeContext(event, {
                                    label: slot.pack.name,
                                    items: [
                                        {
                                            id: "reload-pack",
                                            label: t("packManager:reload"),
                                            icon: RefreshCw,
                                            disabled:
                                                !mount?.source.reloadable ||
                                                mount.status === "loading",
                                            run: () =>
                                                mount &&
                                                reloadPackSource(
                                                    mount.source.id,
                                                ),
                                        },
                                        {
                                            id: "watch-pack",
                                            label: t("packManager:autoReload"),
                                            checked: mount?.autoReload ?? false,
                                            disabled: !mount?.source.reloadable,
                                            run: () =>
                                                mount &&
                                                setPackAutoReload(
                                                    mount.source.id,
                                                    !mount.autoReload,
                                                ),
                                        },
                                        {
                                            id: "import-pack-font",
                                            label: t("packFontImport.heading"),
                                            icon: FileInput,
                                            run: () =>
                                                setImportId(slot.pack.id),
                                        },
                                        {
                                            id: "pack-up",
                                            label: t("menus.raisePriority"),
                                            icon: ArrowUp,
                                            disabled: index === 0,
                                            run: () =>
                                                state.movePack(
                                                    slot.pack.id,
                                                    -1,
                                                ),
                                        },
                                        {
                                            id: "pack-down",
                                            label: t("menus.lowerPriority"),
                                            icon: ArrowDown,
                                            disabled:
                                                index === custom.length - 1,
                                            run: () =>
                                                state.movePack(slot.pack.id, 1),
                                        },
                                        copyAction(
                                            "copy-pack-path",
                                            t("packManager:copyPath"),
                                            mount?.source.path ??
                                                slot.pack.name,
                                        ),
                                        {
                                            id: "remove-pack",
                                            label: t("assets.remove"),
                                            icon: Trash2,
                                            separator: true,
                                            run: remove,
                                        },
                                    ],
                                })
                            }
                        >
                            <span {...drag.handleProps(index)}>
                                <GripVertical size={16} />
                            </span>
                            <PackIcon pack={slot.pack} />
                            <PackDetails pack={slot.pack} mount={mount} />
                            <div className="pack-row-controls">
                                <div
                                    className="pack-watch"
                                    data-tooltip={
                                        !mount?.source.reloadable
                                            ? t("packManager:snapshotNotice")
                                            : undefined
                                    }
                                >
                                    <ToggleSwitch
                                        label={t("packManager:autoReload")}
                                        checked={mount?.autoReload ?? false}
                                        disabled={!mount?.source.reloadable}
                                        onCheckedChange={(checked) =>
                                            mount &&
                                            setPackAutoReload(
                                                mount.source.id,
                                                checked,
                                            )
                                        }
                                    />
                                    <span>{t("packManager:autoReload")}</span>
                                </div>
                                <div className="pack-actions">
                                    <button
                                        type="button"
                                        className="icon-button"
                                        aria-label={t("packManager:reload")}
                                        data-tooltip={t(
                                            mount?.source.reloadable
                                                ? "packManager:reload"
                                                : "packManager:snapshotNotice",
                                        )}
                                        disabled={
                                            !mount?.source.reloadable ||
                                            mount.status === "loading"
                                        }
                                        onClick={() =>
                                            mount &&
                                            void reloadPackSource(
                                                mount.source.id,
                                            )
                                        }
                                    >
                                        <RefreshCw
                                            size={16}
                                            className={
                                                mount?.status === "loading"
                                                    ? "pack-spinning"
                                                    : ""
                                            }
                                        />
                                    </button>
                                    <button
                                        type="button"
                                        className="icon-button"
                                        aria-label={t("packFontImport.heading")}
                                        data-tooltip={t(
                                            "packFontImport.heading",
                                        )}
                                        data-testid={`import-pack-font-${index}`}
                                        onClick={() =>
                                            setImportId(slot.pack.id)
                                        }
                                    >
                                        <FileInput size={16} />
                                    </button>
                                    <button
                                        type="button"
                                        className="icon-button"
                                        aria-label={t("assets.remove")}
                                        data-tooltip={t("assets.remove")}
                                        onClick={remove}
                                    >
                                        <X size={16} />
                                    </button>
                                </div>
                            </div>
                        </li>
                    );
                })}
                {missing.map((mount) => (
                    <li
                        className="pack-row pack-row-pending"
                        key={mount.source.id}
                    >
                        <span />
                        <PackIcon />
                        <PackDetails mount={mount} />
                        <div className="pack-row-controls">
                            <div className="pack-watch">
                                <ToggleSwitch
                                    label={t("packManager:autoReload")}
                                    checked={mount.autoReload}
                                    disabled={!mount.source.reloadable}
                                    onCheckedChange={(checked) =>
                                        setPackAutoReload(
                                            mount.source.id,
                                            checked,
                                        )
                                    }
                                />
                                <span>{t("packManager:autoReload")}</span>
                            </div>
                            <div className="pack-actions">
                                <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t("packManager:reload")}
                                    data-tooltip={t("packManager:reload")}
                                    disabled={mount.status === "loading"}
                                    onClick={() =>
                                        void reloadPackSource(mount.source.id)
                                    }
                                >
                                    <RefreshCw size={16} />
                                </button>
                                <button
                                    type="button"
                                    className="icon-button"
                                    aria-label={t("assets.remove")}
                                    data-tooltip={t("assets.remove")}
                                    onClick={() =>
                                        removePackSource(mount.source.id)
                                    }
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        </div>
                    </li>
                ))}
                <li
                    className="pack-row vanilla-pack-row"
                    data-testid="vanilla-pack"
                    data-status={vanilla.status}
                >
                    <span
                        className="pack-lock"
                        data-tooltip={t("packManager:basePriority")}
                    >
                        <LockKeyhole size={14} />
                    </span>
                    <PackIcon pack={base} />
                    <div className="pack-details">
                        <strong>{t("packManager:vanilla")}</strong>
                        <span className="pack-description">
                            {t("packManager:basePriority")}
                        </span>
                        <span
                            className="pack-status"
                            data-tone={
                                vanilla.status === "error" ? "error" : "ready"
                            }
                        >
                            {vanilla.status === "loading" ? (
                                <RefreshCw
                                    size={13}
                                    className="pack-spinning"
                                />
                            ) : vanilla.status === "error" ? (
                                <TriangleAlert size={13} />
                            ) : base ? (
                                <CheckCircle2 size={13} />
                            ) : null}
                            {t(
                                `packManager:vanillaStatus.${vanilla.status === "loading" ? vanilla.phase : vanilla.status === "ready" ? vanilla.phase : vanilla.status}`,
                            )}
                        </span>
                        {vanilla.error && (
                            <span className="pack-error">{vanilla.error}</span>
                        )}
                        {serverVersion && vanilla.version !== serverVersion && (
                            <span className="pack-warning">
                                {t("packManager:previewVersionWarning", {
                                    version: serverVersion,
                                })}
                            </span>
                        )}
                    </div>
                    <div className="vanilla-controls">
                        <SelectField
                            label={t("packManager:version")}
                            value={vanilla.version}
                            data-testid="vanilla-version"
                            options={VANILLA_VERSIONS.map((version) => ({
                                value: version,
                                label: version,
                            }))}
                            onValueChange={(version) => {
                                if (isVanillaVersion(version))
                                    void loadVanilla(version, true);
                            }}
                        />
                        <button
                            type="button"
                            className="icon-button"
                            data-testid="fetch-vanilla"
                            aria-label={t("packManager:retryVanilla")}
                            data-tooltip={t("packManager:retryVanilla")}
                            disabled={vanilla.status === "loading"}
                            onClick={() =>
                                void loadVanilla(vanilla.version, true)
                            }
                        >
                            <RefreshCw size={16} />
                        </button>
                    </div>
                </li>
            </ol>
            {importPack && (
                <PackFontImport
                    key={`${state.workspaceEpoch}:${importPack.id}`}
                    pack={importPack}
                    onClose={() => setImportId(null)}
                />
            )}
            <PackSelfCheck />
        </section>
    );
}

function PackDetails({
    pack,
    mount,
}: {
    pack?: MountedPack;
    mount?: SourceMount;
}) {
    const { t } = useTranslation();
    const version = useAssetMounts((state) => state.vanilla.version);
    const declaration = pack
        ? packFormatDeclarationStatus(
              pack.meta,
              MINECRAFT_RESOURCE_FORMATS[version],
          )
        : "unknown";
    const status = mount?.status ?? "ready";
    return (
        <div className="pack-details">
            <strong className="pack-name">
                {pack?.name ?? mount?.source.name}
            </strong>
            {pack?.meta?.description && (
                <span className="pack-description">
                    {pack.meta.description}
                </span>
            )}
            <span className="pack-path" data-tooltip={mount?.source.path}>
                {mount?.source.path ?? pack?.name}
            </span>
            <div className="pack-facts">
                <span className="pack-status" data-tone={status}>
                    {status === "loading" ? (
                        <RefreshCw size={13} className="pack-spinning" />
                    ) : status === "error" ? (
                        <TriangleAlert size={13} />
                    ) : (
                        <CheckCircle2 size={13} />
                    )}
                    {t(`packManager:status.${status}`)}
                </span>
                <span>
                    {t(
                        `packManager:source.${mount?.source.kind ?? "snapshot"}`,
                    )}
                </span>
                {pack && (
                    <span>
                        {formatPackSize(pack.byteLength)} ·{" "}
                        {t("assets.size", { count: pack.list("").length })}
                    </span>
                )}
                {mount?.loadedAt && (
                    <time dateTime={new Date(mount.loadedAt).toISOString()}>
                        {t("packManager:updated", {
                            time: new Intl.DateTimeFormat(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                            }).format(mount.loadedAt),
                        })}
                    </time>
                )}
            </div>
            {mount?.error && (
                <span className="pack-error">
                    {mount.error}
                    {mount.packId && ` · ${t("packManager:lastGood")}`}
                </span>
            )}
            {mount?.watchError && (
                <span className="pack-warning">
                    {t("packManager:watchFallback")}
                </span>
            )}
            {pack && (
                <details className="pack-compatibility">
                    <summary data-tone={declaration}>
                        {t(`packManager:format.${declaration}`)}
                    </summary>
                    <PackMetadataStatus pack={pack} />
                </details>
            )}
        </div>
    );
}
function formatPackSize(bytes: number) {
    return bytes >= 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
        : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

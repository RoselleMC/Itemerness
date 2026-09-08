import { Info, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
    MAX_PACK_FORMAT_MINOR,
    packFormatDeclarationStatus,
    type DeclaredPackFormats,
    type MountedPack,
} from "@itemerness/mc-assets";
import "./packMetadata.css";

// The pinned vanilla client's version.json, not the plugin's negotiated version.
export const PREVIEW_RESOURCE_PACK_BASELINE = {
    minecraftVersion: "26.1.2",
    format: { major: 84, minor: 0 },
} as const;

function rangeLabel(range: DeclaredPackFormats): string {
    const { minimum, maximum } = range;
    if (range.source !== "min_format/max_format") {
        return minimum.major === maximum.major
            ? String(minimum.major)
            : `${minimum.major} - ${maximum.major}`;
    }
    const first = `${minimum.major}.${minimum.minor}`;
    const last = `${maximum.major}.${maximum.minor === MAX_PACK_FORMAT_MINOR ? "*" : maximum.minor}`;
    return first === last ? first : `${first} - ${last}`;
}

export function PackMetadataStatus({ pack }: { pack: MountedPack }) {
    const { t } = useTranslation("packMetadata");
    if (pack.kind === "vanilla") return null;
    const baseline = PREVIEW_RESOURCE_PACK_BASELINE;
    const status = packFormatDeclarationStatus(pack.meta, baseline.format);
    const range = pack.meta?.declaredFormats;
    const Icon = status === "outside" ? TriangleAlert : Info;
    return (
        <div
            className="pack-metadata-status"
            data-pack-format-status={status}
            data-testid="pack-metadata-status"
        >
            <Icon size={14} aria-hidden="true" />
            <div>
                <span>
                    {t(status, {
                        range: range ? rangeLabel(range) : "",
                        version: baseline.minecraftVersion,
                        format: `${baseline.format.major}.${baseline.format.minor}`,
                    })}
                </span>
                {range && (
                    <span className="pack-metadata-source">
                        {t("source", { source: range.source })}
                    </span>
                )}
                <span className="pack-metadata-note">{t("notice")}</span>
            </div>
        </div>
    );
}

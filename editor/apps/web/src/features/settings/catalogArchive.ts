import { zipSync, strToU8 } from "fflate";
import { catalogExportSchema, type CatalogExport } from "@itemerness/protocol";
import {
    MAX_CATALOG_ARCHIVE_BYTES,
    saveLocalExport,
} from "./saveLocalExport.js";

export function catalogArchive(result: CatalogExport): Uint8Array {
    catalogExportSchema.parse(result);
    const files: Record<string, Uint8Array> = Object.create(null);
    for (const file of result.files) files[file.path] = strToU8(file.content);
    files["config.patch.yml"] = strToU8(result.settingsPatch);
    const archive = zipSync(files, { level: 6 });
    if (archive.length > MAX_CATALOG_ARCHIVE_BYTES)
        throw new Error("EXPORT_SIZE_INVALID");
    return archive;
}

export async function saveCatalogArchive(
    result: CatalogExport,
): Promise<boolean> {
    return saveLocalExport("catalog", catalogArchive(result));
}

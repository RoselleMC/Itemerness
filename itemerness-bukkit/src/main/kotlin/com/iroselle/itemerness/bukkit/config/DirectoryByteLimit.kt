package com.iroselle.itemerness.bukkit.config

import java.util.Locale

/** The per-directory YAML budget shared by the catalog, presentation and editor loaders. */
internal object DirectoryByteLimit {
    const val DEFAULT_BYTES: Long = ItemernessSettings.DEFAULT_CATALOG_DIRECTORY_MEBIBYTES * ItemernessSettings.MEBIBYTE

    /** Names both sizes and the setting, so an operator knows how far over the budget a directory is. */
    fun exceeded(kind: String, directory: Any, actualBytes: Long, limitBytes: Long): StrictYamlException =
        StrictYamlException(
            String.format(
                Locale.ROOT,
                "%s directory %s holds %,d bytes of YAML; the limit is %,d bytes (%.2f MiB, catalog.maximum-directory-mebibytes)",
                kind, directory, actualBytes, limitBytes, limitBytes / ItemernessSettings.MEBIBYTE.toDouble(),
            ),
        )
}

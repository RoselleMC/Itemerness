package com.iroselle.itemerness.editor.protocol

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.core.catalog.DataScope
import com.iroselle.itemerness.core.catalog.DataKeySource
import com.iroselle.itemerness.core.catalog.DataType
import java.util.Collections
import java.util.Locale

/** Immutable, platform-neutral authoring inputs for the runtime data-key integration policy. */
class DocumentDataKeyIntegration private constructor(
    val readAccess: ReadAccess,
    writePrincipals: Collection<String>,
    pdcFallbackKeys: Collection<ItemKey>,
    val placeholderExposed: Boolean,
    val placeholderFormatter: ItemKey?,
) {
    enum class ReadAccess { PUBLIC, OWNER_ONLY, INTERNAL }

    val writePrincipals: Set<String> = Collections.unmodifiableSet(LinkedHashSet(writePrincipals))
    val pdcFallbackKeys: List<ItemKey> = java.util.List.copyOf(pdcFallbackKeys)

    companion object {
        /** Mirrors CatalogSourceLoader's read-sources, access and placeholder-api constraints. */
        internal fun decode(node: JsonObject, key: DataKeySource): DocumentDataKeyIntegration {
            node.rejectUnknown("readSources", "access", "placeholderApi")
            val path = "data-keys.${key.id}.integration"
            val sources = node.requiredObjects("readSources")
            val primary = if (key.scope == DataScope.DEFINITION) "catalogDefinition" else "canonicalNbt"
            if (sources.isEmpty() || sources.first().requiredString("kind") != primary) {
                throw JsonException("$path.readSources must start with $primary")
            }
            val scalar = key.type !is DataType.ListType && key.type !is DataType.CompoundType
            val pdcKeys = LinkedHashSet<ItemKey>()
            sources.forEachIndexed { index, source ->
                when (val kind = source.requiredString("kind")) {
                    "catalogDefinition", "canonicalNbt" -> {
                        source.rejectUnknown("kind")
                        if (index != 0 || kind != primary) {
                            throw JsonException("$path.readSources[$index] is only valid as the primary source for its scope")
                        }
                    }
                    "pdc" -> {
                        source.rejectUnknown("kind", "key", "mode")
                        if (index == 0 || key.scope != DataScope.INSTANCE || !scalar ||
                            source.requiredString("mode") != "FALLBACK_READ_ONLY"
                        ) {
                            throw JsonException("$path.readSources[$index] must be a scalar INSTANCE fallback-read-only source")
                        }
                        val physicalKey = ItemKey.parse(source.requiredString("key"))
                        if (!pdcKeys.add(physicalKey)) throw JsonException("$path.readSources repeats PDC fallback $physicalKey")
                    }
                    else -> throw JsonException("$path.readSources[$index] has unsupported kind $kind")
                }
            }
            val access = node.requiredObject("access").rejectUnknown("read", "write")
            val read = access.requiredString("read")
            val readAccess = ReadAccess.entries.firstOrNull { it.name == read }
                ?: throw JsonException("$path.access.read has unsupported value $read")
            val writers = access.requiredStrings("write")
            if (writers.isEmpty()) throw JsonException("$path.access.write must not be empty")
            val normalized = LinkedHashSet<String>()
            writers.forEach { writer ->
                val principal = when {
                    writer == "definition" && key.scope == DataScope.DEFINITION -> writer
                    writer == "internal" && key.scope == DataScope.INSTANCE -> writer
                    writer.startsWith("plugin:") && key.scope == DataScope.INSTANCE -> {
                        val plugin = writer.removePrefix("plugin:")
                        if (!plugin.matches(Regex("[A-Za-z0-9_.-]{1,64}"))) {
                            throw JsonException("$path.access.write contains malformed plugin principal $writer")
                        }
                        "plugin:${plugin.lowercase(Locale.ROOT)}"
                    }
                    else -> throw JsonException("$path.access.write principal $writer is incompatible with ${key.scope}")
                }
                if (!normalized.add(principal)) throw JsonException("$path.access.write repeats principal $writer")
            }
            val placeholder = node.requiredObject("placeholderApi").rejectUnknown("exposed", "formatter")
            val exposed = placeholder.requiredBoolean("exposed")
            if (exposed && (!scalar || readAccess != ReadAccess.PUBLIC)) {
                throw JsonException("$path.placeholderApi.exposed requires a public scalar data key")
            }
            return DocumentDataKeyIntegration(
                readAccess,
                writers,
                pdcKeys,
                exposed,
                placeholder.optionalString("formatter")?.let(ItemKey::parse),
            )
        }
    }
}

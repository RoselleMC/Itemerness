package com.iroselle.itemerness.bukkit.catalog

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

class CatalogSourceLoaderTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `loads and compiles the complete bundled domain examples`() {
        copyResource("data-keys/common.yml")
        copyResource("items/examples.yml")

        val loaded = CatalogSourceLoader().load(directory)
        val compilation = CatalogCompiler().compile(loaded.source)

        assertTrue(compilation.successful, compilation.diagnostics.joinToString())
        assertEquals(1, loaded.source.schemas.size)
        assertEquals(5, loaded.source.items.size)
        assertEquals(12, loaded.dataKeyIntegrations.size)
        assertEquals(5, loaded.itemDocuments.size)
        assertTrue(compilation.candidate?.items?.isEmpty() == true, "Bundled examples must remain disabled")

        val metadata = loaded.dataKeyIntegrations.getValue(ItemKey.parse("example:metadata"))
        assertEquals(DataReadAccess.INTERNAL, metadata.readAccess)
        assertFalse(metadata.placeholderExposed)

        val quality = loaded.dataKeyIntegrations.getValue(ItemKey.parse("example:quality"))
        assertEquals(listOf(ItemKey.parse("legacyitems:quality")), quality.pdcFallbacks.map(PdcFallbackSource::key))
        assertEquals(ItemKey.parse("itemerness:key-message"), quality.placeholderFormatter)
    }

    @Test
    fun `rejects an unknown key instead of silently changing item semantics`() {
        write(
            "data-keys/common.yml",
            """
            schema-version: 1
            id: example:common
            keys: {}
            """.trimIndent(),
        )
        write(
            "items/items.yml",
            """
            schema-version: 1
            namespace: example
            items:
              item:
                enabled: true
                typo-enabled: false
                base: {material: minecraft:paper}
                instance:
                  mode: fungible
                  schemas: [example:common@1]
                presentation: {}
            """.trimIndent(),
        )

        assertThrows(IllegalArgumentException::class.java) {
            CatalogSourceLoader().load(directory)
        }
    }

    @Test
    fun `reports missing nested item references at compile time even when examples are disabled`() {
        write(
            "data-keys/common.yml",
            """
            schema-version: 1
            id: example:common
            keys: {}
            """.trimIndent(),
        )
        write(
            "items/items.yml",
            """
            schema-version: 1
            namespace: example
            items:
              satchel:
                enabled: false
                base: {material: minecraft:bundle}
                instance:
                  mode: fungible
                  schemas: [example:common@1]
                contents:
                  - {item: example:missing, amount: 1}
                presentation: {}
            """.trimIndent(),
        )

        val compilation = CatalogCompiler().compile(CatalogSourceLoader().load(directory).source)
        assertFalse(compilation.successful)
        assertTrue(compilation.diagnostics.any { it.message.contains("references missing nested item example:missing") })
    }

    @Test
    fun `strictly parses supported base components and rejects presentation owned components`() {
        write(
            "data-keys/common.yml",
            """
            schema-version: 1
            id: example:common
            keys: {}
            """.trimIndent(),
        )
        write(
            "items/items.yml",
            """
            schema-version: 1
            namespace: example
            items:
              valid:
                enabled: true
                base:
                  material: minecraft:paper
                  components:
                    minecraft:max_stack_size: 16
                    minecraft:enchantment_glint_override: true
                    minecraft:item_model: example:token
                instance:
                  mode: fungible
                  schemas: [example:common@1]
                presentation: {}
            """.trimIndent(),
        )

        val valid = CatalogCompiler().compile(CatalogSourceLoader().load(directory).source)
        assertTrue(valid.successful, valid.diagnostics.toString())

        write(
            "items/items.yml",
            """
            schema-version: 1
            namespace: example
            items:
              invalid:
                enabled: true
                base:
                  material: minecraft:paper
                  components:
                    minecraft:lore: [forbidden]
                instance:
                  mode: fungible
                  schemas: [example:common@1]
                presentation: {}
            """.trimIndent(),
        )
        val invalid = CatalogCompiler().compile(CatalogSourceLoader().load(directory).source)
        assertFalse(invalid.successful)
        assertTrue(invalid.diagnostics.any { it.message.contains("owned by Itemerness") })
    }

    @Test
    fun `rejects configured PDC as an identity or primary value source`() {
        write(
            "data-keys/common.yml",
            """
            schema-version: 1
            id: example:common
            keys:
              example:value:
                type: string
                scope: instance
                read-sources:
                  - pdc: {key: legacy:value, mode: fallback-read-only}
                access: {read: public, write: [internal]}
                placeholder-api: {exposed: false}
            """.trimIndent(),
        )
        write(
            "items/items.yml",
            """
            schema-version: 1
            namespace: example
            items: {}
            """.trimIndent(),
        )

        assertThrows(IllegalArgumentException::class.java) {
            CatalogSourceLoader().load(directory)
        }
    }

    @Test
    fun `canonical and catalog sources are scope-specific primary sources only`() {
        installEmptyItems()
        val cases = listOf(
            Triple("instance", "[canonical-nbt, catalog-definition]", "only valid as the first read source"),
            Triple("instance", "[canonical-nbt, canonical-nbt]", "only valid as the first read source"),
            Triple("definition", "[catalog-definition, canonical-nbt]", "only valid as the first read source"),
            Triple(
                "definition",
                "[catalog-definition, {pdc: {key: legacy:value, mode: fallback-read-only}}]",
                "cannot declare a PDC read source",
            ),
        )

        cases.forEachIndexed { index, (scope, readSources, expected) ->
            writeSchema(scope = scope, readSources = readSources, writers = "[${if (scope == "definition") "definition" else "internal"}]")

            val failure = assertThrows(
                IllegalArgumentException::class.java,
                { CatalogSourceLoader().load(directory) },
                "case $index",
            )

            assertTrue(failure.message.orEmpty().contains(expected), "case $index: ${failure.message}")
        }
    }

    @Test
    fun `duplicate PDC fallbacks are rejected by semantic key`() {
        installEmptyItems()
        writeSchema(
            scope = "instance",
            readSources = "[canonical-nbt, {pdc: {key: legacy:value, mode: fallback-read-only}}, " +
                "{pdc: {key: legacy:value, mode: fallback-read-only}}]",
            writers = "[internal]",
        )

        val failure = assertThrows(IllegalArgumentException::class.java) {
            CatalogSourceLoader().load(directory)
        }

        assertTrue(
            failure.message.orEmpty().contains("Duplicate PDC fallback legacy:value"),
            failure.message.orEmpty(),
        )
    }

    @Test
    fun `writer principals reject empty unknown malformed incompatible and duplicate values`() {
        installEmptyItems()
        data class InvalidWriters(
            val scope: String,
            val writers: String,
            val expected: String,
        )
        val cases = listOf(
            InvalidWriters("instance", "[]", "must not be empty"),
            InvalidWriters("instance", "['']", "non-blank string"),
            InvalidWriters("instance", "['plugin:']", "Malformed plugin write principal"),
            InvalidWriters("instance", "['plugin:Bad Name']", "Malformed plugin write principal"),
            InvalidWriters("instance", "[owner]", "Unknown write principal"),
            InvalidWriters("instance", "[definition]", "incompatible with its scope"),
            InvalidWriters("definition", "[internal]", "incompatible with its scope"),
            InvalidWriters("definition", "['plugin:ExampleConsumer']", "incompatible with its scope"),
            InvalidWriters("instance", "[internal, internal]", "Duplicate write principal"),
            InvalidWriters(
                "instance",
                "['plugin:ExampleConsumer', 'plugin:exampleconsumer']",
                "Duplicate write principal",
            ),
        )

        cases.forEachIndexed { index, case ->
            writeSchema(
                scope = case.scope,
                readSources = "[${if (case.scope == "definition") "catalog-definition" else "canonical-nbt"}]",
                writers = case.writers,
            )

            val failure = assertThrows(
                IllegalArgumentException::class.java,
                { CatalogSourceLoader().load(directory) },
                "case $index",
            )

            assertTrue(failure.message.orEmpty().contains(case.expected), "case $index: ${failure.message}")
        }
    }

    @Test
    fun `rejects PlaceholderAPI exposure for non-public data`() {
        write(
            "data-keys/private.yml",
            """
            schema-version: 1
            id: example:private
            keys:
              example:secret:
                type: string
                scope: instance
                nullable: true
                read-sources: [canonical-nbt]
                access: {read: owner-only, write: [internal]}
                placeholder-api: {exposed: true}
            """.trimIndent(),
        )
        write(
            "items/items.yml",
            """
            schema-version: 1
            namespace: example
            items: {}
            """.trimIndent(),
        )

        val failure = assertThrows(IllegalArgumentException::class.java) {
            CatalogSourceLoader().load(directory)
        }

        assertTrue(failure.message.orEmpty().contains("cannot be exposed through PlaceholderAPI"))
    }

    private fun copyResource(path: String) {
        val destination = directory.resolve(path)
        Files.createDirectories(destination.parent)
        checkNotNull(javaClass.classLoader.getResourceAsStream(path)).use { input ->
            Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun installEmptyItems() {
        write(
            "items/items.yml",
            """
            schema-version: 1
            namespace: example
            items: {}
            """.trimIndent(),
        )
    }

    private fun writeSchema(
        scope: String,
        readSources: String,
        writers: String,
    ) {
        write(
            "data-keys/common.yml",
            """
            schema-version: 1
            id: example:common
            keys:
              example:value:
                type: string
                scope: $scope
                read-sources: $readSources
                access: {read: public, write: $writers}
                placeholder-api: {exposed: false}
            """.trimIndent(),
        )
    }

    private fun write(
        path: String,
        content: String,
    ) {
        val destination = directory.resolve(path)
        Files.createDirectories(destination.parent)
        Files.writeString(destination, content)
    }
}

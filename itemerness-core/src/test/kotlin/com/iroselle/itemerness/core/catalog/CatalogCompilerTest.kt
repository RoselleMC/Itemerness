package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.Random
import java.util.UUID
import java.util.function.Supplier

class CatalogCompilerTest {
    private val compiler = CatalogCompiler()

    @Test
    fun `compiles definitions and creates settled immutable instance data`() {
        val compilation = compiler.compile(validCatalog())

        assertTrue(compilation.successful, compilation.diagnostics.toString())
        assertNotNull(compilation.candidate)
        val candidate = compilation.candidate!!
        val catalog = AtomicCatalog().publish(candidate)
        val definition = catalog.findItem(ItemKey.parse("itemerness:ember-blade"))
        assertEquals(ItemKey.parse("minecraft:netherite_sword"), definition?.material)
        assertEquals(ItemInstanceMode.UNIQUE, definition?.instanceMode)

        val uuid = UUID.fromString("123e4567-e89b-42d3-a456-426614174000")
        val context = InstanceCreationContext(
            clock = Clock.fixed(Instant.ofEpochMilli(1_725_000_000_123), ZoneOffset.UTC),
            random = Random(7),
            uuidSupplier = Supplier { uuid },
        )
        val instance = catalog.createInstance(ItemKey.parse("itemerness:ember-blade"), context)

        assertEquals(1, instance.createdAgainstRevision)
        assertEquals(0, instance.instanceRevision)
        assertEquals(uuid, instance.instanceId)
        assertEquals(7, instance.schemaVersions[ItemKey.parse("itemerness:common")])
        assertEquals(LongDataValue(1_725_000_000_123), instance[DataKey.parse("itemerness:created-at")])
        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            instance[DataKey.parse("example:quality")],
        )
        assertTrue((instance[DataKey.parse("example:attack-damage")] as DecimalDataValue).value in 34.0..42.0)
        assertNull(instance[DataKey.parse("example:region")])

        val sockets = instance[DataKey.parse("example:sockets")] as ListDataValue
        val socket = sockets.values.single() as CompoundDataValue
        assertEquals(setOf("type"), socket.entries.keys)
        val metadata = instance[DataKey.parse("example:metadata")] as CompoundDataValue
        assertEquals(
            ListDataValue(listOf(IntegerDataValue(18), IntegerDataValue(32))),
            metadata.entries["counts"],
        )

        val second = catalog.createInstance(ItemKey.parse("itemerness:ember-blade"), context)
        assertEquals(instance[DataKey.parse("itemerness:created-at")], second[DataKey.parse("itemerness:created-at")])
        assertEquals(instance[DataKey.parse("example:quality")], second[DataKey.parse("example:quality")])
    }

    @Test
    fun `immutable edits validate values and advance only instance revision`() {
        val snapshot = AtomicCatalog().publish(compiler.compile(validCatalog()).candidate!!)
        val context = InstanceCreationContext(
            Clock.systemUTC(),
            Random(1),
            Supplier { UUID.fromString("123e4567-e89b-42d3-a456-426614174000") },
        )
        val original = snapshot.createInstance(ItemKey.parse("itemerness:ember-blade"), context)

        val edited = snapshot.editInstance(
            original,
            listOf(
                InstanceDataMutation.Set(
                    DataKey.parse("example:quality"),
                    NamespacedKeyDataValue(ItemKey.parse("example:common")),
                ),
            ),
        )

        assertEquals(0, original.instanceRevision)
        assertEquals(1, edited.instanceRevision)
        assertEquals(original.createdAgainstRevision, edited.createdAgainstRevision)
        assertEquals(original.instanceId, edited.instanceId)
        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:rare")),
            original[DataKey.parse("example:quality")],
        )
        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:common")),
            edited[DataKey.parse("example:quality")],
        )

        assertThrows(IllegalArgumentException::class.java) {
            snapshot.editInstance(
                edited,
                listOf(InstanceDataMutation.Remove(DataKey.parse("example:quality"))),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            snapshot.editInstance(
                edited,
                listOf(
                    InstanceDataMutation.Set(
                        DataKey.parse("example:quality"),
                        NamespacedKeyDataValue(ItemKey.parse("example:forged")),
                    ),
                ),
            )
        }

        val unchanged = snapshot.editInstance(
            edited,
            listOf(
                InstanceDataMutation.Set(
                    DataKey.parse("example:quality"),
                    NamespacedKeyDataValue(ItemKey.parse("example:common")),
                ),
            ),
        )
        assertTrue(unchanged === edited)
        assertEquals(1, unchanged.instanceRevision)
    }

    @Test
    fun `fungible definitions never create instance ids`() {
        val valid = validCatalog()
        val source = CatalogSource(
            schemas = valid.schemas,
            items = listOf(
                ItemDefinitionSource(
                    id = "itemerness:travel-token",
                    enabled = true,
                    material = "minecraft:paper",
                    instance = ItemInstanceSource(
                        mode = ItemInstanceMode.FUNGIBLE,
                        schemas = listOf(SchemaReferenceSource("itemerness:common", 7)),
                        generators = listOf(DataGeneratorSource.UnixMillis("itemerness:created-at")),
                    ),
                ),
            ),
        )
        val compilation = compiler.compile(source)
        assertTrue(compilation.successful, compilation.diagnostics.toString())

        val instance = AtomicCatalog()
            .publish(compilation.candidate!!)
            .createInstance(ItemKey.parse("itemerness:travel-token"))

        assertNull(instance.instanceId)
        assertEquals(0, instance.instanceRevision)
    }

    @Test
    fun `disabled items are validated but omitted from the candidate`() {
        val valid = validCatalog()
        val source = CatalogSource(
            schemas = valid.schemas,
            items = valid.items.map { item ->
                ItemDefinitionSource(
                    id = item.id,
                    enabled = false,
                    material = item.material,
                    instance = item.instance,
                    definitionData = item.definitionData,
                )
            },
        )

        val compilation = compiler.compile(source)

        assertTrue(compilation.successful, compilation.diagnostics.toString())
        val candidate = requireNotNull(compilation.candidate)
        assertTrue(candidate.items.isEmpty())
        assertEquals(
            setOf(ItemKey.parse("itemerness:ember-blade")),
            candidate.materializeValidationView().items.keys,
        )
    }

    @Test
    fun `source format and persisted schema version remain independent`() {
        val source = validCatalog(schemaVersion = 19)
        val compilation = compiler.compile(source)

        assertTrue(compilation.successful, compilation.diagnostics.toString())
        val instance = AtomicCatalog()
            .publish(compilation.candidate!!)
            .createInstance(
                ItemKey.parse("itemerness:ember-blade"),
                InstanceCreationContext(
                    Clock.systemUTC(),
                    Random(1),
                    Supplier { UUID.fromString("123e4567-e89b-42d3-a456-426614174000") },
                ),
            )
        assertEquals(19, instance.schemaVersions[ItemKey.parse("itemerness:common")])

        val invalidFormat = CatalogSource(
            schemas = source.schemas.map { schema ->
                DataSchemaSource(schema.id, schema.version, schema.keys, sourceFormatVersion = 19)
            },
            items = source.items,
        )
        val rejected = compiler.compile(invalidFormat)
        assertFalse(rejected.successful)
        assertTrue(rejected.diagnostics.any { it.path.endsWith("source-format-version") })
    }
}

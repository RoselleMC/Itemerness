package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogManager
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogUpdate
import com.iroselle.itemerness.core.catalog.DataType
import io.papermc.paper.persistence.PersistentDataContainerView
import org.bukkit.NamespacedKey
import org.bukkit.inventory.ItemStack
import org.bukkit.persistence.PersistentDataType
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.UUID

class PdcFallbackReaderTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `decodes a declared namespaced key without scanning other PDC keys`() {
        val key = ItemKey.parse("legacyitems:quality")
        val view = fakeView(
            key = NamespacedKey(key.namespace, key.value),
            type = PersistentDataType.STRING,
            value = "example:rare",
        )

        val result = BukkitPdcFallbackReader.read(
            PdcBackedItemStack(view),
            key,
            DataType.NamespacedKeyType,
        )

        assertEquals(
            PdcFallbackRead.Value(NamespacedKeyDataValue(ItemKey.parse("example:rare"))),
            result,
        )
    }

    @Test
    fun `uses the canonical four-integer UUID representation`() {
        val key = ItemKey.parse("legacyitems:owner")
        val expected = UUID.fromString("12345678-9abc-4def-8123-456789abcdef")
        val parts = intArrayOf(
            (expected.mostSignificantBits shr Int.SIZE_BITS).toInt(),
            expected.mostSignificantBits.toInt(),
            (expected.leastSignificantBits shr Int.SIZE_BITS).toInt(),
            expected.leastSignificantBits.toInt(),
        )

        val result = BukkitPdcFallbackReader.read(
            PdcBackedItemStack(
                fakeView(
                    key = NamespacedKey(key.namespace, key.value),
                    type = PersistentDataType.INTEGER_ARRAY,
                    value = parts,
                ),
            ),
            key,
            DataType.UuidType,
        )

        assertEquals(PdcFallbackRead.Value(UuidDataValue(expected)), result)
    }

    @Test
    fun `rejects an existing fallback with the wrong physical type`() {
        val key = ItemKey.parse("legacyitems:quality")
        val view = fakeView(
            key = NamespacedKey(key.namespace, key.value),
            type = PersistentDataType.INTEGER,
            value = 7,
        )

        val result = BukkitPdcFallbackReader.read(
            PdcBackedItemStack(view),
            key,
            DataType.NamespacedKeyType,
        )

        assertTrue(result is PdcFallbackRead.Invalid)
    }

    @Test
    fun `float fallback uses stable decimal semantics for scale and allowed values`() {
        installBundledDomain()
        val schema = directory.resolve("data-keys/common.yml")
        val ratioDefinition =
            """
            example:ratio:
              type: decimal
              scope: instance
              nullable: true
              affects-stacking: true
              presentation-readable: true
              constraints:
                scale: 1
                allowed: [0.1]
              read-sources:
                - canonical-nbt
                - pdc:
                    key: legacyitems:ratio
                    mode: fallback-read-only
              access:
                read: public
                write: [internal]
              placeholder-api:
                exposed: false
            """.trimIndent().prependIndent("  ")
        Files.writeString(
            schema,
            Files.readString(schema).replaceFirst("keys:\n", "keys:\n$ratioDefinition\n"),
            Charsets.UTF_8,
        )
        val items = directory.resolve("items/examples.yml")
        Files.writeString(
            items,
            Files.readString(items).replaceFirst("enabled: false", "enabled: true"),
            Charsets.UTF_8,
        )
        val update = RuntimeCatalogManager(directory, "26.1.2").reload()
        assertTrue(update is RuntimeCatalogUpdate.Published, update.diagnostics.toString())
        val runtime = (update as RuntimeCatalogUpdate.Published).active
        val pdcKey = ItemKey.parse("legacyitems:ratio")
        val dataKey = DataKey.parse("example:ratio")
        val itemKey = ItemKey.parse("itemerness:travel-token")

        val read = BukkitPdcFallbackReader.read(
            PdcBackedItemStack(
                fakeView(
                    key = NamespacedKey(pdcKey.namespace, pdcKey.value),
                    type = PersistentDataType.FLOAT,
                    value = 0.1F,
                ),
            ),
            pdcKey,
            DataType.DecimalType,
        ) as PdcFallbackRead.Value

        assertEquals(DecimalDataValue(0.1), read.value)
        assertTrue(runtime.domain.validateDataValue(itemKey, dataKey, read.value).isEmpty())
        val binaryExpanded = runtime.domain.validateDataValue(
            itemKey,
            dataKey,
            DecimalDataValue(0.1F.toDouble()),
        )
        assertTrue(binaryExpanded.any { violation -> violation.contains("scale") }, binaryExpanded.toString())
        assertTrue(binaryExpanded.any { violation -> violation.contains("allowed set") }, binaryExpanded.toString())
    }

    private fun installBundledDomain() {
        copyResource("config.yml")
        val resources = checkNotNull(javaClass.classLoader.getResourceAsStream("itemerness-resources.txt"))
            .bufferedReader(Charsets.UTF_8)
            .useLines { lines ->
                lines.map(String::trim)
                    .filter { it.isNotEmpty() && !it.startsWith('#') }
                    .toList()
            }
        resources.forEach(::copyResource)
    }

    private fun copyResource(path: String) {
        val destination = directory.resolve(path)
        Files.createDirectories(destination.parent)
        checkNotNull(javaClass.classLoader.getResourceAsStream(path)).use { input ->
            Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

private class PdcBackedItemStack(
    private val view: PersistentDataContainerView,
) : ItemStack() {
    override fun getPersistentDataContainer(): PersistentDataContainerView = view
}

private fun <P : Any, C : Any> fakeView(
    key: NamespacedKey,
    type: PersistentDataType<P, C>,
    value: C,
): PersistentDataContainerView = Proxy.newProxyInstance(
    PersistentDataContainerView::class.java.classLoader,
    arrayOf(PersistentDataContainerView::class.java),
) { proxy, method, args ->
    when (method.name) {
        "has" -> when (args?.size) {
            1 -> args[0] == key
            2 -> args[0] == key && args[1] === type
            else -> false
        }

        "get" -> if (args?.getOrNull(0) == key && args.getOrNull(1) === type) value else null
        "getKeys" -> setOf(key)
        "isEmpty" -> false
        "getSize" -> 1
        "equals" -> proxy === args?.firstOrNull()
        "hashCode" -> System.identityHashCode(proxy)
        "toString" -> "FakePersistentDataContainerView($key)"
        else -> primitiveDefault(method.returnType)
    }
} as PersistentDataContainerView

private fun primitiveDefault(type: Class<*>): Any? = when (type) {
    java.lang.Boolean.TYPE -> false
    java.lang.Byte.TYPE -> 0.toByte()
    java.lang.Short.TYPE -> 0.toShort()
    java.lang.Integer.TYPE -> 0
    java.lang.Long.TYPE -> 0L
    java.lang.Float.TYPE -> 0.0f
    java.lang.Double.TYPE -> 0.0
    java.lang.Character.TYPE -> '\u0000'
    else -> null
}

package com.iroselle.itemerness.bukkit.api

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.core.catalog.DataType
import io.papermc.paper.persistence.PersistentDataContainerView
import org.bukkit.NamespacedKey
import org.bukkit.inventory.ItemStack
import org.bukkit.persistence.PersistentDataType
import java.math.BigDecimal
import java.util.UUID

internal fun interface PdcFallbackReader {
    fun read(
        source: ItemStack,
        key: ItemKey,
        type: DataType,
    ): PdcFallbackRead
}

internal sealed interface PdcFallbackRead {
    data object Absent : PdcFallbackRead

    data class Value(
        val value: ItemDataValue,
    ) : PdcFallbackRead

    data class Invalid(
        val reason: String,
    ) : PdcFallbackRead
}

/** Reads exactly one catalog-declared PDC key and never writes or scans foreign PDC data. */
internal object BukkitPdcFallbackReader : PdcFallbackReader {
    override fun read(
        source: ItemStack,
        key: ItemKey,
        type: DataType,
    ): PdcFallbackRead {
        val bukkitKey = NamespacedKey(key.namespace, key.value)
        val container = source.persistentDataContainer
        if (!container.has(bukkitKey)) {
            return PdcFallbackRead.Absent
        }
        if (type is DataType.ListType || type is DataType.CompoundType) {
            return PdcFallbackRead.Invalid("Complex PDC fallback values are not supported")
        }
        return try {
            PdcFallbackRead.Value(decode(container, bukkitKey, type))
        } catch (failure: RuntimeException) {
            PdcFallbackRead.Invalid(
                failure.message ?: "The PDC fallback value has an invalid physical type",
            )
        }
    }

    private fun decode(
        container: PersistentDataContainerView,
        key: NamespacedKey,
        type: DataType,
    ): ItemDataValue = when (type) {
        DataType.BooleanType -> BooleanDataValue(
            when (val value = container.required(key, PersistentDataType.BYTE)) {
                0.toByte() -> false
                1.toByte() -> true
                else -> throw IllegalArgumentException("Boolean PDC fallback must be encoded as byte 0 or 1")
            },
        )

        DataType.IntegerType -> IntegerDataValue(container.integer(key))
        DataType.LongType -> LongDataValue(container.required(key, PersistentDataType.LONG))
        DataType.DecimalType -> DecimalDataValue(container.decimal(key))
        DataType.StringType -> StringDataValue(container.required(key, PersistentDataType.STRING))
        DataType.UuidType -> UuidDataValue(decodeUuid(container.required(key, PersistentDataType.INTEGER_ARRAY)))
        DataType.NamespacedKeyType -> NamespacedKeyDataValue(
            ItemKey.parse(container.required(key, PersistentDataType.STRING)),
        )

        is DataType.ListType,
        is DataType.CompoundType,
        -> error("Complex PDC fallback values are not supported")
    }

    private fun decodeUuid(parts: IntArray): UUID {
        require(parts.size == UUID_INTEGER_COUNT) {
            "UUID PDC fallback must contain exactly $UUID_INTEGER_COUNT integers"
        }
        val mostSignificant = (parts[0].toLong() shl Int.SIZE_BITS) or parts[1].toUnsignedLong()
        val leastSignificant = (parts[2].toLong() shl Int.SIZE_BITS) or parts[3].toUnsignedLong()
        return UUID(mostSignificant, leastSignificant)
    }

    private fun Int.toUnsignedLong(): Long = toLong() and 0xFFFF_FFFFL

    private fun PersistentDataContainerView.integer(key: NamespacedKey): Int =
        get(key, PersistentDataType.INTEGER)
            ?: get(key, PersistentDataType.SHORT)?.toInt()
            ?: get(key, PersistentDataType.BYTE)?.toInt()
            ?: throw IllegalArgumentException("PDC fallback ${key.asString()} has the wrong physical type")

    private fun PersistentDataContainerView.decimal(key: NamespacedKey): Double =
        get(key, PersistentDataType.DOUBLE)
            ?: get(key, PersistentDataType.FLOAT)?.let { value ->
                BigDecimal(value.toString()).toDouble()
            }
            ?: throw IllegalArgumentException("PDC fallback ${key.asString()} has the wrong physical type")

    private fun <P : Any, C : Any> PersistentDataContainerView.required(
        key: NamespacedKey,
        type: PersistentDataType<P, C>,
    ): C = requireNotNull(get(key, type)) {
        "PDC fallback ${key.asString()} has the wrong physical type"
    }

    private const val UUID_INTEGER_COUNT = 4
}

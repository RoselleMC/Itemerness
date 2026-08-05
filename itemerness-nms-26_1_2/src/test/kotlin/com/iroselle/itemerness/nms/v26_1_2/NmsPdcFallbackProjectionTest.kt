package com.iroselle.itemerness.nms.v26_1_2

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.ProjectionPdcFallback
import com.iroselle.itemerness.projection.ProjectionPdcFallbackPlan
import com.iroselle.itemerness.projection.ProjectionPdcScalarType
import net.minecraft.SharedConstants
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.nbt.CompoundTag
import net.minecraft.network.chat.Component
import net.minecraft.server.Bootstrap
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import net.minecraft.world.item.component.CustomData
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import java.math.BigDecimal

class NmsPdcFallbackProjectionTest {
    private val codec = NmsCanonicalItemCodec()
    private val travelToken = ItemKey.parse("itemerness:travel-token")
    private val charges = DataKey.parse("example:charges")
    private val ratio = DataKey.parse("example:ratio")
    private val plan = ProjectionPdcFallbackPlan(
        listOf(
            ProjectionPdcFallback(
                itemKeys = listOf(travelToken),
                dataKey = charges,
                pdcKey = ItemKey.parse("legacy:charges"),
                type = ProjectionPdcScalarType.INTEGER,
            ),
        ),
    )
    private val decimalPlan = ProjectionPdcFallbackPlan(
        listOf(
            ProjectionPdcFallback(
                itemKeys = listOf(travelToken),
                dataKey = ratio,
                pdcKey = ItemKey.parse("legacy:ratio"),
                type = ProjectionPdcScalarType.DECIMAL,
            ),
        ),
    )

    @Test
    fun `only catalog planned PDC keys are decoded`() {
        val decoded = codec.decode(
            canonicalStack(
                CompoundTag().apply {
                    putInt("legacy:charges", 17)
                    putString("foreign:secret", "must-not-be-read")
                },
            ),
            plan,
        ) as CanonicalDecodeResult.Decoded

        assertEquals(IntegerProjectionValue(17), decoded.snapshot.pdcFallbackData[charges.toString()])
        assertEquals(1, decoded.snapshot.pdcFallbackData.entries.size)
    }

    @Test
    fun `planned PDC participates in projection fingerprint while foreign PDC does not`() {
        fun fingerprint(charges: Int, foreign: String) = (
            codec.decode(
                canonicalStack(
                    CompoundTag().apply {
                        putInt("legacy:charges", charges)
                        putString("foreign:secret", foreign)
                    },
                ),
                plan,
            ) as CanonicalDecodeResult.Decoded
            ).snapshot.fingerprint

        assertEquals(fingerprint(3, "one"), fingerprint(3, "two"))
        assertNotEquals(fingerprint(3, "one"), fingerprint(4, "one"))
    }

    @Test
    fun `existing planned PDC with wrong physical type invalidates managed projection`() {
        val result = codec.decode(
            canonicalStack(CompoundTag().apply { putString("legacy:charges", "17") }),
            plan,
        )

        assertTrue(result is CanonicalDecodeResult.Invalid)
    }

    @Test
    fun `canonical data shadows a malformed planned PDC before scalar decoding`() {
        val result = codec.decode(
            canonicalStack(
                pdc = CompoundTag().apply { putString("legacy:charges", "17") },
                canonicalData = CompoundTag().apply { putInt(charges.toString(), 9) },
            ),
            plan,
        ) as CanonicalDecodeResult.Decoded

        assertEquals(IntegerProjectionValue(9), result.snapshot.data[charges.toString()])
        assertTrue(result.snapshot.pdcFallbackData.entries.isEmpty())
    }

    @Test
    fun `PDC planned only for another item is not decoded`() {
        val result = codec.decode(
            canonicalStack(
                pdc = CompoundTag().apply { putString("legacy:charges", "17") },
                itemKey = ItemKey.parse("itemerness:other-item"),
            ),
            plan,
        ) as CanonicalDecodeResult.Decoded

        assertTrue(result.snapshot.pdcFallbackData.entries.isEmpty())
    }

    @Test
    fun `float PDC uses stable decimal string semantics`() {
        val result = codec.decode(
            canonicalStack(CompoundTag().apply { putFloat("legacy:ratio", 0.1F) }),
            decimalPlan,
        ) as CanonicalDecodeResult.Decoded

        assertEquals(
            DecimalProjectionValue(BigDecimal("0.1")),
            result.snapshot.pdcFallbackData[ratio.toString()],
        )
    }

    private fun canonicalStack(
        pdc: CompoundTag,
        canonicalData: CompoundTag = CompoundTag(),
        itemKey: ItemKey = travelToken,
    ): ItemStack {
        val root = CompoundTag().apply {
            putInt("format", 1)
            putString("id", itemKey.toString())
            putLong("created_against_revision", 1)
            putLong("instance_revision", 0)
            put("data_schemas", CompoundTag().apply { putInt("itemerness:common", 1) })
            put("data", canonicalData)
        }
        return ItemStack(Items.PAPER).also { stack ->
            CustomData.set(
                DataComponents.CUSTOM_DATA,
                stack,
                CompoundTag().apply {
                    put(NmsCanonicalItemCodec.ROOT_KEY, root)
                    put("PublicBukkitValues", pdc)
                },
            )
            stack.set(DataComponents.ITEM_NAME, Component.literal("[$itemKey]"))
        }
    }

    companion object {
        @JvmStatic
        @BeforeAll
        fun bootstrap() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
            Items.PAPER.builtInRegistryHolder().bindComponents(
                DataComponentMap.builder()
                    .set(DataComponents.MAX_STACK_SIZE, 64)
                    .build(),
            )
        }
    }
}

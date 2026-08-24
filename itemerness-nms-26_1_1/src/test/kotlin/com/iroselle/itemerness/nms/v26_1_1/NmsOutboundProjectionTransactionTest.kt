package com.iroselle.itemerness.nms.v26_1_1

import com.iroselle.itemerness.projection.ProjectionGeneration
import java.util.Optional
import net.minecraft.SharedConstants
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.StringTag
import net.minecraft.network.HashedPatchMap
import net.minecraft.network.HashedStack
import net.minecraft.network.chat.Component
import net.minecraft.resources.Identifier
import net.minecraft.server.Bootstrap
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class NmsOutboundProjectionTransactionTest {
    @Test
    fun `failed commit publishes no item custom click or generation state`() {
        val state = state(customClickCapacity = 1)
        val seedId = Identifier.fromNamespaceAndPath("itemerness", "seed")
        val seedGeneration = ProjectionGeneration(catalogRevision = 1, epoch = 1)
        val seed = state.beginOutboundProjection()
        val seedWire = seed.registerDirect(
            seedId,
            StringTag.valueOf("seed-canonical"),
            StringTag.valueOf("seed-projected"),
            seedGeneration,
        )
        seed.commit()

        val transaction = state.beginOutboundProjection()
        val canonical = ItemStack(Items.STONE)
        val projected = ItemStack(Items.STONE).also { stack ->
            stack.set(DataComponents.CUSTOM_NAME, Component.literal("projected"))
        }
        val pendingGeneration = ProjectionGeneration(catalogRevision = 1, epoch = 2)
        val tokenized = transaction.register(canonical, projected, pendingGeneration)
        val overflowId = Identifier.fromNamespaceAndPath("itemerness", "overflow")
        transaction.registerDirect(
            overflowId,
            StringTag.valueOf("overflow-canonical"),
            StringTag.valueOf("overflow-projected"),
            pendingGeneration,
        )

        assertThrows(NmsRecoverableProjectionException::class.java) {
            transaction.commit()
        }
        transaction.abort()

        val creative = state.restoreCreative(tokenized)
        assertTrue(creative is CreativeRestoreResult.Rejected)
        assertEquals(
            CreativeRejectReason.UNKNOWN_TOKEN,
            (creative as CreativeRestoreResult.Rejected).reason,
        )
        val seedRestore = state.restoreCustomClick(seedId, Optional.of(seedWire))
        assertTrue(seedRestore is CustomClickRestoreResult.Restored)
        assertEquals(
            StringTag.valueOf("seed-canonical"),
            (seedRestore as CustomClickRestoreResult.Restored).payload.orElseThrow(),
        )
        assertEquals(
            CustomClickRestoreResult.Unmanaged,
            state.restoreCustomClick(overflowId, Optional.empty()),
        )
        assertTrue(state.rewrite(HashedStack.create(tokenized, HASHER)) is HashedRewriteResult.PassThrough)

        state.register(
            ItemStack(Items.STONE),
            ItemStack(Items.STONE).also { stack ->
                stack.set(DataComponents.CUSTOM_NAME, Component.literal("third generation"))
            },
            ProjectionGeneration(catalogRevision = 1, epoch = 3),
        )
        val stillProtected = state.restoreCustomClick(seedId, Optional.empty())
        assertTrue(stillProtected is CustomClickRestoreResult.Rejected)
        assertEquals(
            CustomClickRejectReason.MISSING_TOKEN,
            (stillProtected as CustomClickRestoreResult.Rejected).reason,
        )
    }

    @Test
    fun `reserved additions key is recoverable and an aborted packet publishes nothing`() {
        val state = state(customClickCapacity = 2)
        val transaction = state.beginOutboundProjection()
        val tokenized = transaction.register(
            ItemStack(Items.STONE),
            ItemStack(Items.STONE).also { stack ->
                stack.set(DataComponents.CUSTOM_NAME, Component.literal("projected"))
            },
            ProjectionGeneration(catalogRevision = 1, epoch = 1),
        )
        val reserved = CompoundTag().apply {
            put(NmsCustomClickTokenCodec.ACTION_KEY, CompoundTag())
        }

        assertThrows(NmsRecoverableProjectionException::class.java) {
            transaction.registerAdditions(
                Identifier.fromNamespaceAndPath("itemerness", "reserved"),
                reserved,
                CompoundTag(),
                ProjectionGeneration(catalogRevision = 1, epoch = 1),
            )
        }
        transaction.abort()

        val restore = state.restoreCreative(tokenized)
        assertTrue(restore is CreativeRestoreResult.Rejected)
        assertEquals(
            CreativeRejectReason.UNKNOWN_TOKEN,
            (restore as CreativeRestoreResult.Rejected).reason,
        )
    }

    @Test
    fun `expected component hash encoding failure degrades only the hashed mapping`() {
        val state = NmsConnectionProjectionState(
            connectionGeneration = 17,
            hasher = HashedPatchMap.HashGenerator {
                throw NmsRecoverableHashEncodingException("expected unencodable component")
            },
        )
        val transaction = state.beginOutboundProjection()
        val canonical = ItemStack(Items.STONE)
        val tokenized = transaction.register(
            canonical,
            ItemStack(Items.STONE).also { stack ->
                stack.set(DataComponents.CUSTOM_NAME, Component.literal("projected"))
            },
            ProjectionGeneration(catalogRevision = 1, epoch = 1),
        )

        transaction.commit()

        assertTrue(state.restoreCreative(tokenized) is CreativeRestoreResult.Restored)
        assertTrue(state.rewrite(HashedStack.create(tokenized, HASHER)) is HashedRewriteResult.PassThrough)
    }

    private fun state(customClickCapacity: Int): NmsConnectionProjectionState =
        NmsConnectionProjectionState(
            connectionGeneration = 17,
            hasher = HASHER,
            customClickCapacity = customClickCapacity,
        )

    private companion object {
        val HASHER = HashedPatchMap.HashGenerator { component -> component.value().hashCode() }

        @JvmStatic
        @BeforeAll
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
            Items.STONE.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
        }
    }
}

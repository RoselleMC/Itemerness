package com.iroselle.itemerness.nms.v1_21_11

import com.mojang.datafixers.util.Pair
import net.minecraft.SharedConstants
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.nbt.CompoundTag
import net.minecraft.network.chat.Component
import net.minecraft.network.protocol.game.ClientboundBundlePacket
import net.minecraft.network.protocol.game.ClientboundContainerClosePacket
import net.minecraft.network.protocol.game.ClientboundLoginPacket
import net.minecraft.network.protocol.game.ClientboundPlaceGhostRecipePacket
import net.minecraft.network.protocol.game.ClientboundRecipeBookAddPacket
import net.minecraft.network.protocol.game.ClientboundRemoveEntitiesPacket
import net.minecraft.network.protocol.game.ClientboundRespawnPacket
import net.minecraft.network.protocol.game.ClientboundSetEntityDataPacket
import net.minecraft.network.protocol.game.ClientboundSetEquipmentPacket
import net.minecraft.network.protocol.game.ClientboundStartConfigurationPacket
import net.minecraft.network.protocol.game.ClientboundUpdateAdvancementsPacket
import net.minecraft.network.protocol.game.ClientboundUpdateRecipesPacket
import net.minecraft.network.syncher.EntityDataSerializers
import net.minecraft.network.syncher.SynchedEntityData
import net.minecraft.server.Bootstrap
import net.minecraft.world.entity.EquipmentSlot
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.crafting.SelectableRecipe
import net.minecraft.world.item.crafting.StonecutterRecipe
import net.minecraft.world.item.crafting.display.SlotDisplay
import net.minecraft.world.item.crafting.display.StonecutterRecipeDisplay
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class NmsPersistentSurfaceCacheTest {
    @Test
    fun `metadata and equipment updates merge by wire identity and snapshots own their values`() {
        val cache = cache(entityCapacity = 2)
        val first = namedStack("first")
        val replacement = namedStack("replacement")
        val helmet = namedStack("helmet")
        val boots = namedStack("boots")

        cache.observe(metadata(7, 3, first))
        cache.observe(metadata(7, 3, replacement))
        cache.observe(equipment(7, true, EquipmentSlot.HEAD to helmet))
        cache.observe(equipment(7, false, EquipmentSlot.FEET to boots))

        first.set(DataComponents.ITEM_NAME, Component.literal("mutated first"))
        replacement.set(DataComponents.ITEM_NAME, Component.literal("mutated replacement"))
        helmet.set(DataComponents.ITEM_NAME, Component.literal("mutated helmet"))
        boots.set(DataComponents.ITEM_NAME, Component.literal("mutated boots"))

        val snapshot = cache.snapshot()
        val metadata = snapshot.filterIsInstance<ClientboundSetEntityDataPacket>().single()
        val equipment = snapshot.filterIsInstance<ClientboundSetEquipmentPacket>()

        assertEquals("replacement", (metadata.packedItems().single().value() as ItemStack).itemName.string)
        assertEquals(
            mapOf(EquipmentSlot.HEAD to "helmet", EquipmentSlot.FEET to "boots"),
            equipment.flatMap { packet -> packet.slots }
                .associate { entry -> entry.first to entry.second.itemName.string },
        )
        assertTrue(NmsEquipmentPacketAccess.sanitize(equipment.single { packet ->
            packet.slots.any { entry -> entry.first == EquipmentSlot.HEAD }
        }))
        assertFalse(NmsEquipmentPacketAccess.sanitize(equipment.single { packet ->
            packet.slots.any { entry -> entry.first == EquipmentSlot.FEET }
        }))

        val metadataStack = metadata.packedItems().single().value() as ItemStack
        val equipmentStack = equipment.flatMap { packet -> packet.slots }
            .first { entry -> entry.first == EquipmentSlot.HEAD }.second
        assertNotSame(replacement, metadataStack)
        assertNotSame(helmet, equipmentStack)

        metadataStack.set(DataComponents.ITEM_NAME, Component.literal("snapshot mutation"))
        equipmentStack.set(DataComponents.ITEM_NAME, Component.literal("snapshot mutation"))
        val secondSnapshot = cache.snapshot()
        assertEquals(
            "replacement",
            (secondSnapshot.filterIsInstance<ClientboundSetEntityDataPacket>()
                .single().packedItems().single().value() as ItemStack).itemName.string,
        )
        assertEquals(
            "helmet",
            secondSnapshot.filterIsInstance<ClientboundSetEquipmentPacket>()
                .flatMap { packet -> packet.slots }
                .first { it.first == EquipmentSlot.HEAD }.second.itemName.string,
        )
    }

    @Test
    fun `bundles are atomic removals purge and entity capacity never silently evicts coverage`() {
        val cache = cache(entityCapacity = 2)
        cache.observe(ClientboundBundlePacket(listOf(metadata(1, 0, namedStack("one")))))
        cache.observe(metadata(2, 0, namedStack("two")))

        assertThrows(NmsPersistentSurfaceIncompleteException::class.java) {
            cache.observe(
                ClientboundBundlePacket(
                    listOf(
                        metadata(1, 1, namedStack("one-b")),
                        metadata(3, 0, namedStack("three")),
                    ),
                ),
            )
        }

        val retainedIds = cache.snapshot()
            .filterIsInstance<ClientboundSetEntityDataPacket>()
            .map { it.id() }
            .toSet()
        assertEquals(setOf(1, 2), retainedIds)
        assertEquals(
            listOf("one"),
            cache.snapshot().filterIsInstance<ClientboundSetEntityDataPacket>()
                .single { it.id() == 1 }
                .packedItems().map { (it.value() as ItemStack).itemName.string },
        )

        cache.observe(ClientboundRemoveEntitiesPacket(1))
        cache.observe(metadata(3, 0, namedStack("three")))
        assertEquals(
            setOf(2, 3),
            cache.snapshot().filterIsInstance<ClientboundSetEntityDataPacket>().map { it.id() }.toSet(),
        )

        cache.clear()
        assertTrue(cache.snapshot().isEmpty())
    }

    @Test
    fun `refresh snapshots obey global value work and page bounds`() {
        val cache = cache(entityCapacity = 1_500)
        repeat(1_300) { entityId ->
            cache.observe(metadata(entityId, 0, namedStack("metadata-$entityId")))
            cache.observe(equipment(entityId, true, EquipmentSlot.HEAD to namedStack("head-$entityId")))
            cache.observe(equipment(entityId, false, EquipmentSlot.FEET to namedStack("feet-$entityId")))
        }

        val pages = cache.snapshotPages(maxPacketsPerPage = 64)
        val snapshot = pages.flatten()
        val entityIds = snapshot.map { packet ->
            when (packet) {
                is ClientboundSetEntityDataPacket -> packet.id()
                is ClientboundSetEquipmentPacket -> packet.entity
                else -> error("Unexpected persistent packet type")
            }
        }.toSet()

        assertTrue(pages.all { it.size <= 64 })
        assertEquals(3_900, snapshot.size)
        assertEquals(1_300, entityIds.size)
        assertTrue(1_299 in entityIds)
        assertTrue(0 in entityIds)
    }

    @Test
    fun `reconfiguration clears persistent surfaces before entity ids can be reused`() {
        val cache = cache(entityCapacity = 2)
        cache.observe(metadata(7, 0, namedStack("old dimension")))

        cache.observe(ClientboundStartConfigurationPacket.INSTANCE)

        assertTrue(cache.snapshot().isEmpty())
        cache.observe(metadata(7, 0, namedStack("new dimension")))
        val value = cache.snapshot().filterIsInstance<ClientboundSetEntityDataPacket>().single()
        assertEquals("new dimension", (value.packedItems().single().value() as ItemStack).itemName.string)
    }

    @Test
    fun `login respawn and reconfiguration each reset dimension-scoped entity ids`() {
        val boundaries = listOf(
            allocateWithoutConstructor(ClientboundLoginPacket::class.java),
            allocateWithoutConstructor(ClientboundRespawnPacket::class.java),
            ClientboundStartConfigurationPacket.INSTANCE,
        )

        boundaries.forEachIndexed { index, boundary ->
            val cache = cache(entityCapacity = 2)
            cache.observe(metadata(7, 0, namedStack("old-$index")))
            cache.observe(boundary)
            assertTrue(cache.snapshot().isEmpty())
        }
    }

    @Test
    fun `persistent byte budgets reject oversized values and preserve prior complete state`() {
        val oversized = NmsPersistentSurfaceCache(
            entityCapacity = 2,
            wireSizer = NmsPersistentWireSizer.fixed(256 * 1_024 + 1),
        )
        assertThrows(NmsPersistentSurfaceIncompleteException::class.java) {
            oversized.observe(metadata(1, 0, namedStack("oversized")))
        }
        assertTrue(oversized.snapshot().isEmpty())

        val aggregate = NmsPersistentSurfaceCache(
            entityCapacity = 64,
            wireSizer = NmsPersistentWireSizer.fixed(200 * 1_024),
        )
        repeat(40) { entityId -> aggregate.observe(metadata(entityId, 0, namedStack("entity-$entityId"))) }
        assertThrows(NmsPersistentSurfaceIncompleteException::class.java) {
            aggregate.observe(metadata(40, 0, namedStack("entity-40")))
        }
        val retained = aggregate.snapshot().filterIsInstance<ClientboundSetEntityDataPacket>().map { it.id() }
        assertEquals((0 until 40).toList(), retained)
    }

    @Test
    fun `one observation cannot exceed the aggregate wire work budget`() {
        val cache = NmsPersistentSurfaceCache(
            entityCapacity = 2,
            wireSizer = NmsPersistentWireSizer.fixed(9 * 1_024),
        )
        val packet = ClientboundSetEntityDataPacket(
            1,
            List(256) { id ->
                SynchedEntityData.DataValue(id, EntityDataSerializers.ITEM_STACK, namedStack("item-$id"))
            },
        )

        assertThrows(NmsPersistentSurfaceIncompleteException::class.java) {
            cache.observe(packet)
        }
        assertTrue(cache.snapshot().isEmpty())
    }

    @Test
    fun `metadata and equipment observation reject oversized atomic updates`() {
        val cache = cache(entityCapacity = 2)
        val metadata = ClientboundSetEntityDataPacket(
            1,
            List(257) { id ->
                SynchedEntityData.DataValue(id, EntityDataSerializers.ITEM_STACK, namedStack("item-$id"))
            },
        )
        val equipment = ClientboundSetEquipmentPacket(
            1,
            List(7) { Pair.of(EquipmentSlot.HEAD, namedStack("item-$it")) },
            true,
        )

        assertThrows(NmsPersistentSurfaceIncompleteException::class.java) {
            cache.observe(metadata)
        }
        assertThrows(NmsPersistentSurfaceIncompleteException::class.java) {
            cache.observe(equipment)
        }
        assertTrue(cache.snapshot().isEmpty())
    }

    @Test
    fun `unmanaged replacements delete tracked values and unmanaged entities consume no capacity`() {
        val cache = cache(entityCapacity = 1)
        cache.observe(metadata(7, 0, namedStack("managed metadata")))
        cache.observe(equipment(7, true, EquipmentSlot.HEAD to namedStack("managed equipment")))

        cache.observe(metadata(7, 0, plainStack("plain metadata")))
        cache.observe(equipment(7, true, EquipmentSlot.HEAD to plainStack("plain equipment")))
        assertTrue(cache.snapshot().isEmpty())

        repeat(10) { entityId -> cache.observe(metadata(entityId, 0, plainStack("plain-$entityId"))) }
        cache.observe(metadata(99, 0, namedStack("only managed entity")))
        assertEquals(
            listOf(99),
            cache.snapshot().filterIsInstance<ClientboundSetEntityDataPacket>().map { it.id() },
        )
    }

    @Test
    fun `ghost recipe owns canonical state filters the active menu and handles deletion`() {
        val cache = cache(entityCapacity = 2)
        val managed = namedStack("ghost result")
        val packet = ghostRecipe(containerId = 12, managed)

        cache.observe(packet)
        managed.set(DataComponents.ITEM_NAME, Component.literal("mutated source"))

        assertTrue(cache.snapshot(activeContainerId = 11).filterIsInstance<ClientboundPlaceGhostRecipePacket>().isEmpty())
        val retained = cache.snapshot(activeContainerId = 12)
            .filterIsInstance<ClientboundPlaceGhostRecipePacket>()
            .single()
        val result = (retained.recipeDisplay() as StonecutterRecipeDisplay).result()
            as SlotDisplay.ItemStackSlotDisplay
        assertEquals("ghost result", result.stack().itemName.string)

        cache.observe(ghostRecipe(12, plainStack("unmanaged replacement")))
        assertTrue(cache.snapshot(activeContainerId = 12).isEmpty())

        cache.observe(packet)
        cache.observe(ClientboundContainerClosePacket(12))
        assertTrue(cache.snapshot(activeContainerId = 12).isEmpty())
    }

    @Test
    fun `authoritative recipe book recipe registry and advancement packets are never cached`() {
        val cache = cache(entityCapacity = 2)
        cache.observe(ClientboundRecipeBookAddPacket(emptyList(), true))
        cache.observe(
            ClientboundUpdateRecipesPacket(
                emptyMap(),
                SelectableRecipe.SingleInputSet<StonecutterRecipe>(emptyList()),
            ),
        )
        cache.observe(
            ClientboundUpdateAdvancementsPacket(
                true,
                emptyList(),
                emptySet(),
                emptyMap(),
                false,
            ),
        )

        assertTrue(cache.snapshot().isEmpty())
    }

    @Test
    fun `sanitized fallback removes old coverage without rescanning deep foreign payload`() {
        val cache = cache(entityCapacity = 2)
        cache.observe(metadata(7, 3, namedStack("old managed value")))
        var deep: Component = Component.literal("foreign leaf")
        repeat(300) { deep = Component.empty().append(deep) }
        val sanitized = ClientboundSetEntityDataPacket(
            7,
            listOf(SynchedEntityData.DataValue(3, EntityDataSerializers.COMPONENT, deep)),
        )

        cache.observeSanitizedFallback(sanitized)

        assertTrue(cache.snapshot().isEmpty())
    }

    @Test
    fun `surface revision advances only for committed persistent mutations`() {
        val cache = cache(entityCapacity = 2)
        val initial = cache.revision()

        assertFalse(cache.observe(metadata(7, 3, plainStack("unmanaged"))))
        assertEquals(initial, cache.revision())
        assertFalse(cache.observe(ClientboundRecipeBookAddPacket(emptyList(), true)))
        assertEquals(initial, cache.revision())

        assertTrue(cache.observe(metadata(7, 3, namedStack("managed"))))
        val managedRevision = cache.revision()
        assertEquals(initial + 1, managedRevision)

        assertTrue(cache.observeSanitizedFallback(metadata(7, 3, plainStack("sanitized"))))
        assertEquals(managedRevision + 1, cache.revision())
        assertFalse(cache.observeSanitizedFallback(metadata(7, 3, plainStack("already absent"))))
        assertEquals(managedRevision + 1, cache.revision())
    }

    @Test
    fun `snapshot limits reject incomplete output instead of skipping covered values`() {
        val cache = NmsPersistentSurfaceCache(
            entityCapacity = 2,
            wireSizer = NmsPersistentWireSizer.fixed(64),
            snapshotValueLimit = 1,
        )
        cache.observe(
            ClientboundSetEntityDataPacket(
                7,
                listOf(
                    SynchedEntityData.DataValue(0, EntityDataSerializers.ITEM_STACK, namedStack("one")),
                    SynchedEntityData.DataValue(1, EntityDataSerializers.ITEM_STACK, namedStack("two")),
                ),
            ),
        )

        assertThrows(NmsPersistentSurfaceIncompleteException::class.java) { cache.snapshot() }
    }

    @Test
    fun `unknown wire sizer runtime and linkage failures remain infrastructure failures`() {
        val runtime = IllegalStateException("simulated wire codec invariant")
        val linkage = NoSuchMethodError("simulated wire codec ABI drift")
        listOf<Throwable>(runtime, linkage).forEach { expected ->
            val cache = NmsPersistentSurfaceCache(
                entityCapacity = 2,
                wireSizer = object : NmsPersistentWireSizer {
                    override fun dataValueBytes(source: SynchedEntityData.DataValue<*>): Int = throw expected
                    override fun itemBytes(source: ItemStack): Int = throw expected
                },
            )

            val thrown = assertThrows(expected.javaClass) {
                cache.observe(metadata(1, 0, namedStack("infrastructure")))
            }
            assertSame(expected, thrown)
            assertTrue(cache.snapshot().isEmpty())
        }
    }

    private fun metadata(entityId: Int, dataId: Int, stack: ItemStack): ClientboundSetEntityDataPacket =
        ClientboundSetEntityDataPacket(
            entityId,
            listOf(SynchedEntityData.DataValue(dataId, EntityDataSerializers.ITEM_STACK, stack)),
        )

    private fun cache(entityCapacity: Int): NmsPersistentSurfaceCache = NmsPersistentSurfaceCache(
        entityCapacity = entityCapacity,
        wireSizer = NmsPersistentWireSizer.fixed(64),
        packetSnapshots = NmsPersistentPacketSnapshotter { source ->
            val display = source.recipeDisplay() as StonecutterRecipeDisplay
            val result = display.result() as SlotDisplay.ItemStackSlotDisplay
            NmsPersistentPacketSnapshot(
                ClientboundPlaceGhostRecipePacket(
                    source.containerId(),
                    StonecutterRecipeDisplay(
                        display.input(),
                        SlotDisplay.ItemStackSlotDisplay(result.stack().copy()),
                        display.craftingStation(),
                    ),
                ),
                64,
            )
        },
    )

    private fun equipment(
        entityId: Int,
        sanitize: Boolean,
        vararg slots: kotlin.Pair<EquipmentSlot, ItemStack>,
    ): ClientboundSetEquipmentPacket = ClientboundSetEquipmentPacket(
        entityId,
        slots.map { (slot, stack) -> Pair.of(slot, stack) },
        sanitize,
    )

    private fun namedStack(name: String): ItemStack = ItemStack(Items.PAPER).also { stack ->
        stack.set(DataComponents.ITEM_NAME, Component.literal(name))
        CustomData.set(
            DataComponents.CUSTOM_DATA,
            stack,
            CompoundTag().apply {
                put(NmsCanonicalItemCodec.ROOT_KEY, CompoundTag())
            },
        )
    }

    private fun plainStack(name: String): ItemStack = ItemStack(Items.PAPER).also { stack ->
        stack.set(DataComponents.ITEM_NAME, Component.literal(name))
    }

    private fun ghostRecipe(containerId: Int, result: ItemStack): ClientboundPlaceGhostRecipePacket {
        val empty = SlotDisplay.Empty.INSTANCE
        return ClientboundPlaceGhostRecipePacket(
            containerId,
            StonecutterRecipeDisplay(
                empty,
                SlotDisplay.ItemStackSlotDisplay(result),
                empty,
            ),
        )
    }

    private fun <T> allocateWithoutConstructor(type: Class<T>): T {
        val field = sun.misc.Unsafe::class.java.getDeclaredField("theUnsafe").also { it.trySetAccessible() }
        @Suppress("UNCHECKED_CAST")
        return (field.get(null) as sun.misc.Unsafe).allocateInstance(type) as T
    }

    private companion object {
        @JvmStatic
        @BeforeAll
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
        }
    }
}

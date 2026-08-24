package com.iroselle.itemerness.nms.v26_1_1

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.ItemProjector
import com.iroselle.itemerness.projection.LocaleId
import com.iroselle.itemerness.projection.ProjectionContext
import com.iroselle.itemerness.projection.ProjectionContextSource
import com.iroselle.itemerness.projection.ProjectionGeneration
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.ProjectionRuntime
import com.iroselle.itemerness.projection.RenderedDisplay
import com.iroselle.itemerness.projection.RenderedText
import com.iroselle.itemerness.projection.ViewerProjectionSnapshot
import java.util.Optional
import java.util.UUID
import net.minecraft.SharedConstants
import net.minecraft.core.RegistryAccess
import net.minecraft.core.RegistrySynchronization
import net.minecraft.core.component.DataComponentExactPredicate
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.core.registries.Registries
import net.minecraft.core.particles.ItemParticleOption
import net.minecraft.core.particles.ParticleTypes
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.ListTag
import net.minecraft.nbt.NbtOps
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.HoverEvent
import net.minecraft.network.chat.contents.TranslatableContents
import net.minecraft.network.protocol.Packet
import net.minecraft.network.protocol.configuration.ClientboundRegistryDataPacket
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket
import net.minecraft.network.protocol.game.ClientboundLevelParticlesPacket
import net.minecraft.network.protocol.game.ClientboundMerchantOffersPacket
import net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket
import net.minecraft.network.protocol.game.ClientboundSetEntityDataPacket
import net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket
import net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket
import net.minecraft.network.protocol.game.ClientboundTabListPacket
import net.minecraft.network.protocol.login.ClientboundLoginDisconnectPacket
import net.minecraft.network.protocol.status.ClientboundStatusResponsePacket
import net.minecraft.network.protocol.status.ServerStatus
import net.minecraft.network.syncher.EntityDataSerializers
import net.minecraft.network.syncher.SynchedEntityData
import net.minecraft.server.Bootstrap
import net.minecraft.server.network.Filterable
import net.minecraft.resources.Identifier
import net.minecraft.world.entity.EntityType
import net.minecraft.world.entity.EquipmentSlotGroup
import net.minecraft.world.entity.ai.attributes.AttributeModifier
import net.minecraft.world.entity.ai.attributes.Attributes
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.ItemStackTemplate
import net.minecraft.world.item.Items
import net.minecraft.world.item.component.BundleContents
import net.minecraft.world.item.component.ChargedProjectiles
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.component.ItemContainerContents
import net.minecraft.world.item.component.ItemAttributeModifiers
import net.minecraft.world.item.component.ItemLore
import net.minecraft.world.item.component.Bees
import net.minecraft.world.item.component.TypedEntityData
import net.minecraft.world.item.component.UseRemainder
import net.minecraft.world.item.component.WrittenBookContent
import net.minecraft.world.item.enchantment.ItemEnchantments
import net.minecraft.world.level.block.entity.BeehiveBlockEntity
import net.minecraft.world.level.block.entity.BlockEntityType
import net.minecraft.world.item.trading.ItemCost
import net.minecraft.world.item.trading.MerchantOffer
import net.minecraft.world.item.trading.MerchantOffers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class NmsRemainingOutboundTest {
    @Test
    fun `all four nested item components are projected without mutating their source graph`() {
        val managed = template(canonicalStack())
        val selectedBundle = BundleContents.Mutable(BundleContents(listOf(managed))).also {
            it.toggleSelectedItem(0)
        }.toImmutable()
        val container = ItemContainerContents.fromItems(listOf(ItemStack.EMPTY, canonicalStack()))
        val charged = ChargedProjectiles(listOf(managed))
        val remainder = UseRemainder(managed)
        val outer = ItemStack(Items.STONE).also { stack ->
            stack.set(DataComponents.BUNDLE_CONTENTS, selectedBundle)
            stack.set(DataComponents.CONTAINER, container)
            stack.set(DataComponents.CHARGED_PROJECTILES, charged)
            stack.set(DataComponents.USE_REMAINDER, remainder)
        }
        val packet = ClientboundContainerSetSlotPacket(2, 8, 3, outer)

        val projected = projector().project(packet, VIEWER_ID) as ClientboundContainerSetSlotPacket

        assertNotSame(packet, projected)
        assertEquals(0, projected.item.get(DataComponents.BUNDLE_CONTENTS)?.selectedItemIndex)
        assertProjected(projected.item.get(DataComponents.BUNDLE_CONTENTS)!!.items().single().create())
        assertProjected(projected.item.get(DataComponents.CONTAINER)!!.items[1].orElseThrow().create())
        assertProjected(projected.item.get(DataComponents.CHARGED_PROJECTILES)!!.items().single().create())
        assertProjected(projected.item.get(DataComponents.USE_REMAINDER)!!.convertInto().create())

        assertCanonical(selectedBundle.items().single().create())
        assertCanonical(container.items[1].orElseThrow().create())
        assertCanonical(charged.items().single().create())
        assertCanonical(remainder.convertInto().create())
    }

    @Test
    fun `all direct text component carriers project embedded hover items`() {
        val customName = hoverCarrier("custom")
        val itemName = hoverCarrier("item")
        val lore = hoverCarrier("lore")
        val attributeText = hoverCarrier("attribute")
        val bookRaw = hoverCarrier("book raw")
        val bookFiltered = hoverCarrier("book filtered")
        val modifiers = ItemAttributeModifiers(
            listOf(
                ItemAttributeModifiers.Entry(
                    Attributes.ATTACK_DAMAGE,
                    AttributeModifier(
                        Identifier.fromNamespaceAndPath("itemerness", "carrier-test"),
                        1.0,
                        AttributeModifier.Operation.ADD_VALUE,
                    ),
                    EquipmentSlotGroup.ANY,
                    ItemAttributeModifiers.Display.`override`(attributeText),
                ),
            ),
        )
        val book = WrittenBookContent(
            Filterable.passThrough("Carrier test"),
            "Itemerness",
            0,
            listOf(Filterable(bookRaw, Optional.of(bookFiltered))),
            true,
        )
        val source = ItemStack(Items.STONE).also { stack ->
            stack.set(DataComponents.CUSTOM_NAME, customName)
            stack.set(DataComponents.ITEM_NAME, itemName)
            stack.set(DataComponents.LORE, ItemLore(listOf(lore)))
            stack.set(DataComponents.ATTRIBUTE_MODIFIERS, modifiers)
            stack.set(DataComponents.WRITTEN_BOOK_CONTENT, book)
        }

        val projected = projector().project(
            ClientboundContainerSetSlotPacket(2, 8, 3, source),
            VIEWER_ID,
        ) as ClientboundContainerSetSlotPacket

        assertProjected(shownItem(projected.item.get(DataComponents.CUSTOM_NAME)!!))
        assertProjected(shownItem(projected.item.get(DataComponents.ITEM_NAME)!!))
        assertProjected(shownItem(projected.item.get(DataComponents.LORE)!!.lines.single()))
        val projectedDisplay = projected.item.get(DataComponents.ATTRIBUTE_MODIFIERS)!!
            .modifiers.single().display as ItemAttributeModifiers.Display.OverrideText
        assertProjected(shownItem(projectedDisplay.component()))
        val projectedPage = projected.item.get(DataComponents.WRITTEN_BOOK_CONTENT)!!.pages().single()
        assertProjected(shownItem(projectedPage.raw()))
        assertProjected(shownItem(projectedPage.filtered().orElseThrow()))

        assertCanonical(shownItem(customName))
        assertCanonical(shownItem(itemName))
        assertCanonical(shownItem(lore))
        assertCanonical(shownItem(attributeText))
        assertCanonical(shownItem(bookRaw))
        assertCanonical(shownItem(bookFiltered))
    }

    @Test
    fun `all raw nbt component carriers project nested item compounds`() {
        fun entityPayload(listKey: String): CompoundTag = CompoundTag().apply {
            put(listKey, ListTag().apply { add(encodedCanonicalStack()) })
        }
        val source = ItemStack(Items.STONE).also { stack ->
            stack.set(
                DataComponents.CUSTOM_DATA,
                CustomData.of(CompoundTag().apply { put("nested", encodedCanonicalStack()) }),
            )
            stack.set(DataComponents.BUCKET_ENTITY_DATA, CustomData.of(entityPayload("Inventory")))
            stack.set(
                DataComponents.ENTITY_DATA,
                TypedEntityData.of(EntityType.PIG, entityPayload("HandItems")),
            )
            stack.set(
                DataComponents.BLOCK_ENTITY_DATA,
                TypedEntityData.of(BlockEntityType.CHEST, entityPayload("Items")),
            )
            stack.set(
                DataComponents.BEES,
                Bees(
                    listOf(
                        BeehiveBlockEntity.Occupant(
                            TypedEntityData.of(EntityType.BEE, entityPayload("ArmorItems")),
                            1,
                            2,
                        ),
                    ),
                ),
            )
        }

        val projected = projector().project(
            ClientboundContainerSetSlotPacket(2, 8, 3, source),
            VIEWER_ID,
        ) as ClientboundContainerSetSlotPacket

        assertProjected(
            decodeStack(projected.item.get(DataComponents.CUSTOM_DATA)!!.getUnsafe().get("nested") as CompoundTag),
        )
        assertProjected(firstEncodedItem(projected.item.get(DataComponents.BUCKET_ENTITY_DATA)!!.getUnsafe(), "Inventory"))
        assertProjected(firstEncodedItem(projected.item.get(DataComponents.ENTITY_DATA)!!.getUnsafe(), "HandItems"))
        assertProjected(firstEncodedItem(projected.item.get(DataComponents.BLOCK_ENTITY_DATA)!!.getUnsafe(), "Items"))
        val beeData = projected.item.get(DataComponents.BEES)!!.bees.single().entityData().getUnsafe()
        assertProjected(firstEncodedItem(beeData, "ArmorItems"))

        assertCanonical(decodeStack(source.get(DataComponents.CUSTOM_DATA)!!.getUnsafe().get("nested") as CompoundTag))
        assertCanonical(firstEncodedItem(source.get(DataComponents.ENTITY_DATA)!!.getUnsafe(), "HandItems"))
    }

    @Test
    fun `nested item recursion overflow fails the original packet atomically`() {
        var nested = canonicalStack()
        repeat(17) {
            nested = ItemStack(Items.STONE).also { outer ->
                outer.set(DataComponents.USE_REMAINDER, UseRemainder(template(nested)))
            }
        }
        val packet = ClientboundContainerSetSlotPacket(2, 8, 3, nested)

        assertThrows(IllegalStateException::class.java) {
            projector().project(packet, VIEWER_ID)
        }
    }

    @Test
    fun `cyclic component inside an item fails before its component codec runs`() {
        val cyclicName = Component.literal("cycle")
        cyclicName.append(cyclicName)
        val source = ItemStack(Items.STONE).also { stack ->
            stack.set(DataComponents.CUSTOM_NAME, cyclicName)
        }
        val packet = ClientboundContainerSetSlotPacket(2, 8, 3, source)

        assertThrows(IllegalStateException::class.java) {
            projector().project(packet, VIEWER_ID)
        }
    }

    @Test
    fun `merchant inputs and result are rebuilt while every offer state field is preserved`() {
        val costA = itemCost(canonicalStack())
        val costB = itemCost(canonicalStack(count = 2))
        val offer = MerchantOffer(costA, Optional.of(costB), canonicalStack(), 2, 7, 13, 0.3F, 4).also {
            it.rewardExp = false
            it.specialPriceDiff = -2
            it.ignoreDiscounts = true
        }
        val offers = MerchantOffers().also { it += offer }
        val packet = ClientboundMerchantOffersPacket(5, offers, 3, 21, true, false)

        val projected = projector().project(packet, VIEWER_ID) as ClientboundMerchantOffersPacket
        val projectedOffer = projected.offers.single()

        assertNotSame(packet, projected)
        assertCanonical(packet.offers.single().baseCostA.itemStack())
        assertCanonical(packet.offers.single().costB.orElseThrow().itemStack())
        assertCanonical(packet.offers.single().result)
        assertProjected(projectedOffer.baseCostA.itemStack())
        assertProjected(projectedOffer.costB.orElseThrow().itemStack())
        assertProjected(projectedOffer.result)
        assertEquals(2, projectedOffer.uses)
        assertEquals(7, projectedOffer.maxUses)
        assertEquals(13, projectedOffer.xp)
        assertEquals(0.3F, projectedOffer.priceMultiplier)
        assertEquals(4, projectedOffer.demand)
        assertEquals(-2, projectedOffer.specialPriceDiff)
        assertFalse(projectedOffer.shouldRewardExp())
        assertTrue(projectedOffer.ignoreDiscounts)
        assertEquals(5, projected.containerId)
        assertEquals(3, projected.villagerLevel)
        assertEquals(21, projected.villagerXp)
        assertTrue(projected.showProgress())
        assertFalse(projected.canRestock())
    }

    @Test
    fun `merchant cost matches the stable inventory view without granting a creative capability`() {
        val state = NmsConnectionProjectionState(
            connectionGeneration = 71,
            hasher = { component -> component.value().hashCode() },
            registryAccess = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY),
        )
        val canonical = canonicalStack()
        val offer = MerchantOffer(
            itemCost(canonical),
            Optional.empty(),
            canonical,
            0,
            7,
            1,
            0.0F,
            0,
        )
        val merchantPacket = ClientboundMerchantOffersPacket(
            5,
            MerchantOffers().also { it += offer },
            1,
            0,
            false,
            false,
        )

        val projectedMerchant = projector().project(merchantPacket, VIEWER_ID, state) as ClientboundMerchantOffersPacket
        val projectedCost = projectedMerchant.offers.single().baseCostA
        val projectedResult = projectedMerchant.offers.single().result
        val markerOnlyRestore = state.restoreCreative(projectedCost.itemStack())
        val markerOnlyResultRestore = state.restoreCreative(projectedResult)
        assertTrue(markerOnlyRestore is CreativeRestoreResult.Rejected)
        assertTrue(markerOnlyResultRestore is CreativeRestoreResult.Rejected)
        assertEquals(
            CreativeRejectReason.UNKNOWN_TOKEN,
            (markerOnlyRestore as CreativeRestoreResult.Rejected).reason,
        )
        assertEquals(
            CreativeRejectReason.UNKNOWN_TOKEN,
            (markerOnlyResultRestore as CreativeRestoreResult.Rejected).reason,
        )

        val inventoryPacket = projector().project(
            ClientboundContainerSetSlotPacket(2, 8, 3, canonical),
            VIEWER_ID,
            state,
        ) as ClientboundContainerSetSlotPacket

        assertTrue(projectedCost.test(inventoryPacket.item))
        assertEquals(
            NmsViewTokenCodec.read(projectedCost.itemStack()),
            NmsViewTokenCodec.read(inventoryPacket.item),
        )
        assertEquals(
            "kept",
            inventoryPacket.item.get(DataComponents.CUSTOM_DATA)?.copyTag()?.getString("foreign")?.orElseThrow(),
        )
        assertTrue(state.restoreCreative(inventoryPacket.item) is CreativeRestoreResult.Restored)

        val canonicalWithExtraComponent = canonical.copy().also { stack ->
            stack.set(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, true)
        }
        assertTrue(
            offer.baseCostA.test(canonicalWithExtraComponent),
            "The vanilla positive predicate must accept unrelated inventory components",
        )
        val extraInventoryPacket = projector().project(
            ClientboundContainerSetSlotPacket(2, 9, 3, canonicalWithExtraComponent),
            VIEWER_ID,
            state,
        ) as ClientboundContainerSetSlotPacket

        assertTrue(
            projectedCost.test(extraInventoryPacket.item),
            "Projection must preserve the original positive-subset ItemCost semantics",
        )
        assertEquals(
            NmsViewTokenCodec.read(projectedCost.itemStack()),
            NmsViewTokenCodec.read(extraInventoryPacket.item),
        )
        assertEquals(true, extraInventoryPacket.item.get(DataComponents.ENCHANTMENT_GLINT_OVERRIDE))
        assertTrue(state.restoreCreative(inventoryPacket.item) is CreativeRestoreResult.Restored)
        val restoredExtra = state.restoreCreative(extraInventoryPacket.item) as CreativeRestoreResult.Restored
        assertEquals(true, restoredExtra.stack.get(DataComponents.ENCHANTMENT_GLINT_OVERRIDE))
        assertCanonical(restoredExtra.stack)

        val canonicalWithTooltipComponent = canonical.copy().also { stack ->
            stack.set(DataComponents.ENCHANTMENTS, ItemEnchantments.EMPTY)
        }
        assertTrue(
            offer.baseCostA.test(canonicalWithTooltipComponent),
            "A tooltip-producing extra component is still outside the positive cost predicate",
        )
        val tooltipInventoryPacket = projector().project(
            ClientboundContainerSetSlotPacket(2, 10, 3, canonicalWithTooltipComponent),
            VIEWER_ID,
            state,
        ) as ClientboundContainerSetSlotPacket
        assertTrue(projectedCost.test(tooltipInventoryPacket.item))
        assertEquals(
            NmsViewTokenCodec.read(projectedCost.itemStack()),
            NmsViewTokenCodec.read(tooltipInventoryPacket.item),
            "Tooltip ownership is physical presentation state, not canonical merchant identity",
        )
        assertEquals(ItemEnchantments.EMPTY, tooltipInventoryPacket.item.get(DataComponents.ENCHANTMENTS))
    }

    @Test
    fun `entity metadata projects item particles and hover items through immutable data values`() {
        val item = canonicalStack()
        val itemParticle = ItemParticleOption(ParticleTypes.ITEM, template(canonicalStack()))
        val hoverComponent = Component.translatable(
            "itemerness.test",
            Component.literal("hover").withStyle { style ->
                style.withHoverEvent(HoverEvent.ShowItem(template(canonicalStack())))
            },
        )
        val mutableValues = mutableListOf<SynchedEntityData.DataValue<*>>(
            SynchedEntityData.DataValue(4, EntityDataSerializers.ITEM_STACK, item),
            SynchedEntityData.DataValue(5, EntityDataSerializers.PARTICLE, itemParticle),
            SynchedEntityData.DataValue(6, EntityDataSerializers.COMPONENT, hoverComponent),
            SynchedEntityData.DataValue(7, EntityDataSerializers.OPTIONAL_COMPONENT, Optional.of(hoverComponent)),
            SynchedEntityData.DataValue(8, EntityDataSerializers.PARTICLES, listOf(itemParticle)),
        )
        val packet = ClientboundSetEntityDataPacket(42, mutableValues)

        val projected = projector().project(packet, VIEWER_ID) as ClientboundSetEntityDataPacket

        assertNotSame(packet, projected)
        assertEquals(42, projected.id())
        assertProjected(projected.packedItems()[0].value() as ItemStack)
        assertProjected(((projected.packedItems()[1].value() as ItemParticleOption).item.create()))
        assertProjected(hoverItem(projected.packedItems()[2].value() as Component))
        val optionalComponent = (projected.packedItems()[3].value() as Optional<*>).orElseThrow() as Component
        assertProjected(hoverItem(optionalComponent))
        val particleList = projected.packedItems()[4].value() as List<*>
        assertProjected((particleList.single() as ItemParticleOption).item.create())
        assertCanonical(item)
        assertCanonical(itemParticle.item.create())
        assertCanonical(hoverItem(hoverComponent))
        mutableValues.clear()
        assertEquals(5, projected.packedItems().size)
    }

    @Test
    fun `level particle packet is rebuilt around a projected item template`() {
        val particle = ItemParticleOption(ParticleTypes.ITEM, template(canonicalStack()))
        val packet = ClientboundLevelParticlesPacket(
            particle,
            true,
            false,
            1.0,
            2.0,
            3.0,
            0.1F,
            0.2F,
            0.3F,
            0.4F,
            9,
        )

        val projected = projector().project(packet, VIEWER_ID) as ClientboundLevelParticlesPacket

        assertNotSame(packet, projected)
        assertProjected((projected.particle as ItemParticleOption).item.create())
        assertCanonical(particle.item.create())
        assertTrue(projected.isOverrideLimiter)
        assertFalse(projected.alwaysShow())
        assertEquals(1.0, projected.x)
        assertEquals(2.0, projected.y)
        assertEquals(3.0, projected.z)
        assertEquals(0.1F, projected.xDist)
        assertEquals(0.2F, projected.yDist)
        assertEquals(0.3F, projected.zDist)
        assertEquals(0.4F, projected.maxSpeed)
        assertEquals(9, projected.count)
    }

    @Test
    fun `common decorative component packets project hover items without touching their text`() {
        val component = Component.literal("unchanged text").withStyle { style ->
            style.withHoverEvent(HoverEvent.ShowItem(template(canonicalStack())))
        }
        val packets: List<Packet<*>> = listOf(
            ClientboundSystemChatPacket(component, false),
            ClientboundSetActionBarTextPacket(component),
            ClientboundSetTitleTextPacket(component),
            ClientboundSetSubtitleTextPacket(component),
            ClientboundTabListPacket(component, Component.literal("footer")),
        )

        packets.forEach { packet ->
            val projected = projector().project(packet, VIEWER_ID)
            val projectedComponent = when (projected) {
                is ClientboundSystemChatPacket -> projected.content()
                is ClientboundSetActionBarTextPacket -> projected.text()
                is ClientboundSetTitleTextPacket -> projected.text()
                is ClientboundSetSubtitleTextPacket -> projected.text()
                is ClientboundTabListPacket -> projected.header()
                else -> error("Unexpected projected packet type")
            }
            assertNotSame(packet, projected)
            assertEquals("unchanged text", projectedComponent.string)
            assertProjected(shownItem(projectedComponent))
        }
        assertCanonical(shownItem(component))
    }

    @Test
    fun `status login and registry carriers project every embedded item without leaking canonical nbt`() {
        val component = hoverCarrier("pre-viewer")
        val status = ClientboundStatusResponsePacket(
            ServerStatus(component, Optional.empty(), Optional.empty(), Optional.empty(), true),
        )
        val login = ClientboundLoginDisconnectPacket(component)
        val registryTag = CompoundTag().apply { put("nested", encodedCanonicalStack()) }
        val registry = ClientboundRegistryDataPacket(
            Registries.DIALOG,
            listOf(
                RegistrySynchronization.PackedRegistryEntry(
                    Identifier.fromNamespaceAndPath("itemerness", "carrier"),
                    Optional.of(registryTag),
                ),
            ),
        )
        val projector = projector()

        val projectedStatus = projector.project(status, VIEWER_ID) as ClientboundStatusResponsePacket
        val projectedLogin = projector.project(login, VIEWER_ID) as ClientboundLoginDisconnectPacket
        val projectedRegistry = projector.project(registry, VIEWER_ID) as ClientboundRegistryDataPacket

        assertProjected(shownItem(projectedStatus.status().description()))
        assertProjected(shownItem(projectedLogin.reason()))
        val projectedTag = projectedRegistry.entries().single().data().orElseThrow() as CompoundTag
        assertProjected(decodeStack(projectedTag.get("nested") as CompoundTag))
        assertCanonical(shownItem(component))
        assertCanonical(decodeStack(registryTag.get("nested") as CompoundTag))
    }

    @Test
    fun `unbound status login and registry carriers sanitize canonical state`() {
        val component = hoverCarrier("pre-viewer")
        val registry = ClientboundRegistryDataPacket(
            Registries.DIALOG,
            listOf(
                RegistrySynchronization.PackedRegistryEntry(
                    Identifier.fromNamespaceAndPath("itemerness", "carrier"),
                    Optional.of(CompoundTag().apply { put("nested", encodedCanonicalStack()) }),
                ),
            ),
        )
        val projector = projector()

        val status = projector.projectUnbound(
            ClientboundStatusResponsePacket(
                ServerStatus(component, Optional.empty(), Optional.empty(), Optional.empty(), false),
            ),
        ) as ClientboundStatusResponsePacket
        val login = projector.projectUnbound(ClientboundLoginDisconnectPacket(component)) as ClientboundLoginDisconnectPacket
        val projectedRegistry = projector.projectUnbound(registry) as ClientboundRegistryDataPacket

        assertFalse(itemernessRoot(shownItem(status.status().description())))
        assertFalse(itemernessRoot(shownItem(login.reason())))
        val tag = projectedRegistry.entries().single().data().orElseThrow() as CompoundTag
        assertFalse(itemernessRoot(decodeStack(tag.get("nested") as CompoundTag)))
    }

    @Test
    fun `component recursion overflow fails the original entity packet`() {
        var component: Component = Component.literal("leaf").withStyle { style ->
            style.withHoverEvent(HoverEvent.ShowItem(template(canonicalStack())))
        }
        repeat(33) {
            component = Component.empty().append(component)
        }
        val packet = ClientboundSetEntityDataPacket(
            42,
            listOf(SynchedEntityData.DataValue(6, EntityDataSerializers.COMPONENT, component)),
        )

        assertThrows(IllegalStateException::class.java) {
            projector().project(packet, VIEWER_ID)
        }
    }

    private fun projector(): NmsOutboundPacketProjector =
        NmsOutboundPacketProjector(NmsItemStackProjector(runtime()))

    private fun runtime(): ProjectionRuntime = ProjectionRuntime(
        projector = ItemProjector {
            ProjectionResult.Rendered(
                RenderedDisplay(
                    displayName = RenderedText.plain("Projected item"),
                    lore = listOf(RenderedText.plain("Projected lore")),
                ),
            )
        },
        contexts = ProjectionContextSource { viewerId ->
            if (viewerId != VIEWER_ID) {
                null
            } else {
                ProjectionContext(
                    viewer = ViewerProjectionSnapshot(
                        viewerId = VIEWER_ID,
                        revision = 1,
                        locale = LocaleId("en_us"),
                        theme = ItemKey.parse("itemerness:default"),
                        assetProfile = null,
                    ),
                    generation = ProjectionGeneration(catalogRevision = 1, epoch = 1),
                )
            }
        },
    )

    private fun canonicalStack(count: Int = 1): ItemStack {
        val root = CompoundTag().apply {
            putInt("format", 1)
            putString("id", "itemerness:travel-token")
            putLong("created_against_revision", 1)
            putLong("instance_revision", 0)
            put("data_schemas", CompoundTag().apply { putInt("itemerness:common", 1) })
            put("data", CompoundTag().apply { putInt("example:charges", 3) })
        }
        return ItemStack(Items.PAPER, count).also { stack ->
            stack.set(DataComponents.MAX_STACK_SIZE, 64)
            CustomData.set(
                DataComponents.CUSTOM_DATA,
                stack,
                CompoundTag().apply {
                    put(NmsCanonicalItemCodec.ROOT_KEY, root)
                    putString("foreign", "kept")
                },
            )
            stack.set(DataComponents.ITEM_NAME, Component.literal("[itemerness:travel-token]"))
        }
    }

    private fun itemCost(stack: ItemStack): ItemCost = ItemCost(
        stack.typeHolder(),
        stack.count,
        DataComponentExactPredicate.allOf(stack.componentsPatch.split().added()),
    )

    private fun template(stack: ItemStack): ItemStackTemplate = ItemStackTemplate.fromNonEmptyStack(stack)

    private fun hoverItem(component: Component): ItemStack {
        val contents = component.contents as TranslatableContents
        val argument = contents.args.single() as Component
        val hover = argument.style.hoverEvent as HoverEvent.ShowItem
        return hover.item().create()
    }

    private fun shownItem(component: Component): ItemStack =
        (component.style.hoverEvent as HoverEvent.ShowItem).item().create()

    private fun hoverCarrier(label: String): Component = Component.literal(label).withStyle { style ->
        style.withHoverEvent(HoverEvent.ShowItem(template(canonicalStack())))
    }

    private fun encodedCanonicalStack(): CompoundTag {
        val ops = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)
            .createSerializationContext(NbtOps.INSTANCE)
        return ItemStack.CODEC.encodeStart(ops, canonicalStack()).result().orElseThrow() as CompoundTag
    }

    private fun decodeStack(source: CompoundTag): ItemStack {
        val ops = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)
            .createSerializationContext(NbtOps.INSTANCE)
        return ItemStack.CODEC.parse(ops, source).result().orElseThrow()
    }

    private fun firstEncodedItem(source: CompoundTag, listKey: String): ItemStack =
        decodeStack((source.get(listKey) as ListTag)[0] as CompoundTag)

    private fun assertCanonical(stack: ItemStack) {
        assertTrue(stack.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
    }

    private fun assertProjected(stack: ItemStack) {
        assertFalse(stack.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
        assertEquals("Projected item", stack.get(DataComponents.ITEM_NAME)?.string)
    }

    private fun itemernessRoot(stack: ItemStack): Boolean =
        stack.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true

    private companion object {
        val VIEWER_ID: UUID = UUID.fromString("8115a5ce-b044-4af9-a188-65227be06717")

        @JvmStatic
        @BeforeAll
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
            Items.PAPER.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
            Items.STONE.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
        }
    }
}

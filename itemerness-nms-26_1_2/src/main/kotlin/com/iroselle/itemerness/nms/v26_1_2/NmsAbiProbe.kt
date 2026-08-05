package com.iroselle.itemerness.nms.v26_1_2

import io.papermc.paper.network.ChannelInitializeListener
import io.papermc.paper.network.ChannelInitializeListenerHolder
import io.netty.channel.Channel
import it.unimi.dsi.fastutil.ints.Int2ObjectMap
import net.minecraft.SharedConstants
import net.minecraft.core.Holder
import net.minecraft.core.RegistryAccess
import net.minecraft.core.component.DataComponentExactPredicate
import net.minecraft.core.component.DataComponentPatch
import net.minecraft.core.component.DataComponentType
import net.minecraft.core.component.DataComponents
import net.minecraft.core.component.TypedDataComponent
import net.minecraft.core.particles.ItemParticleOption
import net.minecraft.core.particles.ParticleOptions
import net.minecraft.core.particles.ParticleType
import net.minecraft.nbt.CompoundTag
import net.minecraft.network.Connection
import net.minecraft.network.HandlerNames
import net.minecraft.network.HashedPatchMap
import net.minecraft.network.HashedStack
import net.minecraft.network.chat.ChatType
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.FilterMask
import net.minecraft.network.chat.FontDescription
import net.minecraft.network.chat.HoverEvent
import net.minecraft.network.chat.MessageSignature
import net.minecraft.network.chat.MutableComponent
import net.minecraft.network.chat.SignedMessageBody
import net.minecraft.network.chat.Style
import net.minecraft.network.chat.contents.NbtContents
import net.minecraft.network.chat.contents.ObjectContents
import net.minecraft.network.chat.contents.SelectorContents
import net.minecraft.network.chat.contents.TranslatableContents
import net.minecraft.network.chat.contents.data.DataSource
import net.minecraft.network.protocol.PacketFlow
import net.minecraft.network.protocol.BundlePacket
import net.minecraft.network.protocol.game.ClientboundBundlePacket
import net.minecraft.network.protocol.game.ClientboundCommandSuggestionsPacket
import net.minecraft.network.protocol.game.ClientboundContainerClosePacket
import net.minecraft.network.protocol.game.ClientboundContainerSetContentPacket
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket
import net.minecraft.network.protocol.game.ClientboundDisguisedChatPacket
import net.minecraft.network.protocol.game.ClientboundLevelParticlesPacket
import net.minecraft.network.protocol.game.ClientboundMapItemDataPacket
import net.minecraft.network.protocol.game.ClientboundMerchantOffersPacket
import net.minecraft.network.protocol.game.ClientboundOpenScreenPacket
import net.minecraft.network.protocol.game.ClientboundPlayerChatPacket
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket
import net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket
import net.minecraft.network.protocol.game.ClientboundSetCursorItemPacket
import net.minecraft.network.protocol.game.ClientboundSetEntityDataPacket
import net.minecraft.network.protocol.game.ClientboundSetEquipmentPacket
import net.minecraft.network.protocol.game.ClientboundSetPlayerInventoryPacket
import net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket
import net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket
import net.minecraft.network.protocol.game.ClientboundTabListPacket
import net.minecraft.network.protocol.game.ClientboundUpdateRecipesPacket
import net.minecraft.network.protocol.game.ServerboundContainerClickPacket
import net.minecraft.network.protocol.game.ServerboundSetCreativeModeSlotPacket
import net.minecraft.network.protocol.common.ServerboundCustomClickActionPacket
import net.minecraft.network.syncher.EntityDataSerializer
import net.minecraft.network.syncher.EntityDataSerializers
import net.minecraft.network.syncher.SynchedEntityData
import net.minecraft.resources.Identifier
import net.minecraft.server.MinecraftServer
import net.minecraft.server.PlayerAdvancements
import net.minecraft.server.level.ServerPlayer
import net.minecraft.server.network.ServerConnectionListener
import net.minecraft.server.network.ServerGamePacketListenerImpl
import net.minecraft.util.CompilableString
import net.minecraft.util.HashOps
import net.minecraft.world.inventory.ContainerInput
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.ItemStackTemplate
import net.minecraft.world.item.component.BundleContents
import net.minecraft.world.item.component.ChargedProjectiles
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.component.ItemContainerContents
import net.minecraft.world.item.component.ItemLore
import net.minecraft.world.item.component.UseRemainder
import net.minecraft.world.item.crafting.RecipeManager
import net.minecraft.world.item.crafting.RecipePropertySet
import net.minecraft.world.item.crafting.SelectableRecipe
import net.minecraft.world.item.crafting.StonecutterRecipe
import net.minecraft.stats.ServerRecipeBook
import net.minecraft.world.item.trading.ItemCost
import net.minecraft.world.item.trading.MerchantOffer
import net.minecraft.world.item.trading.MerchantOffers
import net.minecraft.world.inventory.MenuType
import net.minecraft.world.inventory.MerchantMenu
import net.minecraft.world.level.saveddata.maps.MapDecoration
import net.minecraft.world.level.saveddata.maps.MapId

internal object NmsAbiProbe {
    const val MINECRAFT_VERSION = "26.1.2"

    fun verify() {
        val actualVersion = SharedConstants.getCurrentVersion().name()
        check(actualVersion == MINECRAFT_VERSION) {
            "Itemerness NMS adapter requires Minecraft $MINECRAFT_VERSION, found $actualVersion"
        }
        check(HandlerNames.PACKET_HANDLER == "packet_handler") {
            "Unexpected packet handler name: ${HandlerNames.PACKET_HANDLER}"
        }
        listOf(
            "CUSTOM_DATA",
            "ITEM_NAME",
            "CUSTOM_NAME",
            "LORE",
            "TOOLTIP_STYLE",
            "ITEM_MODEL",
            "BUNDLE_CONTENTS",
            "CONTAINER",
            "CHARGED_PROJECTILES",
            "USE_REMAINDER",
        ).forEach { fieldName ->
            check(DataComponents::class.java.getField(fieldName).get(null) is DataComponentType<*>) {
                "Missing data component: $fieldName"
            }
        }
        ItemStack::class.java.getMethod("copy")
        ItemStack::class.java.getMethod("get", DataComponentType::class.java)
        ItemStack::class.java.getMethod("set", DataComponentType::class.java, Any::class.java)
        ItemStack::class.java.getMethod("remove", DataComponentType::class.java)
        ItemStack::class.java.getConstructor(Holder::class.java, Int::class.javaPrimitiveType, DataComponentPatch::class.java)
        CustomData::class.java.getMethod("copyTag")
        CustomData::class.java.getMethod("getUnsafe")
        CustomData::class.java.getMethod(
            "set",
            DataComponentType::class.java,
            ItemStack::class.java,
            CompoundTag::class.java,
        )
        ItemLore::class.java.getConstructor(List::class.java)
        Connection::class.java.getConstructor(PacketFlow::class.java)
        Connection::class.java.getField("channel")
        Connection::class.java.getMethod("getPacketListener")
        MinecraftServer::class.java.getMethod("getServer")
        MinecraftServer::class.java.getMethod("getConnection")
        ServerConnectionListener::class.java.getMethod("getConnections")
        ServerGamePacketListenerImpl::class.java.getField("player")
        ClientboundContainerSetSlotPacket::class.java.getConstructor(
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            ItemStack::class.java,
        )
        ClientboundContainerSetSlotPacket::class.java.getMethod("getContainerId")
        ClientboundContainerSetSlotPacket::class.java.getMethod("getStateId")
        ClientboundContainerSetSlotPacket::class.java.getMethod("getSlot")
        ClientboundContainerSetSlotPacket::class.java.getMethod("getItem")
        ClientboundContainerSetContentPacket::class.java.getConstructor(
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            List::class.java,
            ItemStack::class.java,
        )
        ClientboundContainerSetContentPacket::class.java.getMethod("containerId")
        ClientboundContainerSetContentPacket::class.java.getMethod("stateId")
        ClientboundContainerSetContentPacket::class.java.getMethod("items")
        ClientboundContainerSetContentPacket::class.java.getMethod("carriedItem")
        ClientboundSetCursorItemPacket::class.java.getConstructor(ItemStack::class.java)
        ClientboundSetCursorItemPacket::class.java.getMethod("contents")
        ClientboundSetPlayerInventoryPacket::class.java.getConstructor(
            Int::class.javaPrimitiveType,
            ItemStack::class.java,
        )
        ClientboundSetPlayerInventoryPacket::class.java.getMethod("slot")
        ClientboundSetPlayerInventoryPacket::class.java.getMethod("contents")
        ClientboundSetEquipmentPacket::class.java.getConstructor(Int::class.javaPrimitiveType, List::class.java)
        ClientboundSetEquipmentPacket::class.java.getConstructor(
            Int::class.javaPrimitiveType,
            List::class.java,
            Boolean::class.javaPrimitiveType,
        )
        ClientboundSetEquipmentPacket::class.java.getMethod("getEntity")
        ClientboundSetEquipmentPacket::class.java.getMethod("getSlots")
        NmsEquipmentPacketAccess.verifyAbi()
        NmsContainerMenuAccess.verifyAbi()
        MinecraftServer::class.java.getMethod("getRecipeManager")
        RecipeManager::class.java.getMethod("getSynchronizedItemProperties")
        RecipeManager::class.java.getMethod("getSynchronizedStonecutterRecipes")
        ClientboundUpdateRecipesPacket::class.java.getConstructor(
            Map::class.java,
            SelectableRecipe.SingleInputSet::class.java,
        )
        ServerRecipeBook::class.java.getMethod("sendInitialRecipeBook", ServerPlayer::class.java)
        PlayerAdvancements::class.java.getMethod(
            "flushDirty",
            ServerPlayer::class.java,
            Boolean::class.javaPrimitiveType,
        )
        ClientboundContainerClosePacket::class.java.getMethod("getContainerId")
        NmsPlayerAdvancementsAccess.verifyAbi()
        listOf("getOffers", "getTraderLevel", "getTraderXp", "showProgressBar", "canRestock")
            .forEach { name -> MerchantMenu::class.java.getMethod(name) }
        NmsStructuredCarrierAbi.verify()
        ClientboundBundlePacket::class.java.getConstructor(Iterable::class.java)
        BundlePacket::class.java.getMethod("subPackets")
        ItemStackTemplate::class.java.getConstructor(Holder::class.java, Int::class.javaPrimitiveType, DataComponentPatch::class.java)
        ItemStackTemplate::class.java.getMethod("create")
        ItemStackTemplate::class.java.getMethod("fromNonEmptyStack", ItemStack::class.java)
        BundleContents::class.java.getMethod("items")
        BundleContents::class.java.getMethod("getSelectedItemIndex")
        ItemContainerContents::class.java.getField("items")
        ChargedProjectiles::class.java.getConstructor(List::class.java)
        ChargedProjectiles::class.java.getMethod("items")
        UseRemainder::class.java.getConstructor(ItemStackTemplate::class.java)
        UseRemainder::class.java.getMethod("convertInto")
        NmsNestedComponentAccess.verifyAbi()
        ClientboundMerchantOffersPacket::class.java.getConstructor(
            Int::class.javaPrimitiveType,
            MerchantOffers::class.java,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Boolean::class.javaPrimitiveType,
            Boolean::class.javaPrimitiveType,
        )
        ClientboundMerchantOffersPacket::class.java.getMethod("getOffers")
        MerchantOffer::class.java.getConstructor(
            ItemCost::class.java,
            java.util.Optional::class.java,
            ItemStack::class.java,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
        )
        ItemCost::class.java.getConstructor(Holder::class.java, Int::class.javaPrimitiveType, DataComponentExactPredicate::class.java)
        DataComponentPatch::class.java.getMethod("split")
        DataComponentExactPredicate::class.java.getMethod("allOf", net.minecraft.core.component.DataComponentMap::class.java)
        ClientboundSetEntityDataPacket::class.java.getConstructor(Int::class.javaPrimitiveType, List::class.java)
        SynchedEntityData.DataValue::class.java.getConstructor(
            Int::class.javaPrimitiveType,
            EntityDataSerializer::class.java,
            Any::class.java,
        )
        listOf("ITEM_STACK", "PARTICLE", "PARTICLES", "COMPONENT", "OPTIONAL_COMPONENT").forEach { fieldName ->
            check(EntityDataSerializers::class.java.getField(fieldName).get(null) is EntityDataSerializer<*>) {
                "Missing entity data serializer: $fieldName"
            }
        }
        ClientboundLevelParticlesPacket::class.java.getConstructor(
            ParticleOptions::class.java,
            Boolean::class.javaPrimitiveType,
            Boolean::class.javaPrimitiveType,
            Double::class.javaPrimitiveType,
            Double::class.javaPrimitiveType,
            Double::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Float::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
        )
        ItemParticleOption::class.java.getConstructor(ParticleType::class.java, ItemStackTemplate::class.java)
        HoverEvent.ShowItem::class.java.getConstructor(ItemStackTemplate::class.java)
        HoverEvent.ShowText::class.java.getConstructor(Component::class.java)
        HoverEvent.ShowEntity::class.java.getConstructor(HoverEvent.EntityTooltipInfo::class.java)
        MutableComponent::class.java.getMethod("create", net.minecraft.network.chat.ComponentContents::class.java)
        Style::class.java.getMethod("withHoverEvent", HoverEvent::class.java)
        TranslatableContents::class.java.getConstructor(String::class.java, String::class.java, Array<Any>::class.java)
        SelectorContents::class.java.getMethod("separator")
        NbtContents::class.java.getConstructor(
            CompilableString::class.java,
            Boolean::class.javaPrimitiveType,
            Boolean::class.javaPrimitiveType,
            java.util.Optional::class.java,
            DataSource::class.java,
        )
        ObjectContents::class.java.getMethod("fallback")
        ClientboundSystemChatPacket::class.java.getConstructor(Component::class.java, Boolean::class.javaPrimitiveType)
        ClientboundDisguisedChatPacket::class.java.getConstructor(Component::class.java, ChatType.Bound::class.java)
        ClientboundPlayerChatPacket::class.java.getConstructor(
            Int::class.javaPrimitiveType,
            java.util.UUID::class.java,
            Int::class.javaPrimitiveType,
            MessageSignature::class.java,
            SignedMessageBody.Packed::class.java,
            Component::class.java,
            FilterMask::class.java,
            ChatType.Bound::class.java,
        )
        ChatType.Bound::class.java.getConstructor(Holder::class.java, Component::class.java, java.util.Optional::class.java)
        ClientboundSetActionBarTextPacket::class.java.getConstructor(Component::class.java)
        ClientboundSetTitleTextPacket::class.java.getConstructor(Component::class.java)
        ClientboundSetSubtitleTextPacket::class.java.getConstructor(Component::class.java)
        ClientboundTabListPacket::class.java.getConstructor(Component::class.java, Component::class.java)
        ClientboundOpenScreenPacket::class.java.getConstructor(
            Int::class.javaPrimitiveType,
            MenuType::class.java,
            Component::class.java,
        )
        ClientboundCommandSuggestionsPacket.Entry::class.java.getConstructor(String::class.java, java.util.Optional::class.java)
        ClientboundCommandSuggestionsPacket::class.java.getConstructor(
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            List::class.java,
        )
        MapDecoration::class.java.getConstructor(
            Holder::class.java,
            Byte::class.javaPrimitiveType,
            Byte::class.javaPrimitiveType,
            Byte::class.javaPrimitiveType,
            java.util.Optional::class.java,
        )
        ClientboundMapItemDataPacket::class.java.getConstructor(
            MapId::class.java,
            Byte::class.javaPrimitiveType,
            Boolean::class.javaPrimitiveType,
            java.util.Optional::class.java,
            java.util.Optional::class.java,
        )
        ClientboundPlayerInfoUpdatePacket::class.java.getConstructor(java.util.EnumSet::class.java, List::class.java)
        ClientboundPlayerInfoUpdatePacket.Entry::class.java.getConstructor(
            java.util.UUID::class.java,
            com.mojang.authlib.GameProfile::class.java,
            Boolean::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            net.minecraft.world.level.GameType::class.java,
            Component::class.java,
            Boolean::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            net.minecraft.network.chat.RemoteChatSession.Data::class.java,
        )
        HashedPatchMap::class.java.getConstructor(Map::class.java, Set::class.java)
        HashedPatchMap::class.java.getMethod(
            "create",
            DataComponentPatch::class.java,
            HashedPatchMap.HashGenerator::class.java,
        )
        HashedStack.ActualItem::class.java.getConstructor(
            Holder::class.java,
            Int::class.javaPrimitiveType,
            HashedPatchMap::class.java,
        )
        ServerboundContainerClickPacket::class.java.getConstructor(
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Short::class.javaPrimitiveType,
            Byte::class.javaPrimitiveType,
            ContainerInput::class.java,
            Int2ObjectMap::class.java,
            HashedStack::class.java,
        )
        ServerboundCustomClickActionPacket::class.java.getConstructor(
            Identifier::class.java,
            java.util.Optional::class.java,
        )
        ServerboundCustomClickActionPacket::class.java.getMethod("id")
        ServerboundCustomClickActionPacket::class.java.getMethod("payload")
        ServerboundSetCreativeModeSlotPacket::class.java.getConstructor(
            Short::class.javaPrimitiveType,
            ItemStack::class.java,
        )
        RegistryAccess::class.java.getMethod(
            "createSerializationContext",
            com.mojang.serialization.DynamicOps::class.java,
        )
        TypedDataComponent::class.java.getMethod(
            "encodeValue",
            com.mojang.serialization.DynamicOps::class.java,
        )
        HashOps::class.java.getField("CRC32C_INSTANCE")
        ChannelInitializeListenerHolder::class.java.getMethod(
            "hasListener",
            net.kyori.adventure.key.Key::class.java,
        )
        ChannelInitializeListenerHolder::class.java.getMethod(
            "addListener",
            net.kyori.adventure.key.Key::class.java,
            ChannelInitializeListener::class.java,
        )
        ChannelInitializeListenerHolder::class.java.getMethod(
            "removeListener",
            net.kyori.adventure.key.Key::class.java,
        )
        ChannelInitializeListener::class.java.getMethod("afterInitChannel", Channel::class.java)
        Component::class.java.getMethod("literal", String::class.java)
        FontDescription.Resource::class.java.getConstructor(Identifier::class.java)
        Style::class.java.getMethod("withFont", FontDescription::class.java)
        Identifier::class.java.getMethod(
            "fromNamespaceAndPath",
            String::class.java,
            String::class.java,
        )
        Identifier::class.java.getMethod("parse", String::class.java)
    }
}

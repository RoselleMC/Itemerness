package com.iroselle.itemerness.nms.v26_1_2

import io.papermc.paper.network.ChannelInitializeListener
import io.papermc.paper.network.ChannelInitializeListenerHolder
import io.netty.channel.Channel
import net.minecraft.SharedConstants
import net.minecraft.core.component.DataComponentType
import net.minecraft.core.component.DataComponents
import net.minecraft.nbt.CompoundTag
import net.minecraft.network.Connection
import net.minecraft.network.HandlerNames
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.FontDescription
import net.minecraft.network.chat.Style
import net.minecraft.network.protocol.PacketFlow
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket
import net.minecraft.resources.Identifier
import net.minecraft.server.MinecraftServer
import net.minecraft.server.network.ServerConnectionListener
import net.minecraft.server.network.ServerGamePacketListenerImpl
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.component.ItemLore

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
        ).forEach { fieldName ->
            check(DataComponents::class.java.getField(fieldName).get(null) is DataComponentType<*>) {
                "Missing data component: $fieldName"
            }
        }
        ItemStack::class.java.getMethod("copy")
        ItemStack::class.java.getMethod("get", DataComponentType::class.java)
        ItemStack::class.java.getMethod("set", DataComponentType::class.java, Any::class.java)
        ItemStack::class.java.getMethod("remove", DataComponentType::class.java)
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

package com.iroselle.itemerness.nms.v1_21_11

import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalBridgeDescriptor
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridgeFactory
import com.iroselle.itemerness.bukkit.spi.CanonicalItemInspection
import com.iroselle.itemerness.bukkit.spi.PendingItemName
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.projection.MinecraftVersion
import org.bukkit.inventory.ItemStack

class NmsBukkitCanonicalItemBridgeFactory : BukkitCanonicalItemBridgeFactory {
    override val descriptor: BukkitCanonicalBridgeDescriptor = DESCRIPTOR

    override fun create(): BukkitCanonicalItemBridge = NmsBukkitCanonicalItemBridge(descriptor)

    private companion object {
        val DESCRIPTOR = BukkitCanonicalBridgeDescriptor(
            id = ItemKey.parse("itemerness:nms-1_21_11-bukkit-bridge"),
            minecraftVersion = MinecraftVersion(NmsAbiProbe.MINECRAFT_VERSION),
        )
    }
}

private class NmsBukkitCanonicalItemBridge(
    override val descriptor: BukkitCanonicalBridgeDescriptor,
) : BukkitCanonicalItemBridge {
    private val codec = NmsCanonicalItemCodec()

    override fun create(
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
        amount: Int,
    ): ItemStack = codec.create(definition, instance, pendingName, amount).asBukkitCopy()

    override fun rewrite(
        source: ItemStack,
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
    ): ItemStack = codec.rewrite(
        net.minecraft.world.item.ItemStack.fromBukkitCopy(source),
        definition,
        instance,
        pendingName,
    ).asBukkitCopy()

    override fun inspect(source: ItemStack): CanonicalItemInspection = when (
        val result = codec.decode(net.minecraft.world.item.ItemStack.fromBukkitCopy(source))
    ) {
        CanonicalDecodeResult.Missing -> CanonicalItemInspection.Unmanaged
        is CanonicalDecodeResult.Invalid -> CanonicalItemInspection.InvalidManaged(result.reason)
        is CanonicalDecodeResult.Decoded -> CanonicalItemInspection.Managed(result.snapshot)
    }

    override fun canonicalSnbt(source: ItemStack): String? =
        codec.canonicalSnbt(net.minecraft.world.item.ItemStack.fromBukkitCopy(source))
}

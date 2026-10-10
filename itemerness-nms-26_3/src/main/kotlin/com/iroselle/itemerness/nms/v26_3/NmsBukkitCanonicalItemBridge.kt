package com.iroselle.itemerness.nms.v26_3

import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalBridgeDescriptor
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridgeFactory
import com.iroselle.itemerness.bukkit.spi.CanonicalItemInspection
import com.iroselle.itemerness.bukkit.spi.PendingItemName
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.projection.MinecraftVersion
import org.bukkit.craftbukkit.inventory.CraftItemStack
import org.bukkit.inventory.ItemStack

class NmsBukkitCanonicalItemBridgeFactory : BukkitCanonicalItemBridgeFactory {
    override val descriptor: BukkitCanonicalBridgeDescriptor = DESCRIPTOR

    override fun create(): BukkitCanonicalItemBridge = NmsBukkitCanonicalItemBridge(descriptor)

    private companion object {
        val DESCRIPTOR = BukkitCanonicalBridgeDescriptor(
            id = ItemKey.parse("itemerness:nms-26_3-bukkit-bridge"),
            minecraftVersion = MinecraftVersion(NmsAbiProbe.MINECRAFT_VERSION),
        )
    }
}

/**
 * Paper 26.3 removed the ItemStack.asBukkitCopy/fromBukkitCopy convenience bridges. CraftItemStack
 * keeps the same copy-in/copy-out semantics, so neither mutable stack escapes this bridge.
 */
private class NmsBukkitCanonicalItemBridge(
    override val descriptor: BukkitCanonicalBridgeDescriptor,
) : BukkitCanonicalItemBridge {
    private val codec = NmsCanonicalItemCodec()

    override fun create(
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
        amount: Int,
    ): ItemStack = CraftItemStack.asBukkitCopy(codec.create(definition, instance, pendingName, amount))

    override fun rewrite(
        source: ItemStack,
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        pendingName: PendingItemName,
    ): ItemStack = CraftItemStack.asBukkitCopy(
        codec.rewrite(
            CraftItemStack.asNMSCopy(source),
            definition,
            instance,
            pendingName,
        ),
    )

    override fun inspect(source: ItemStack): CanonicalItemInspection = when (
        val result = codec.decode(CraftItemStack.asNMSCopy(source))
    ) {
        CanonicalDecodeResult.Missing -> CanonicalItemInspection.Unmanaged
        is CanonicalDecodeResult.Invalid -> CanonicalItemInspection.InvalidManaged(result.reason)
        is CanonicalDecodeResult.Decoded -> CanonicalItemInspection.Managed(result.snapshot)
    }

    override fun canonicalSnbt(source: ItemStack): String? =
        codec.canonicalSnbt(CraftItemStack.asNMSCopy(source))
}

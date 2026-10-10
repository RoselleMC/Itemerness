package com.iroselle.itemerness.nms.v26_3

import net.minecraft.core.component.DataComponentType
import net.minecraft.core.component.DataComponents
import net.minecraft.world.item.Item
import net.minecraft.world.item.ItemStack

/** Exact 26.3 proof for taking ownership of every non-name vanilla tooltip line. */
internal object NmsVanillaTooltipLines {
    fun canManage(source: ItemStack): Boolean {
        // Item subclasses can append arbitrary lines before ItemStack processes data components.
        if (source.item.javaClass != Item::class.java) return false
        return source.components.keySet().none(UNMANAGED_COMPONENTS::contains)
    }

    /**
     * Components consulted by ItemStack.addDetailsToTooltip that can emit an independent line in
     * 26.3; an ABI test derives the same set from the mapped bytecode. LORE is intentionally
     * absent because projection replaces it atomically. ITEM_NAME, RARITY, ITEM_MODEL,
     * CUSTOM_DATA and the model/stack behaviour components do not add an independent detail
     * line. CUSTOM_NAME is rejected even though sanitization removes it, so a forged name can
     * never qualify a stack for fixed-geometry tooltip ownership.
     */
    internal val UNMANAGED_COMPONENTS: Set<DataComponentType<*>> = setOf(
        DataComponents.CUSTOM_NAME,
        DataComponents.TROPICAL_FISH_PATTERN,
        DataComponents.INSTRUMENT,
        DataComponents.MAP_ID,
        DataComponents.BEES,
        DataComponents.CONTAINER_LOOT,
        DataComponents.CONTAINER,
        DataComponents.BANNER_PATTERNS,
        DataComponents.POT_DECORATIONS,
        DataComponents.WRITTEN_BOOK_CONTENT,
        DataComponents.CHARGED_PROJECTILES,
        DataComponents.FIREWORKS,
        DataComponents.FIREWORK_EXPLOSION,
        DataComponents.POTION_CONTENTS,
        DataComponents.JUKEBOX_PLAYABLE,
        DataComponents.TRIM,
        DataComponents.STORED_ENCHANTMENTS,
        DataComponents.ENCHANTMENTS,
        DataComponents.DYED_COLOR,
        DataComponents.PROFILE,
        DataComponents.SULFUR_CUBE_CONTENT,
        DataComponents.ATTRIBUTE_MODIFIERS,
        DataComponents.INTANGIBLE_PROJECTILE,
        DataComponents.UNBREAKABLE,
        // 26.3 renders sign text carried by sign items as independent tooltip lines.
        DataComponents.SIGN_TEXT_FRONT,
        DataComponents.SIGN_TEXT_BACK,
        DataComponents.OMINOUS_BOTTLE_AMPLIFIER,
        DataComponents.SUSPICIOUS_STEW_EFFECTS,
        DataComponents.BLOCK_STATE,
        DataComponents.ENTITY_DATA,
        DataComponents.BLOCK_ENTITY_DATA,
        DataComponents.CAN_BREAK,
        DataComponents.CAN_PLACE_ON,
        DataComponents.DAMAGE,
    )
}

package com.iroselle.itemerness.core.catalog

import com.iroselle.itemerness.api.ItemKey
import java.util.Collections

/**
 * Closed, platform-neutral forms of vanilla components that Itemerness can validate and apply.
 * Presentation-owned and canonical identity components deliberately have no representation here.
 */
sealed interface BaseItemComponent {
    data class MaxStackSize(val value: Int) : BaseItemComponent

    data class MaxDamage(val value: Int) : BaseItemComponent

    data class Damage(val value: Int) : BaseItemComponent

    data object Unbreakable : BaseItemComponent

    data class EnchantmentGlintOverride(val value: Boolean) : BaseItemComponent

    data class ItemModel(val value: ItemKey) : BaseItemComponent

    data class Rarity(val value: VanillaRarity) : BaseItemComponent

    data class RepairCost(val value: Int) : BaseItemComponent

    class CustomModelData(
        floats: Collection<Float>,
        flags: Collection<Boolean>,
        strings: Collection<String>,
        colorsRgb: Collection<Int>,
    ) : BaseItemComponent {
        val floats: List<Float> = java.util.List.copyOf(floats)
        val flags: List<Boolean> = java.util.List.copyOf(flags)
        val strings: List<String> = java.util.List.copyOf(strings)
        val colorsRgb: List<Int> = java.util.List.copyOf(colorsRgb)
    }

    data class Food(
        val nutrition: Int,
        val saturation: Float,
        val canAlwaysEat: Boolean,
    ) : BaseItemComponent

    data class UseCooldown(
        val seconds: Float,
        val group: ItemKey?,
    ) : BaseItemComponent

    data class Consumable(
        val consumeSeconds: Float,
        val animation: VanillaUseAnimation,
        val sound: ItemKey,
        val hasConsumeParticles: Boolean,
    ) : BaseItemComponent
}

enum class VanillaRarity {
    COMMON,
    UNCOMMON,
    RARE,
    EPIC,
}

enum class VanillaUseAnimation {
    NONE,
    EAT,
    DRINK,
    BLOCK,
    BOW,
    TRIDENT,
    CROSSBOW,
    SPYGLASS,
    TOOT_HORN,
    BRUSH,
    BUNDLE,
    SPEAR,
}

data class ItemContentDefinition(
    val item: ItemKey,
    val amount: Int,
)

internal fun <T> immutableList(source: Collection<T>): List<T> =
    Collections.unmodifiableList(ArrayList(source))

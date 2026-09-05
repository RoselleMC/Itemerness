package com.iroselle.itemerness.bukkit.catalog

import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.PendingItemName
import com.iroselle.itemerness.core.catalog.BaseItemComponent
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.CatalogSnapshot
import com.iroselle.itemerness.core.catalog.NestedContentComponent
import com.iroselle.itemerness.core.catalog.VanillaRarity
import com.iroselle.itemerness.core.catalog.VanillaUseAnimation
import io.papermc.paper.datacomponent.DataComponentTypes
import io.papermc.paper.datacomponent.item.BundleContents
import io.papermc.paper.datacomponent.item.Consumable
import io.papermc.paper.datacomponent.item.CustomModelData
import io.papermc.paper.datacomponent.item.FoodProperties
import io.papermc.paper.datacomponent.item.ItemContainerContents
import io.papermc.paper.datacomponent.item.UseCooldown
import io.papermc.paper.datacomponent.item.consumable.ItemUseAnimation
import net.kyori.adventure.key.Key
import org.bukkit.Color
import org.bukkit.NamespacedKey
import io.papermc.paper.datacomponent.item.ItemEnchantments
import io.papermc.paper.datacomponent.item.ItemAttributeModifiers
import io.papermc.paper.registry.RegistryAccess
import io.papermc.paper.registry.RegistryKey
import org.bukkit.inventory.ItemRarity
import org.bukkit.inventory.ItemStack

/** Materializes a bounded canonical item tree, leaving all viewer presentation to projection. */
internal class BukkitCatalogItemFactory(
    private val bridge: BukkitCanonicalItemBridge,
    private val catalog: CatalogSnapshot,
    private val pendingName: (ItemKey) -> PendingItemName,
    private val componentWriter: BukkitItemComponentWriter = PaperBukkitItemComponentWriter,
) {
    fun create(
        definition: ItemDefinition,
        instance: CanonicalItemInstance,
        amount: Int,
    ): ItemStack {
        require(amount > 0) { "Amount must be positive" }
        require(instance.itemKey == definition.key) {
            "Instance ${instance.itemKey} does not belong to ${definition.key}"
        }
        require(definition.instanceMode != ItemInstanceMode.UNIQUE || amount == 1) {
            "A unique item instance cannot be stacked"
        }
        val compiled = definition as? CatalogItemDefinition
            ?: error("The active item definition does not expose compiled catalog semantics")
        val budget = CreationBudget()
        return materialize(compiled, instance, amount, depth = 1, budget)
    }

    private fun materialize(
        definition: CatalogItemDefinition,
        instance: CanonicalItemInstance,
        amount: Int,
        depth: Int,
        budget: CreationBudget,
    ): ItemStack {
        budget.visit(depth)
        val stack = bridge.create(definition, instance, pendingName(definition.key), 1)
        componentWriter.applyBase(stack, definition.baseComponents)
        if (definition.contents.isNotEmpty()) {
            val children = ArrayList<ItemStack>()
            definition.contents.forEach { content ->
                val childDefinition = catalog.findItem(content.item) as? CatalogItemDefinition
                    ?: error("Nested item ${content.item} is not enabled in the active catalog")
                when (childDefinition.instanceMode) {
                    ItemInstanceMode.UNIQUE -> repeat(content.amount) {
                        children += materialize(
                            childDefinition,
                            catalog.createInstance(childDefinition.key),
                            amount = 1,
                            depth = depth + 1,
                            budget = budget,
                        )
                    }
                    ItemInstanceMode.FUNGIBLE -> {
                        val child = materialize(
                            childDefinition,
                            catalog.createInstance(childDefinition.key),
                            amount = 1,
                            depth = depth + 1,
                            budget = budget,
                        )
                        splitAmounts(content.amount, child.maxStackSize).forEachIndexed { index, childAmount ->
                            if (index > 0) budget.visit(depth + 1)
                            children += child.clone().also { it.amount = childAmount }
                        }
                    }
                }
            }
            componentWriter.applyContents(
                stack,
                requireNotNull(definition.contentComponent) { "Nested item ${definition.key} has no content component" },
                children,
            )
        }
        require(amount <= stack.maxStackSize) {
            "Amount $amount exceeds the effective maximum stack size ${stack.maxStackSize} for ${definition.key}"
        }
        stack.amount = amount
        return stack
    }

    private class CreationBudget {
        private var itemStacks = 0

        fun visit(depth: Int) {
            require(depth <= MAX_DEPTH) { "Nested item depth exceeds the hard limit of $MAX_DEPTH" }
            itemStacks++
            require(itemStacks <= MAX_ITEM_STACKS) { "Nested item count exceeds the hard limit of $MAX_ITEM_STACKS" }
        }
    }

    private companion object {
        const val MAX_DEPTH = 8
        const val MAX_ITEM_STACKS = 256
    }
}

internal interface BukkitItemComponentWriter {
    fun applyBase(stack: ItemStack, components: List<BaseItemComponent>)

    fun applyContents(stack: ItemStack, component: NestedContentComponent, children: List<ItemStack>)
}

internal object PaperBukkitItemComponentWriter : BukkitItemComponentWriter {
    override fun applyBase(
        stack: ItemStack,
        components: List<BaseItemComponent>,
    ) {
        components.forEach { component ->
            when (component) {
                is BaseItemComponent.MaxStackSize -> stack.setData(DataComponentTypes.MAX_STACK_SIZE, component.value)
                is BaseItemComponent.MaxDamage -> stack.setData(DataComponentTypes.MAX_DAMAGE, component.value)
                is BaseItemComponent.Damage -> stack.setData(DataComponentTypes.DAMAGE, component.value)
                BaseItemComponent.Unbreakable -> stack.setData(DataComponentTypes.UNBREAKABLE)
                is BaseItemComponent.EnchantmentGlintOverride ->
                    stack.setData(DataComponentTypes.ENCHANTMENT_GLINT_OVERRIDE, component.value)
                is BaseItemComponent.ItemModel -> stack.setData(DataComponentTypes.ITEM_MODEL, component.value.adventureKey())
                is BaseItemComponent.Rarity -> stack.setData(DataComponentTypes.RARITY, component.value.bukkitValue())
                is BaseItemComponent.RepairCost -> stack.setData(DataComponentTypes.REPAIR_COST, component.value)
                BaseItemComponent.EmptyAttributeModifiers -> stack.setData(
                    DataComponentTypes.ATTRIBUTE_MODIFIERS,
                    ItemAttributeModifiers.itemAttributes(),
                )
                is BaseItemComponent.Enchantments -> stack.setData(
                    DataComponentTypes.ENCHANTMENTS,
                    ItemEnchantments.itemEnchantments(
                        component.levels.mapKeys { (key, _) ->
                            checkNotNull(
                                RegistryAccess.registryAccess()
                                    .getRegistry(RegistryKey.ENCHANTMENT)
                                    .get(NamespacedKey(key.namespace, key.value)),
                            ) { "Unknown enchantment $key" }
                        },
                    ),
                )
                is BaseItemComponent.CustomModelData -> stack.setData(
                    DataComponentTypes.CUSTOM_MODEL_DATA,
                    CustomModelData.customModelData()
                        .addFloats(component.floats)
                        .addFlags(component.flags)
                        .addStrings(component.strings)
                        .addColors(component.colorsRgb.map(Color::fromRGB)),
                )
                is BaseItemComponent.Food -> stack.setData(
                    DataComponentTypes.FOOD,
                    FoodProperties.food()
                        .nutrition(component.nutrition)
                        .saturation(component.saturation)
                        .canAlwaysEat(component.canAlwaysEat),
                )
                is BaseItemComponent.UseCooldown -> stack.setData(
                    DataComponentTypes.USE_COOLDOWN,
                    UseCooldown.useCooldown(component.seconds).cooldownGroup(component.group?.adventureKey()),
                )
                is BaseItemComponent.Consumable -> stack.setData(
                    DataComponentTypes.CONSUMABLE,
                    Consumable.consumable()
                        .consumeSeconds(component.consumeSeconds)
                        .animation(component.animation.bukkitValue())
                        .sound(component.sound.adventureKey())
                        .hasConsumeParticles(component.hasConsumeParticles),
                )
            }
        }
    }

    override fun applyContents(
        stack: ItemStack,
        component: NestedContentComponent,
        children: List<ItemStack>,
    ) {
        when (component) {
            NestedContentComponent.BUNDLE -> stack.setData(
                DataComponentTypes.BUNDLE_CONTENTS,
                BundleContents.bundleContents(children),
            )
            NestedContentComponent.CONTAINER -> stack.setData(
                DataComponentTypes.CONTAINER,
                ItemContainerContents.containerContents(children),
            )
        }
    }
}

private fun ItemKey.adventureKey(): Key = Key.key(namespace, value)

private fun VanillaRarity.bukkitValue(): ItemRarity = ItemRarity.valueOf(name)

private fun VanillaUseAnimation.bukkitValue(): ItemUseAnimation = ItemUseAnimation.valueOf(name)

private fun splitAmounts(amount: Int, maximum: Int): List<Int> {
    require(amount > 0 && maximum > 0)
    val result = ArrayList<Int>()
    var remaining = amount
    while (remaining > 0) {
        val next = minOf(remaining, maximum)
        result += next
        remaining -= next
    }
    return result
}

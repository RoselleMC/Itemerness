package com.iroselle.itemerness.nms.v26_1_2

import java.util.Optional
import net.minecraft.core.Holder
import net.minecraft.core.HolderLookup
import net.minecraft.core.HolderSet
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.core.Registry
import net.minecraft.data.registries.VanillaRegistries
import net.minecraft.resources.Identifier
import net.minecraft.resources.ResourceKey
import net.minecraft.tags.TagKey
import net.minecraft.world.entity.EquipmentSlotGroup
import net.minecraft.world.entity.ai.attributes.AttributeModifier
import net.minecraft.world.entity.ai.attributes.Attributes
import net.minecraft.world.item.Items
import net.minecraft.world.item.component.ItemAttributeModifiers

/** Frozen vanilla registries for standalone tests, standing in for a running server's registries. */
internal object NmsTestRegistries {
    val lookup: HolderLookup.Provider by lazy {
        val base = VanillaRegistries.createLookup()
        bindEmptyTags(base)
        withoutTags(base)
    }

    val probe: NmsTooltipLineProbe by lazy { NmsTooltipLineProbe { lookup } }

    val codec: NmsCanonicalItemCodec by lazy { NmsCanonicalItemCodec(probe) }

    private val prototypes: Boolean by lazy {
        // Standalone tests skip the server's data-driven item component binding. A sword-like
        // prototype keeps prototype-default components exercised; other items get empty ones.
        Items.DIAMOND_SWORD.builtInRegistryHolder().bindComponents(
            DataComponentMap.builder()
                .set(DataComponents.MAX_STACK_SIZE, 1)
                .set(DataComponents.MAX_DAMAGE, 1561)
                .set(DataComponents.DAMAGE, 0)
                .set(
                    DataComponents.ATTRIBUTE_MODIFIERS,
                    ItemAttributeModifiers.builder().add(
                        Attributes.ATTACK_DAMAGE,
                        AttributeModifier(
                            Identifier.parse("minecraft:base_attack_damage"),
                            6.0,
                            AttributeModifier.Operation.ADD_VALUE,
                        ),
                        EquipmentSlotGroup.MAINHAND,
                    ).build(),
                )
                .build(),
        )
        BuiltInRegistries.ITEM.forEach { item ->
            runCatching { item.builtInRegistryHolder().components() }
                .onFailure { item.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY) }
        }
        true
    }

    fun bindItemPrototypes() {
        check(prototypes)
    }

    /** Data-generation registries have no bound tags; a server binds them during data load. */
    private fun bindEmptyTags(provider: HolderLookup.Provider) {
        val bindTags = Holder.Reference::class.java.getDeclaredMethod("bindTags", Collection::class.java)
            .apply { isAccessible = true }
        provider.listRegistryKeys().forEach { key ->
            provider.lookup(key).ifPresent { registry ->
                registry.listElements().forEach { holder ->
                    runCatching { holder.tags() }.onFailure { bindTags.invoke(holder, emptyList<Any>()) }
                }
            }
        }
    }

    /** Tag lookups only order some lines; resolving them as empty keeps line presence exact. */
    private fun withoutTags(base: HolderLookup.Provider): HolderLookup.Provider = object : HolderLookup.Provider {
        override fun listRegistryKeys() = base.listRegistryKeys()

        override fun <T : Any> lookup(
            key: ResourceKey<out Registry<out T>>,
        ): Optional<out HolderLookup.RegistryLookup<T>> = base.lookup(key).map { parent ->
            object : HolderLookup.RegistryLookup.Delegate<T> {
                override fun parent(): HolderLookup.RegistryLookup<T> = parent

                override fun get(tag: TagKey<T>): Optional<HolderSet.Named<T>> = Optional.empty()
            }
        }
    }
}

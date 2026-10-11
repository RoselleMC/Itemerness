package com.iroselle.itemerness.nms.v1_21_11

import java.util.Optional
import net.minecraft.core.Holder
import net.minecraft.core.HolderLookup
import net.minecraft.core.HolderSet
import net.minecraft.core.Registry
import net.minecraft.data.registries.VanillaRegistries
import net.minecraft.resources.ResourceKey
import net.minecraft.tags.TagKey

/** Frozen vanilla registries for standalone tests, standing in for a running server's registries. */
internal object NmsTestRegistries {
    val lookup: HolderLookup.Provider by lazy {
        val base = VanillaRegistries.createLookup()
        bindEmptyTags(base)
        withoutTags(base)
    }

    val probe: NmsTooltipLineProbe by lazy { NmsTooltipLineProbe { lookup } }

    val codec: NmsCanonicalItemCodec by lazy { NmsCanonicalItemCodec(probe) }

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

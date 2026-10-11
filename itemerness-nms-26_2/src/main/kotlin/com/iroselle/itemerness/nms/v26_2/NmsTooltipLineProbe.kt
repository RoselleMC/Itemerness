package com.iroselle.itemerness.nms.v26_2

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.TooltipLineEvidence
import java.util.TreeSet
import java.util.concurrent.ConcurrentHashMap
import java.util.function.Consumer
import net.minecraft.core.HolderLookup
import net.minecraft.core.component.DataComponentPatch
import net.minecraft.core.component.DataComponentType
import net.minecraft.core.component.DataComponents
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.network.chat.Component
import net.minecraft.server.MinecraftServer
import net.minecraft.world.entity.player.Player
import net.minecraft.world.item.Item
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.TooltipFlag
import net.minecraft.world.item.component.TooltipDisplay
import net.minecraft.world.level.saveddata.maps.MapId
import net.minecraft.world.level.saveddata.maps.MapItemSavedData

/**
 * Decides which data components emit vanilla tooltip lines by running the exact 26.2 tooltip
 * builder, instead of maintaining a hand-written component list that silently drifts.
 *
 * The probe only reads frozen registries and immutable component values, so it is safe on Netty
 * event loops. It never mutates the stack and never touches Bukkit or world state; anything that
 * would need client or world state is treated as emitting (fail closed).
 */
internal class NmsTooltipLineProbe(
    private val registries: () -> HolderLookup.Provider?,
) {
    /**
     * Evidence depends only on the registries, the item and its component patch. Custom data is
     * projection-owned and hidden in every probe, so it is excluded from the key; per-instance
     * canonical data would otherwise defeat the cache.
     */
    private val cache = ConcurrentHashMap<CacheKey, TooltipLineEvidence>()

    fun evidence(source: ItemStack): TooltipLineEvidence {
        if (!eligible(source)) return TooltipLineEvidence.BLOCKED
        val provider = provider() ?: return TooltipLineEvidence.BLOCKED
        val patch = source.componentsPatch.forget { type -> type === DataComponents.CUSTOM_DATA }
        val key = CacheKey(provider, source.item, patch)
        cache[key]?.let { cached -> return cached }
        val evidence = measure(source, provider)?.evidence() ?: TooltipLineEvidence.BLOCKED
        if (cache.size >= MAX_CACHE_ENTRIES) cache.clear()
        cache[key] = evidence
        return evidence
    }

    private fun eligible(source: ItemStack): Boolean =
        // An item class that replaces appendHoverText can append arbitrary lines before ItemStack
        // processes data components. Subclasses that only change behaviour, such as forks that
        // swap vanilla swords for their own class, stay eligible. Sanitization removes
        // CUSTOM_NAME, but a forged name must never qualify a stack for fixed-geometry ownership.
        !appendsHoverText(source.item.javaClass) && !source.has(DataComponents.CUSTOM_NAME)

    // Instrument and jukebox lines silently disappear without registries; never mistake that for
    // a silent stack.
    private fun provider(): HolderLookup.Provider? = try {
        registries()
    } catch (_: RuntimeException) {
        null
    }

    private data class CacheKey(
        val registries: HolderLookup.Provider,
        val item: Item,
        val patch: DataComponentPatch,
    )

    /** Uncached raw line counts; null when the stack is blocked before per-component attribution. */
    internal fun measure(source: ItemStack): Measurement? {
        if (!eligible(source)) return null
        return measure(source, provider() ?: return null)
    }

    private fun measure(source: ItemStack, provider: HolderLookup.Provider): Measurement? {
        val keys = source.components.keySet()
        var hideAll = TooltipDisplay.DEFAULT
        keys.forEach { type -> hideAll = hideAll.withHidden(type, true) }
        val present = keys.filter { type -> type !in OWNED_COMPONENTS }
        var showPresent = hideAll
        present.forEach { type -> showPresent = showPresent.withHidden(type, false) }
        val flags = PROBE_FLAGS.map { flag ->
            try {
                measureFlag(source, provider, flag, hideAll, showPresent, present) ?: return null
            } catch (_: RuntimeException) {
                return null
            }
        }
        return Measurement(flags)
    }

    private fun measureFlag(
        source: ItemStack,
        provider: HolderLookup.Provider,
        flag: TooltipFlag,
        hideAll: TooltipDisplay,
        showPresent: TooltipDisplay,
        present: List<DataComponentType<*>>,
    ): FlagMeasurement? {
        val baselineContext = ProbeContext(provider)
        val baseline = countLines(source, hideAll, flag, baselineContext)
        // Lines that survive hiding every component are not controlled by any component, such as
        // the operator-only warning; no theme can own a tooltip that contains them.
        if (baseline > 0 || baselineContext.consultedClientState) return null
        val fullContext = ProbeContext(provider)
        val full = countLines(source, showPresent, flag, fullContext)
        if (full == baseline && !fullContext.consultedClientState) {
            return FlagMeasurement(baseline, full, emptyMap(), emptySet())
        }
        val perComponent = LinkedHashMap<DataComponentType<*>, Int>()
        val clientState = LinkedHashSet<DataComponentType<*>>()
        present.forEach { type ->
            val context = ProbeContext(provider)
            perComponent[type] = countLines(source, hideAll.withHidden(type, false), flag, context) - baseline
            if (context.consultedClientState) clientState += type
        }
        return FlagMeasurement(baseline, full, perComponent, clientState)
    }

    private fun countLines(
        source: ItemStack,
        display: TooltipDisplay,
        flag: TooltipFlag,
        context: Item.TooltipContext,
    ): Int {
        var count = 0
        source.addDetailsToTooltip(context, display, null, flag) { _: Component -> count++ }
        return count
    }

    internal class Measurement(
        val flags: List<FlagMeasurement>,
    ) {
        fun evidence(): TooltipLineEvidence {
            val emitting = TreeSet<ItemKey>()
            flags.forEach { flag ->
                // Lines that need two components at once cannot be attributed to either one.
                if (flag.perComponent.values.sum() != flag.full - flag.baseline) {
                    return TooltipLineEvidence.BLOCKED
                }
                flag.perComponent.forEach { (type, lines) ->
                    if (lines > 0 || type in flag.clientState) {
                        emitting += componentKey(type) ?: return TooltipLineEvidence.BLOCKED
                    }
                }
            }
            return TooltipLineEvidence(blocked = false, emittingComponents = emitting)
        }
    }

    internal class FlagMeasurement(
        val baseline: Int,
        val full: Int,
        val perComponent: Map<DataComponentType<*>, Int>,
        val clientState: Set<DataComponentType<*>>,
    )

    /**
     * Server-side tooltip context: registries are the frozen server registries, while the other
     * entry points read client or world state that a packet projection cannot know.
     */
    private class ProbeContext(
        private val registries: HolderLookup.Provider,
    ) : Item.TooltipContext {
        var consultedClientState = false
            private set

        override fun registries(): HolderLookup.Provider = registries

        override fun tickRate(): Float {
            consultedClientState = true
            return DEFAULT_TICK_RATE
        }

        override fun mapData(id: MapId): MapItemSavedData? {
            consultedClientState = true
            return null
        }

        override fun isPeaceful(): Boolean {
            consultedClientState = true
            return false
        }
    }

    companion object {
        private const val DEFAULT_TICK_RATE = 20.0f
        private const val MAX_CACHE_ENTRIES = 4_096

        /**
         * Components that projection owns or removes; their own lines are replaced atomically by
         * the projected Name and Lore.
         */
        internal val OWNED_COMPONENTS: Set<DataComponentType<*>> = setOf(
            DataComponents.ITEM_NAME,
            DataComponents.LORE,
            DataComponents.TOOLTIP_DISPLAY,
            DataComponents.TOOLTIP_STYLE,
            DataComponents.ITEM_MODEL,
            DataComponents.CUSTOM_DATA,
            DataComponents.CUSTOM_NAME,
        )

        /**
         * Clients build tooltips with a creative flag inside the creative inventory, which reveals
         * extra lines such as suspicious stew effects. Advanced (F3+H) lines remain out of scope.
         */
        private val PROBE_FLAGS: List<TooltipFlag> = listOf(TooltipFlag.NORMAL, TooltipFlag.NORMAL.asCreative())

        /** Uses the running server's frozen registries; null before the server is available. */
        val SERVER: NmsTooltipLineProbe = NmsTooltipLineProbe { MinecraftServer.getServer()?.registryAccess() }

        private val HOVER_TEXT_PARAMETERS = arrayOf(
            ItemStack::class.java,
            Item.TooltipContext::class.java,
            TooltipDisplay::class.java,
            Consumer::class.java,
            TooltipFlag::class.java,
        )
        private val hoverTextOverrides = ConcurrentHashMap<Class<*>, Boolean>()

        /** Whether an item class replaces Item.appendHoverText; bounded by the loaded item classes. */
        internal fun appendsHoverText(type: Class<out Item>): Boolean = hoverTextOverrides.computeIfAbsent(type) { owner ->
            owner.getMethod("appendHoverText", *HOVER_TEXT_PARAMETERS).declaringClass != Item::class.java
        }

        internal fun componentKey(type: DataComponentType<*>): ItemKey? {
            val id = BuiltInRegistries.DATA_COMPONENT_TYPE.getKey(type) ?: return null
            return try {
                ItemKey.parse(id.toString())
            } catch (_: IllegalArgumentException) {
                null
            }
        }

        fun verifyAbi() {
            ItemStack::class.java.getMethod(
                "addDetailsToTooltip",
                Item.TooltipContext::class.java,
                TooltipDisplay::class.java,
                Player::class.java,
                TooltipFlag::class.java,
                Consumer::class.java,
            )
            Item::class.java.getMethod("appendHoverText", *HOVER_TEXT_PARAMETERS)
            TooltipDisplay::class.java.getMethod("withHidden", DataComponentType::class.java, Boolean::class.javaPrimitiveType)
            TooltipFlag.Default::class.java.getMethod("asCreative")
            listOf("registries", "tickRate", "mapData", "isPeaceful").forEach { name ->
                check(Item.TooltipContext::class.java.methods.any { method -> method.name == name }) {
                    "Missing Item.TooltipContext.$name"
                }
            }
        }
    }
}

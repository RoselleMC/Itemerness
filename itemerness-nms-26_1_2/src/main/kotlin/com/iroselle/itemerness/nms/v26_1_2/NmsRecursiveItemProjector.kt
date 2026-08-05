package com.iroselle.itemerness.nms.v26_1_2

import java.lang.reflect.Constructor
import java.lang.reflect.Modifier
import java.util.Optional
import java.util.UUID
import net.minecraft.core.RegistryAccess
import net.minecraft.core.component.DataComponentType
import net.minecraft.core.component.DataComponents
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.NbtOps
import net.minecraft.network.chat.Component
import net.minecraft.server.network.Filterable
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.ItemStackTemplate
import net.minecraft.world.item.component.BundleContents
import net.minecraft.world.item.component.ChargedProjectiles
import net.minecraft.world.item.component.ItemAttributeModifiers
import net.minecraft.world.item.component.ItemContainerContents
import net.minecraft.world.item.component.ItemLore
import net.minecraft.world.item.component.UseRemainder
import net.minecraft.world.item.component.WrittenBookContent

/** Projects canonical items anywhere in the exact 26.1.2 ItemStack codec graph. */
internal class NmsRecursiveItemProjector(
    private val shallowProjector: NmsItemStackProjector,
    private val registration: NmsProjectionRegistration = NmsProjectionRegistration.NONE,
    private val customPayloadRegistration: NmsCustomPayloadRegistration = NmsCustomPayloadRegistration.NONE,
    private val packetSession: NmsItemStackProjector.NmsItemProjectionSession? = null,
    private val packetBudget: NmsPacketItemProjectionBudget? = null,
    private val destructiveSanitization: Boolean = false,
    private val registryAccessSource: () -> RegistryAccess = {
        RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)
    },
) {
    private val nbtProjector = NmsCanonicalNbtProjector(this)
    private val componentProjector = NmsComponentProjector(
        this,
        nbtProjector,
        registryAccessSource,
        customPayloadRegistration,
        { packetSession?.generation },
    )

    fun componentProjector(): NmsComponentProjector = componentProjector

    fun bindDialogProjector(projector: NmsDialogProjectionBridge) {
        componentProjector.bindDialogProjector(projector)
    }

    fun project(source: ItemStack, viewerId: UUID): ItemStack {
        if (destructiveSanitization) {
            (packetBudget ?: NmsPacketItemProjectionBudget()).enterItem(depth = 0)
            return destructiveFallback(source)
        }
        val session = packetSession ?: shallowProjector.newSession(viewerId)
        return projectStack(
            source,
            session,
            registration,
            packetBudget ?: NmsPacketItemProjectionBudget(),
            packetBudget?.nbtBudget ?: NmsCanonicalNbtProjector.TraversalBudget(),
            registryAccessSource(),
            viewerId,
            depth = 0,
        ).stack
    }

    fun project(source: ItemStackTemplate, viewerId: UUID): ItemStackTemplate {
        if (destructiveSanitization) {
            (packetBudget ?: NmsPacketItemProjectionBudget()).enterItem(depth = 0)
            val materialized = source.create()
            requireProjectionInput(!materialized.isEmpty) { "Cannot sanitize an invalid item stack template" }
            return ItemStackTemplate.fromNonEmptyStack(destructiveFallback(materialized))
        }
        val session = packetSession ?: shallowProjector.newSession(viewerId)
        return projectTemplate(
            source,
            session,
            registration,
            packetBudget ?: NmsPacketItemProjectionBudget(),
            packetBudget?.nbtBudget ?: NmsCanonicalNbtProjector.TraversalBudget(),
            registryAccessSource(),
            viewerId,
            depth = 0,
        ).template
    }

    private fun destructiveFallback(source: ItemStack): ItemStack =
        shallowProjector.canonicalFallback(source).also { fallback ->
            (
                NmsItemComponentCarriers.DIRECT_ITEMS +
                    NmsItemComponentCarriers.DIRECT_COMPONENTS +
                    NmsItemComponentCarriers.CODEC_GRAPH
                ).forEach { carrier -> removeComponent(fallback, carrier.type) }
        }

    @Suppress("UNCHECKED_CAST")
    private fun removeComponent(source: ItemStack, type: DataComponentType<*>) {
        source.remove(type as DataComponentType<Any>)
    }

    private fun projectStack(
        source: ItemStack,
        session: NmsItemStackProjector.NmsItemProjectionSession,
        registration: NmsProjectionRegistration,
        budget: NmsPacketItemProjectionBudget,
        nbtBudget: NmsCanonicalNbtProjector.TraversalBudget,
        registryAccess: RegistryAccess,
        viewerId: UUID,
        depth: Int,
    ): StackProjection {
        budget.enterItem(depth)
        val shallowResult = session.project(source)
        val shallow = shallowResult.stack
        if (shallow.isEmpty) {
            return StackProjection(shallow, shallowResult.managed)
        }

        var projected = shallow
        var copiedForNestedChange = false
        var containsManaged = shallowResult.managed

        fun <T : Any> replace(
            type: net.minecraft.core.component.DataComponentType<T>,
            original: T?,
            replacement: T?,
        ) {
            if (original === replacement) {
                return
            }
            if (!copiedForNestedChange) {
                projected = shallow.copy()
                copiedForNestedChange = true
            }
            if (replacement == null) {
                projected.remove(type)
            } else {
                projected.set(type, replacement)
            }
        }

        val bundle = shallow.get(DataComponents.BUNDLE_CONTENTS)
        val projectedBundle = bundle?.let {
            projectBundle(it, session, registration, budget, nbtBudget, registryAccess, viewerId, depth + 1)
        }
        containsManaged = containsManaged || projectedBundle?.containsManaged == true
        replace(
            DataComponents.BUNDLE_CONTENTS,
            bundle,
            projectedBundle?.value,
        )

        val container = shallow.get(DataComponents.CONTAINER)
        val projectedContainer = container?.let {
            projectContainer(it, session, registration, budget, nbtBudget, registryAccess, viewerId, depth + 1)
        }
        containsManaged = containsManaged || projectedContainer?.containsManaged == true
        replace(
            DataComponents.CONTAINER,
            container,
            projectedContainer?.value,
        )

        val charged = shallow.get(DataComponents.CHARGED_PROJECTILES)
        val projectedCharged = charged?.let {
            projectChargedProjectiles(it, session, registration, budget, nbtBudget, registryAccess, viewerId, depth + 1)
        }
        containsManaged = containsManaged || projectedCharged?.containsManaged == true
        replace(
            DataComponents.CHARGED_PROJECTILES,
            charged,
            projectedCharged?.value,
        )

        val remainder = shallow.get(DataComponents.USE_REMAINDER)
        val projectedRemainder = remainder?.let {
            projectUseRemainder(it, session, registration, budget, nbtBudget, registryAccess, viewerId, depth + 1)
        }
        containsManaged = containsManaged || projectedRemainder?.containsManaged == true
        replace(
            DataComponents.USE_REMAINDER,
            remainder,
            projectedRemainder?.value,
        )

        val directComponentProjection = projectDirectComponentGraph(projected, budget, viewerId)
        projected = directComponentProjection.stack
        containsManaged = containsManaged || directComponentProjection.containsManaged

        val graphProjection = projectRemainingCodecGraph(
            projected,
            session,
            registration,
            budget,
            nbtBudget,
            registryAccess,
            viewerId,
            depth,
        )
        projected = graphProjection.stack
        containsManaged = containsManaged || graphProjection.containsManaged

        val registered = if (containsManaged) {
            registration.register(source, projected, session.generation)
        } else {
            projected
        }
        return StackProjection(registered, containsManaged)
    }

    /** Projects component-bearing values before invoking their codecs, so cycles and node counts
     * are rejected by the shared bounded graph walker rather than by recursive serialization. */
    private fun projectDirectComponentGraph(
        source: ItemStack,
        budget: NmsPacketItemProjectionBudget,
        viewerId: UUID,
    ): StackProjection {
        var result = source
        var copied = false
        var changed = false

        fun <T : Any> replace(type: DataComponentType<T>, original: T?, replacement: T?) {
            if (original === replacement) return
            if (!copied) {
                result = source.copy()
                copied = true
            }
            if (replacement == null) result.remove(type) else result.set(type, replacement)
            changed = true
        }

        fun projectComponent(component: Component): Component =
            componentProjector.project(component, viewerId, budget.payloadBudget, depth = 0)

        val customName = source.get(DataComponents.CUSTOM_NAME)
        replace(DataComponents.CUSTOM_NAME, customName, customName?.let(::projectComponent))

        val itemName = source.get(DataComponents.ITEM_NAME)
        replace(DataComponents.ITEM_NAME, itemName, itemName?.let(::projectComponent))

        val lore = source.get(DataComponents.LORE)
        val projectedLore = lore?.let { original ->
            var loreChanged = false
            val lines = original.lines().map { line ->
                projectComponent(line).also { projected -> loreChanged = loreChanged || projected !== line }
            }
            val styledLines = original.styledLines().map { line ->
                projectComponent(line).also { projected -> loreChanged = loreChanged || projected !== line }
            }
            if (loreChanged) ItemLore(java.util.List.copyOf(lines), java.util.List.copyOf(styledLines)) else original
        }
        replace(DataComponents.LORE, lore, projectedLore)

        val attributes = source.get(DataComponents.ATTRIBUTE_MODIFIERS)
        val projectedAttributes = attributes?.let { original ->
            var attributeChanged = false
            val entries = original.modifiers().map { entry ->
                val display = entry.display()
                if (display is ItemAttributeModifiers.Display.OverrideText) {
                    val component = projectComponent(display.component())
                    if (component !== display.component()) {
                        attributeChanged = true
                        ItemAttributeModifiers.Entry(
                            entry.attribute(),
                            entry.modifier(),
                            entry.slot(),
                            ItemAttributeModifiers.Display.OverrideText(component),
                        )
                    } else {
                        entry
                    }
                } else {
                    entry
                }
            }
            if (attributeChanged) ItemAttributeModifiers(java.util.List.copyOf(entries)) else original
        }
        replace(DataComponents.ATTRIBUTE_MODIFIERS, attributes, projectedAttributes)

        val book = source.get(DataComponents.WRITTEN_BOOK_CONTENT)
        val projectedBook = book?.let { original ->
            var bookChanged = false
            val pages = original.pages().map { page ->
                val raw = projectComponent(page.raw())
                val filtered = page.filtered().map(::projectComponent)
                if (raw !== page.raw() || filtered != page.filtered()) {
                    bookChanged = true
                    Filterable(raw, filtered)
                } else {
                    page
                }
            }
            if (bookChanged) {
                WrittenBookContent(
                    original.title(),
                    original.author(),
                    original.generation(),
                    java.util.List.copyOf(pages),
                    original.resolved(),
                )
            } else {
                original
            }
        }
        replace(DataComponents.WRITTEN_BOOK_CONTENT, book, projectedBook)

        return StackProjection(result, changed)
    }

    private fun projectTemplate(
        source: ItemStackTemplate,
        session: NmsItemStackProjector.NmsItemProjectionSession,
        registration: NmsProjectionRegistration,
        budget: NmsPacketItemProjectionBudget,
        nbtBudget: NmsCanonicalNbtProjector.TraversalBudget,
        registryAccess: RegistryAccess,
        viewerId: UUID,
        depth: Int,
    ): TemplateProjection {
        val materialized = source.create()
        requireProjectionInput(!materialized.isEmpty) { "Cannot project an invalid item stack template" }
        val projected = projectStack(
            materialized,
            session,
            registration,
            budget,
            nbtBudget,
            registryAccess,
            viewerId,
            depth,
        )
        return TemplateProjection(
            template = if (projected.stack === materialized) {
                source
            } else {
                ItemStackTemplate.fromNonEmptyStack(projected.stack)
            },
            containsManaged = projected.containsManaged,
        )
    }

    private fun projectBundle(
        source: BundleContents,
        session: NmsItemStackProjector.NmsItemProjectionSession,
        registration: NmsProjectionRegistration,
        budget: NmsPacketItemProjectionBudget,
        nbtBudget: NmsCanonicalNbtProjector.TraversalBudget,
        registryAccess: RegistryAccess,
        viewerId: UUID,
        depth: Int,
    ): ComponentProjection<BundleContents> {
        budget.visitNestedComponent()
        var changed = false
        var containsManaged = false
        val items = source.items().map { item ->
            val projected = projectTemplate(
                item,
                session,
                registration,
                budget,
                nbtBudget,
                registryAccess,
                viewerId,
                depth,
            )
            changed = changed || projected.template !== item
            containsManaged = containsManaged || projected.containsManaged
            projected.template
        }
        val value = if (!changed) {
            source
        } else {
            NmsNestedComponentAccess.rebuildBundle(source, java.util.List.copyOf(items))
        }
        return ComponentProjection(value, containsManaged)
    }

    private fun projectContainer(
        source: ItemContainerContents,
        session: NmsItemStackProjector.NmsItemProjectionSession,
        registration: NmsProjectionRegistration,
        budget: NmsPacketItemProjectionBudget,
        nbtBudget: NmsCanonicalNbtProjector.TraversalBudget,
        registryAccess: RegistryAccess,
        viewerId: UUID,
        depth: Int,
    ): ComponentProjection<ItemContainerContents> {
        budget.visitNestedComponent()
        var changed = false
        var containsManaged = false
        val items = source.items.map { item ->
            if (item.isEmpty) {
                item
            } else {
                val original = item.orElseThrow()
                val projected = projectTemplate(
                    original,
                    session,
                    registration,
                    budget,
                    nbtBudget,
                    registryAccess,
                    viewerId,
                    depth,
                )
                changed = changed || projected.template !== original
                containsManaged = containsManaged || projected.containsManaged
                if (projected.template === original) item else Optional.of(projected.template)
            }
        }
        val value = if (!changed) {
            source
        } else {
            NmsNestedComponentAccess.rebuildContainer(java.util.List.copyOf(items))
        }
        return ComponentProjection(value, containsManaged)
    }

    private fun projectChargedProjectiles(
        source: ChargedProjectiles,
        session: NmsItemStackProjector.NmsItemProjectionSession,
        registration: NmsProjectionRegistration,
        budget: NmsPacketItemProjectionBudget,
        nbtBudget: NmsCanonicalNbtProjector.TraversalBudget,
        registryAccess: RegistryAccess,
        viewerId: UUID,
        depth: Int,
    ): ComponentProjection<ChargedProjectiles> {
        budget.visitNestedComponent()
        var changed = false
        var containsManaged = false
        val items = source.items().map { item ->
            val projected = projectTemplate(
                item,
                session,
                registration,
                budget,
                nbtBudget,
                registryAccess,
                viewerId,
                depth,
            )
            changed = changed || projected.template !== item
            containsManaged = containsManaged || projected.containsManaged
            projected.template
        }
        val value = if (!changed) source else ChargedProjectiles(java.util.List.copyOf(items))
        return ComponentProjection(value, containsManaged)
    }

    private fun projectUseRemainder(
        source: UseRemainder,
        session: NmsItemStackProjector.NmsItemProjectionSession,
        registration: NmsProjectionRegistration,
        budget: NmsPacketItemProjectionBudget,
        nbtBudget: NmsCanonicalNbtProjector.TraversalBudget,
        registryAccess: RegistryAccess,
        viewerId: UUID,
        depth: Int,
    ): ComponentProjection<UseRemainder> {
        budget.visitNestedComponent()
        val projected = projectTemplate(
            source.convertInto(),
            session,
            registration,
            budget,
            nbtBudget,
            registryAccess,
            viewerId,
            depth,
        )
        val value = if (projected.template === source.convertInto()) source else UseRemainder(projected.template)
        return ComponentProjection(value, projected.containsManaged)
    }

    /** Projects only the exact 26.1.2 component types whose codec graph can contain NBT or text. */
    private fun projectRemainingCodecGraph(
        source: ItemStack,
        session: NmsItemStackProjector.NmsItemProjectionSession,
        registration: NmsProjectionRegistration,
        budget: NmsPacketItemProjectionBudget,
        nbtBudget: NmsCanonicalNbtProjector.TraversalBudget,
        registryAccess: RegistryAccess,
        viewerId: UUID,
        depth: Int,
    ): StackProjection {
        val ops = registryAccess.createSerializationContext(NbtOps.INSTANCE)
        val nbtSession = nbtProjector.newSession(
            viewerId,
            registryAccess,
            nbtBudget,
        ) { nested ->
            projectStack(
                nested,
                session,
                registration,
                budget,
                nbtBudget,
                registryAccess,
                viewerId,
                depth + 1,
            ).stack
        }

        var result = source
        var copied = false
        var containsManaged = false
        NmsItemComponentCarriers.CODEC_GRAPH.forEach { carrier ->
            val original = getComponent(source, carrier.type) ?: return@forEach
            budget.consumeCodecCall()
            val encoded = encodeComponent(carrier.type, original, ops)
            val wrapper = CompoundTag().also { tag -> tag.put(CODEC_VALUE_KEY, encoded) }
            val projected = nbtSession.project(wrapper)
            if (!projected.changed) {
                return@forEach
            }
            val projectedValue = requireNotNull(projected.tag.get(CODEC_VALUE_KEY)) {
                "Projected ${carrier.id} component lost its codec value"
            }
            budget.consumeCodecCall()
            val decoded = decodeComponent(carrier.type, projectedValue, ops)
            if (!copied) {
                result = source.copy()
                copied = true
            }
            setComponent(result, carrier.type, decoded)
            containsManaged = true
        }
        return StackProjection(result, containsManaged)
    }

    @Suppress("UNCHECKED_CAST")
    private fun getComponent(source: ItemStack, type: DataComponentType<*>): Any? =
        source.get(type as DataComponentType<Any>)

    @Suppress("UNCHECKED_CAST")
    private fun setComponent(target: ItemStack, type: DataComponentType<*>, value: Any) {
        target.set(type as DataComponentType<Any>, value)
    }

    @Suppress("UNCHECKED_CAST")
    private fun encodeComponent(
        type: DataComponentType<*>,
        value: Any,
        ops: com.mojang.serialization.DynamicOps<net.minecraft.nbt.Tag>,
    ): net.minecraft.nbt.Tag = try {
        (type as DataComponentType<Any>)
            .codecOrThrow()
            .encodeStart(ops, value)
            .result()
            .orElse(null)
            ?: error("Failed to encode ${BuiltInRegistries.DATA_COMPONENT_TYPE.getKey(type)} component")
    } catch (failure: StackOverflowError) {
        throw NmsRecoverableProjectionException(
            "Cyclic ${BuiltInRegistries.DATA_COMPONENT_TYPE.getKey(type)} component codec graph",
            failure,
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun decodeComponent(
        type: DataComponentType<*>,
        value: net.minecraft.nbt.Tag,
        ops: com.mojang.serialization.DynamicOps<net.minecraft.nbt.Tag>,
    ): Any = try {
        (type as DataComponentType<Any>)
            .codecOrThrow()
            .parse(ops, value)
            .result()
            .orElse(null)
            ?: error("Failed to decode ${BuiltInRegistries.DATA_COMPONENT_TYPE.getKey(type)} component")
    } catch (failure: StackOverflowError) {
        throw NmsRecoverableProjectionException(
            "Cyclic ${BuiltInRegistries.DATA_COMPONENT_TYPE.getKey(type)} decoded graph",
            failure,
        )
    }

    private data class StackProjection(
        val stack: ItemStack,
        val containsManaged: Boolean,
    )

    private data class TemplateProjection(
        val template: ItemStackTemplate,
        val containsManaged: Boolean,
    )

    private data class ComponentProjection<T : Any>(
        val value: T,
        val containsManaged: Boolean,
    )

    private companion object {
        const val CODEC_VALUE_KEY = "value"
    }
}

/** One hard budget shared by every item and NBT carrier in one top-level outbound packet. */
internal class NmsPacketItemProjectionBudget(
    private val limits: NmsProjectionLimits = NmsProjectionLimits.DEFAULT,
) {
    val nbtBudget = NmsCanonicalNbtProjector.TraversalBudget(limits)
    val payloadBudget = NmsPayloadProjectionBudget(nbtBudget, limits)
    private var itemCount = 0
    private var nestedComponentCount = 0
    private var codecCalls = 0

    fun enterItem(depth: Int) {
        requireProjectionInput(depth <= limits.itemDepth) { "Nested item projection exceeds the recursion limit" }
        itemCount++
        requireProjectionInput(itemCount <= limits.items) { "Packet item projection exceeds the item limit" }
    }

    fun visitNestedComponent() {
        nestedComponentCount++
        requireProjectionInput(nestedComponentCount <= limits.nestedComponents) {
            "Packet item projection exceeds the nested component limit"
        }
    }

    fun consumeCodecCall() {
        codecCalls++
        requireProjectionInput(codecCalls <= limits.codecCalls) {
            "Packet item projection exceeds the codec-call limit"
        }
    }
}

/**
 * Exact 26.1.2 item component carrier inventory.
 *
 * The four structural item carriers are rebuilt directly. The codec-graph group covers component
 * text (including ShowItem), arbitrary entity/block NBT, bee occupants, and component predicates.
 * The matching resource manifest is ABI-tested so a version update cannot silently add a carrier.
 */
internal object NmsItemComponentCarriers {
    data class Carrier(
        val id: String,
        val type: DataComponentType<*>,
        val surface: String,
    )

    val DIRECT_ITEMS: List<Carrier> = listOf(
        Carrier("minecraft:bundle_contents", DataComponents.BUNDLE_CONTENTS, "item-stack-template-list"),
        Carrier("minecraft:container", DataComponents.CONTAINER, "optional-item-stack-template-list"),
        Carrier("minecraft:charged_projectiles", DataComponents.CHARGED_PROJECTILES, "item-stack-template-list"),
        Carrier("minecraft:use_remainder", DataComponents.USE_REMAINDER, "item-stack-template"),
    )

    val DIRECT_COMPONENTS: List<Carrier> = listOf(
        Carrier("minecraft:custom_name", DataComponents.CUSTOM_NAME, "component-show-item"),
        Carrier("minecraft:item_name", DataComponents.ITEM_NAME, "component-show-item"),
        Carrier("minecraft:lore", DataComponents.LORE, "component-list-show-item"),
        Carrier("minecraft:attribute_modifiers", DataComponents.ATTRIBUTE_MODIFIERS, "override-text-show-item"),
        Carrier("minecraft:written_book_content", DataComponents.WRITTEN_BOOK_CONTENT, "filtered-page-components"),
    )

    val CODEC_GRAPH: List<Carrier> = listOf(
        Carrier("minecraft:custom_data", DataComponents.CUSTOM_DATA, "arbitrary-nbt"),
        Carrier("minecraft:enchantments", DataComponents.ENCHANTMENTS, "inline-holder-component"),
        Carrier("minecraft:stored_enchantments", DataComponents.STORED_ENCHANTMENTS, "inline-holder-component"),
        Carrier("minecraft:can_place_on", DataComponents.CAN_PLACE_ON, "predicate-nbt"),
        Carrier("minecraft:can_break", DataComponents.CAN_BREAK, "predicate-nbt"),
        Carrier("minecraft:entity_data", DataComponents.ENTITY_DATA, "typed-entity-nbt"),
        Carrier("minecraft:bucket_entity_data", DataComponents.BUCKET_ENTITY_DATA, "entity-nbt"),
        Carrier("minecraft:block_entity_data", DataComponents.BLOCK_ENTITY_DATA, "typed-block-entity-nbt"),
        Carrier("minecraft:instrument", DataComponents.INSTRUMENT, "inline-holder-component"),
        Carrier("minecraft:provides_trim_material", DataComponents.PROVIDES_TRIM_MATERIAL, "inline-holder-component"),
        Carrier("minecraft:jukebox_playable", DataComponents.JUKEBOX_PLAYABLE, "inline-holder-component"),
        Carrier("minecraft:trim", DataComponents.TRIM, "inline-holder-components"),
        Carrier("minecraft:bees", DataComponents.BEES, "occupant-entity-nbt"),
        Carrier("minecraft:lock", DataComponents.LOCK, "item-component-predicate"),
        Carrier("minecraft:cat/variant", DataComponents.CAT_VARIANT, "registry-holder-graph"),
        Carrier("minecraft:chicken/variant", DataComponents.CHICKEN_VARIANT, "registry-holder-graph"),
        Carrier("minecraft:container_loot", DataComponents.CONTAINER_LOOT, "resource-graph"),
        Carrier("minecraft:cow/variant", DataComponents.COW_VARIANT, "registry-holder-graph"),
        Carrier("minecraft:frog/variant", DataComponents.FROG_VARIANT, "registry-holder-graph"),
        Carrier("minecraft:lodestone_tracker", DataComponents.LODESTONE_TRACKER, "resource-graph"),
        Carrier("minecraft:painting/variant", DataComponents.PAINTING_VARIANT, "registry-holder-component"),
        Carrier("minecraft:pig/variant", DataComponents.PIG_VARIANT, "registry-holder-graph"),
        Carrier("minecraft:tropical_fish/pattern", DataComponents.TROPICAL_FISH_PATTERN, "registry-holder-graph"),
        Carrier("minecraft:wolf/variant", DataComponents.WOLF_VARIANT, "registry-holder-graph"),
        Carrier("minecraft:zombie_nautilus/variant", DataComponents.ZOMBIE_NAUTILUS_VARIANT, "registry-holder-graph"),
    )

    val ALL: List<Carrier> = DIRECT_ITEMS + DIRECT_COMPONENTS + CODEC_GRAPH
}

/** Exact 26.1.2 accessors needed to preserve otherwise hidden nested component state. */
internal object NmsNestedComponentAccess {
    private val bundleConstructor: Constructor<BundleContents> = BundleContents::class.java
        .getDeclaredConstructor(List::class.java, Int::class.javaPrimitiveType)
        .also(::makeAccessible)
    private val containerConstructor: Constructor<ItemContainerContents> = ItemContainerContents::class.java
        .getDeclaredConstructor(List::class.java)
        .also(::makeAccessible)

    fun rebuildBundle(source: BundleContents, items: List<ItemStackTemplate>): BundleContents =
        bundleConstructor.newInstance(items, source.selectedItemIndex)

    fun rebuildContainer(items: List<Optional<ItemStackTemplate>>): ItemContainerContents =
        containerConstructor.newInstance(items)

    fun verifyAbi() {
        check(Modifier.isPrivate(bundleConstructor.modifiers)) {
            "BundleContents(List, int) is no longer private"
        }
        check(Modifier.isPrivate(containerConstructor.modifiers)) {
            "ItemContainerContents(List) is no longer private"
        }
    }

    private fun <T> makeAccessible(constructor: Constructor<T>) {
        check(constructor.trySetAccessible()) { "Cannot access ${constructor.declaringClass.simpleName} constructor" }
    }
}

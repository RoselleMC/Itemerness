package com.iroselle.itemerness.bukkit.command

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemInstanceMode
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.CommandReplyTarget
import com.iroselle.itemerness.bukkit.FoliaScheduler
import com.iroselle.itemerness.bukkit.api.EffectiveItemDataRead
import com.iroselle.itemerness.bukkit.api.EffectiveItemDataResolver
import com.iroselle.itemerness.bukkit.api.EffectiveItemDataResult
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainMapper
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainResult
import com.iroselle.itemerness.bukkit.catalog.BukkitCatalogItemFactory
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogManager
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogPublication
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogSnapshot
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogUpdate
import com.iroselle.itemerness.bukkit.catalog.DataReadAccess
import com.iroselle.itemerness.bukkit.catalog.samePhysicalItemStack
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.CanonicalItemInspection
import com.iroselle.itemerness.bukkit.spi.PendingItemName
import com.iroselle.itemerness.core.catalog.CatalogDiagnostic
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.InstanceDataMutation
import com.iroselle.itemerness.core.presentation.NestedItemPresentation
import com.iroselle.itemerness.core.presentation.PresentationDisplay
import com.iroselle.itemerness.core.presentation.PresentationEngine
import com.iroselle.itemerness.core.presentation.PresentationRenderRequest
import com.iroselle.itemerness.core.presentation.PresentationRenderResult
import com.iroselle.itemerness.core.presentation.PresentationViewer
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import java.util.logging.Level
import net.kyori.adventure.text.Component
import net.kyori.adventure.text.format.NamedTextColor
import org.bukkit.Material
import org.bukkit.command.CommandSender
import org.bukkit.entity.Player
import org.bukkit.inventory.ItemStack
import org.bukkit.inventory.PlayerInventory
import org.bukkit.plugin.Plugin

internal class DefaultItemernessCommandActions(
    private val plugin: Plugin,
    private val scheduler: FoliaScheduler,
    private val catalog: RuntimeCatalogManager,
    private val bridge: BukkitCanonicalItemBridge,
    private val catalogPublication: RuntimeCatalogPublication = RuntimeCatalogPublication.NO_OP,
    private val playerRefreshed: (UUID) -> Boolean = { false },
    private val runtimeActive: () -> Boolean = { true },
    private val effectiveItemData: EffectiveItemDataResolver = EffectiveItemDataResolver(),
) : ItemernessCommandActions {
    override fun reload(
        sender: CommandSender,
        checkOnly: Boolean,
    ) {
        runCatalogOperation(scheduler.captureCommandReplyTarget(sender), checkOnly, ValidationOutput.TEXT)
    }

    override fun validate(
        sender: CommandSender,
        format: ValidationOutput,
    ) {
        runCatalogOperation(scheduler.captureCommandReplyTarget(sender), checkOnly = true, format)
    }

    override fun give(
        sender: CommandSender,
        target: Player,
        itemKey: ItemKey,
        amount: Int,
    ) {
        val replyTarget = scheduler.captureCommandReplyTarget(sender)
        scheduler.runForEntity(
            target,
            retired = { reply(replyTarget, "Target player is no longer available", failure = true) },
        ) {
            runOwned(replyTarget) {
                val runtime = requireCatalog()
                val definition = requireNotNull(runtime.domain.findItem(itemKey)) {
                    "Unknown or disabled item: $itemKey"
                }
                val itemFactory = BukkitCatalogItemFactory(
                    bridge = bridge,
                    catalog = runtime.domain,
                    pendingName = { nestedKey -> pendingName(runtime, nestedKey) },
                )
                val stacks = when (definition.instanceMode) {
                    ItemInstanceMode.UNIQUE -> List(amount) {
                        itemFactory.create(definition, runtime.domain.createInstance(itemKey), 1)
                    }
                    ItemInstanceMode.FUNGIBLE -> {
                        val instance = runtime.domain.createInstance(itemKey)
                        val probe = itemFactory.create(definition, instance, 1)
                        splitAmounts(amount, probe.maxStackSize).map { stackAmount ->
                            probe.clone().also { it.amount = stackAmount }
                        }
                    }
                }
                if (!runtimeActive()) return@runOwned
                check(catalog.commitIfCurrent(runtime) {
                    check(runtimeActive()) { "Itemerness is no longer active" }
                    giveAtomically(target.inventory, stacks)
                }) { "Catalog changed before the give operation could commit; retry the command" }
                refresh(target.uniqueId)
                reply(replyTarget, "Gave $amount x $itemKey to ${target.name}")
            }
        }
    }

    override fun inspectHand(
        sender: CommandSender,
        locale: String?,
        raw: Boolean,
    ) {
        val replyTarget = scheduler.captureCommandReplyTarget(sender)
        val player = sender as? Player
        if (player == null) {
            reply(replyTarget, "Only a player can inspect their own hand", failure = true)
            return
        }
        inspectSlot(replyTarget, player, InventorySlot.MAIN_HAND, locale, raw)
    }

    override fun inspectSlot(
        sender: CommandSender,
        target: Player,
        slot: InventorySlot,
        locale: String?,
        raw: Boolean,
    ) = inspectSlot(
        scheduler.captureCommandReplyTarget(sender),
        target,
        slot,
        locale,
        raw,
    )

    private fun inspectSlot(
        replyTarget: CommandReplyTarget,
        target: Player,
        slot: InventorySlot,
        locale: String?,
        raw: Boolean,
    ) {
        scheduler.runForEntity(
            target,
            retired = { reply(replyTarget, "Target player is no longer available", failure = true) },
        ) {
            runOwned(replyTarget) {
                val runtime = requireCatalog()
                validateLocale(runtime, locale)
                val stack = readSlot(target.inventory, slot)
                    ?: error("${target.name}'s ${slot.argument} slot is empty")
                when (val inspected = bridge.inspect(stack)) {
                    CanonicalItemInspection.Unmanaged -> error("The selected item is not managed by Itemerness")
                    is CanonicalItemInspection.InvalidManaged -> error("Invalid managed item: ${inspected.reason}")
                    is CanonicalItemInspection.Managed -> {
                        val restored = CanonicalDomainMapper.restore(inspected.snapshot, runtime)
                        require(restored is CanonicalDomainResult.Valid) {
                            (restored as CanonicalDomainResult.Invalid).reason
                        }
                        if (raw) {
                            val snbt = requireNotNull(bridge.canonicalSnbt(stack)) {
                                "The managed canonical root is unavailable"
                            }
                            reply(replyTarget, boundedRaw(snbt))
                        } else {
                            val resolvedData = when (val resolved = effectiveItemData.resolveAll(stack, runtime, restored)) {
                                is EffectiveItemDataResult.Invalid -> error(resolved.reason)
                                is EffectiveItemDataResult.Valid -> resolved.data
                            }
                            reply(
                                replyTarget,
                                renderInspection(
                                    restored = restored,
                                    runtime = runtime,
                                    amount = stack.amount,
                                    locale = locale,
                                    managesVanillaTooltipLines = inspected.snapshot.canManageVanillaTooltipLines,
                                    effectiveData = resolvedData,
                                ),
                            )
                        }
                    }
                }
            }
        }
    }

    override fun readData(
        sender: CommandSender,
        target: Player,
        slot: InventorySlot,
        key: DataKey,
    ) {
        val replyTarget = scheduler.captureCommandReplyTarget(sender)
        withManagedSlot(replyTarget, target, slot) { runtime, source, restored ->
            when (val value = effectiveItemData.resolveKey(source, runtime, restored, key)) {
                EffectiveItemDataRead.Absent -> reply(replyTarget, "<unset>")
                is EffectiveItemDataRead.Value -> reply(replyTarget, renderDataValue(value.value))
                is EffectiveItemDataRead.Invalid -> error(value.reason)
            }
        }
    }

    override fun writeData(
        sender: CommandSender,
        target: Player,
        slot: InventorySlot,
        key: DataKey,
        literal: String,
    ) {
        mutateData(scheduler.captureCommandReplyTarget(sender), target, slot, key) { runtime, restored ->
            val definition = requireNotNull(runtime.domain.dataKeyDefinition(restored.definition.key, key)) {
                "Data key $key is not defined for ${restored.definition.key}"
            }
            InstanceDataMutation.Set(key, DataLiteralParser.parse(literal, definition.type))
        }
    }

    override fun unsetData(
        sender: CommandSender,
        target: Player,
        slot: InventorySlot,
        key: DataKey,
    ) {
        mutateData(scheduler.captureCommandReplyTarget(sender), target, slot, key) { _, _ ->
            InstanceDataMutation.Remove(key)
        }
    }

    override fun refreshPlayer(
        sender: CommandSender,
        target: Player,
    ) {
        if (!runtimeActive()) return
        val replyTarget = scheduler.captureCommandReplyTarget(sender)
        scheduler.tryRunForEntity(
            target,
            retired = { reply(replyTarget, "Target player is no longer available", failure = true) },
        ) {
            if (!runtimeActive()) return@tryRunForEntity
            if (refresh(target.uniqueId)) {
                reply(replyTarget, "Refreshed visible item surfaces for ${target.name}")
            } else {
                reply(replyTarget, "Visible item surface refresh is unavailable for ${target.name}", failure = true)
            }
        }
    }

    override fun refreshAll(sender: CommandSender) {
        if (!runtimeActive()) return
        val replyTarget = scheduler.captureCommandReplyTarget(sender)
        scheduler.tryRunGlobal {
            if (!runtimeActive()) return@tryRunGlobal
            val players = plugin.server.onlinePlayers.toList()
            if (players.isEmpty()) {
                reply(replyTarget, "No online players require refresh")
                return@tryRunGlobal
            }
            val accepted = AtomicInteger()
            players.forEach { player ->
                if (refresh(player.uniqueId)) accepted.incrementAndGet()
            }
            reply(replyTarget, "Scheduled item surface refresh for ${accepted.get()} players")
        }
    }

    private fun runCatalogOperation(
        replyTarget: CommandReplyTarget,
        checkOnly: Boolean,
        format: ValidationOutput,
    ) {
        if (!runtimeActive()) return
        reply(replyTarget, if (checkOnly) "Validating Itemerness catalog..." else "Reloading Itemerness catalog...")
        if (!runtimeActive()) return
        scheduler.tryRunAsync {
            if (!runtimeActive()) return@tryRunAsync
            val update = try {
                catalog.prepareReload(checkOnly)
            } catch (failure: Exception) {
                reply(
                    replyTarget,
                    "Catalog operation failed: ${failure.message ?: failure.javaClass.simpleName}",
                    failure = true,
                )
                return@tryRunAsync
            }
            if (!runtimeActive()) return@tryRunAsync
            if (update is RuntimeCatalogUpdate.Prepared) {
                scheduler.tryRunGlobal {
                    if (!runtimeActive()) return@tryRunGlobal
                    val published = try {
                        catalog.publish(update, catalogPublication)
                    } catch (failure: Exception) {
                        reply(
                            replyTarget,
                            "Catalog publication failed: ${failure.message ?: failure.javaClass.simpleName}",
                            failure = true,
                        )
                        return@tryRunGlobal
                    }
                    handleCatalogUpdate(replyTarget, format, published)
                }
            } else {
                handleCatalogUpdate(replyTarget, format, update)
            }
        }
    }

    private fun handleCatalogUpdate(
        replyTarget: CommandReplyTarget,
        format: ValidationOutput,
        update: RuntimeCatalogUpdate,
    ) {
        if (!runtimeActive()) return
        when (update) {
            is RuntimeCatalogUpdate.Published -> {
                update.completionFailures.forEach { failure ->
                    plugin.logger.log(Level.WARNING, "Catalog post-commit listener failed", failure)
                }
                refreshOnlinePlayers()
                reply(
                    replyTarget,
                    "Published catalog revision ${update.active.domain.revision} " +
                        "(${update.active.domain.items.size} enabled items)",
                )
            }
            is RuntimeCatalogUpdate.Validated -> reply(
                replyTarget,
                diagnostics(format, update.diagnostics, "Catalog validation succeeded"),
            )
            is RuntimeCatalogUpdate.Rejected -> reply(
                replyTarget,
                diagnostics(format, update.diagnostics, "Catalog validation failed"),
                failure = true,
            )
            is RuntimeCatalogUpdate.Superseded -> reply(
                replyTarget,
                diagnostics(format, update.diagnostics, "Catalog request was superseded by a newer request"),
                failure = true,
            )
            is RuntimeCatalogUpdate.PublicationFailed -> reply(
                replyTarget,
                "Catalog publication failed; revision ${update.active?.domain?.revision ?: 0} remains active: " +
                    (update.failure.message ?: update.failure.javaClass.simpleName),
                failure = true,
            )
            is RuntimeCatalogUpdate.Prepared -> error("Prepared catalog update was not published")
        }
    }

    private fun refreshOnlinePlayers() {
        if (!runtimeActive()) return
        plugin.server.onlinePlayers.toList().forEach { player ->
            if (!runtimeActive()) return
            refresh(player.uniqueId)
        }
    }

    private fun mutateData(
        replyTarget: CommandReplyTarget,
        target: Player,
        slot: InventorySlot,
        key: DataKey,
        mutation: (RuntimeCatalogSnapshot, CanonicalDomainResult.Valid) -> InstanceDataMutation,
    ) {
        scheduler.runForEntity(
            target,
            retired = { reply(replyTarget, "Target player is no longer available", failure = true) },
        ) {
            runOwned(replyTarget) {
                val runtime = requireCatalog()
                val source = readSlot(target.inventory, slot)?.clone()
                    ?: error("${target.name}'s ${slot.argument} slot is empty")
                val baseline = inspectManagedState(source, runtime)
                val restored = baseline.restored
                val updated = runtime.domain.editInstance(restored.instance, listOf(mutation(runtime, restored)))
                if (updated === restored.instance) {
                    reply(replyTarget, "No data changed for $key")
                    return@runOwned
                }
                val rewritten = bridge.rewrite(
                    source,
                    restored.definition,
                    updated,
                    pendingName(runtime, restored.definition.key),
                )
                if (!runtimeActive()) return@runOwned
                check(refresh(target.uniqueId)) {
                    "Visible item surface refresh is unavailable for ${target.name}; the slot was not changed"
                }
                check(catalog.commitIfCurrent(runtime) {
                    check(runtimeActive()) { "Itemerness is no longer active" }
                    val current = readSlot(target.inventory, slot)
                        ?: error("${target.name}'s ${slot.argument} slot changed before the edit committed")
                    check(
                        samePhysicalItemStack(source, current),
                    ) { "${target.name}'s ${slot.argument} slot changed before the edit committed" }
                    writeSlot(target.inventory, slot, rewritten)
                }) { "Catalog changed before the data edit could commit; retry the command" }
                reply(replyTarget, "Updated $key on ${target.name}'s ${slot.argument} (revision ${updated.instanceRevision})")
            }
        }
    }

    private fun withManagedSlot(
        replyTarget: CommandReplyTarget,
        target: Player,
        slot: InventorySlot,
        action: (RuntimeCatalogSnapshot, ItemStack, CanonicalDomainResult.Valid) -> Unit,
    ) {
        scheduler.runForEntity(
            target,
            retired = { reply(replyTarget, "Target player is no longer available", failure = true) },
        ) {
            runOwned(replyTarget) {
                val runtime = requireCatalog()
                val source = readSlot(target.inventory, slot)
                    ?: error("${target.name}'s ${slot.argument} slot is empty")
                action(runtime, source, inspectManagedState(source, runtime).restored)
            }
        }
    }

    private fun inspectManagedState(
        source: ItemStack,
        runtime: RuntimeCatalogSnapshot,
    ): ManagedSlotState = when (val inspected = bridge.inspect(source)) {
        CanonicalItemInspection.Unmanaged -> error("The selected item is not managed by Itemerness")
        is CanonicalItemInspection.InvalidManaged -> error("Invalid managed item: ${inspected.reason}")
        is CanonicalItemInspection.Managed -> when (val restored = CanonicalDomainMapper.restore(inspected.snapshot, runtime)) {
            is CanonicalDomainResult.Invalid -> error(restored.reason)
            is CanonicalDomainResult.Valid -> ManagedSlotState(inspected.snapshot, restored)
        }
    }

    private data class ManagedSlotState(
        val snapshot: com.iroselle.itemerness.projection.CanonicalItemSnapshot,
        val restored: CanonicalDomainResult.Valid,
    )

    internal fun renderInspection(
        restored: CanonicalDomainResult.Valid,
        runtime: RuntimeCatalogSnapshot,
        amount: Int,
        locale: String?,
        managesVanillaTooltipLines: Boolean = false,
        effectiveData: Map<DataKey, ItemDataValue>? = null,
    ): String {
        val resolvedData = effectiveData ?: run {
            val definition = restored.definition as? CatalogItemDefinition
            LinkedHashMap(definition?.definitionData.orEmpty()).apply {
                putAll(restored.instance.data)
            }
        }
        val view = locale?.let { requestedLocale ->
            renderLocalizedView(
                restored,
                runtime,
                requestedLocale,
                managesVanillaTooltipLines,
                resolvedData,
            )
        }
        return buildString {
            append("id=").append(restored.definition.key)
            append(" material=").append(restored.definition.material)
            append(" amount=").append(amount)
            append(" catalog-revision=").append(runtime.domain.revision)
            append(" created-against=").append(restored.instance.createdAgainstRevision)
            append(" instance-revision=").append(restored.instance.instanceRevision)
            restored.instance.instanceId?.let { append(" instance-id=").append(it) }
            locale?.let { append(" locale=").append(it) }
            view?.let { display ->
                append("\nview.name=").append(display.displayName.plainText)
                display.lore.forEachIndexed { index, line ->
                    append("\nview.lore[").append(index).append("]=").append(line.plainText)
                }
                append("\nview.theme=").append(display.selectedTheme)
            }
            if (resolvedData.isNotEmpty()) {
                append(" data={")
                resolvedData.entries.joinTo(this, separator = ", ") { (key, value) ->
                    val access = runtime.source.dataKeyIntegrations[key.id]?.readAccess
                    "$key=${if (access == DataReadAccess.PUBLIC) renderDataValue(value) else "<restricted>"}"
                }
                append('}')
            }
        }
    }

    private fun renderLocalizedView(
        restored: CanonicalDomainResult.Valid,
        runtime: RuntimeCatalogSnapshot,
        locale: String,
        managesVanillaTooltipLines: Boolean,
        data: Map<DataKey, ItemDataValue>,
    ): PresentationDisplay {
        val definition = restored.definition as? CatalogItemDefinition
            ?: error("The active item definition cannot be rendered")
        val engine = PresentationEngine(runtime.presentation)
        val nestedItems = definition.contents.map { content ->
            NestedItemPresentation(
                itemKey = content.item,
                displayName = engine.itemDisplayName(content.item, locale).getOrThrow(),
                amount = content.amount,
            )
        }
        return when (
            val rendered = engine.render(
                PresentationRenderRequest(
                    itemKey = definition.key,
                    data = data,
                    viewer = PresentationViewer(
                        locale = locale,
                        resourcePackLoaded = false,
                        managesVanillaTooltipLines = managesVanillaTooltipLines,
                    ),
                    nestedItems = nestedItems,
                ),
            )
        ) {
            is PresentationRenderResult.Rendered -> rendered.display
            is PresentationRenderResult.Rejected -> error(
                "Presentation render failed (${rendered.failure.code}): ${rendered.failure.message}",
            )
        }
    }

    private fun validateLocale(
        runtime: RuntimeCatalogSnapshot,
        locale: String?,
    ) {
        if (locale != null) {
            require(locale in runtime.presentation.locales) { "Unknown locale: $locale" }
        }
    }

    private fun requireCatalog(): RuntimeCatalogSnapshot =
        requireNotNull(catalog.snapshot()) { "No Itemerness catalog is active" }

    private fun pendingName(
        runtime: RuntimeCatalogSnapshot,
        itemKey: ItemKey,
    ): PendingItemName = PendingItemName(
        text = runtime.settings.pendingName(itemKey),
        colorRgb = runtime.settings.pendingNameColorRgb,
    )

    private fun runOwned(
        replyTarget: CommandReplyTarget,
        action: () -> Unit,
    ) {
        if (!runtimeActive()) return
        try {
            action()
        } catch (exception: RuntimeException) {
            reply(replyTarget, exception.message ?: exception.javaClass.simpleName, failure = true)
        }
    }

    private fun reply(
        replyTarget: CommandReplyTarget,
        message: String,
        failure: Boolean = false,
    ) {
        if (!runtimeActive()) return
        val component = Component.text(message, if (failure) NamedTextColor.RED else NamedTextColor.GRAY)
        scheduler.sendCommandReply(replyTarget, component)
    }

    private fun refresh(viewerId: UUID): Boolean = runtimeActive() && playerRefreshed(viewerId)

    private fun diagnostics(
        format: ValidationOutput,
        values: List<CatalogDiagnostic>,
        summary: String,
    ): String = when (format) {
        ValidationOutput.TEXT -> if (values.isEmpty()) summary else buildString {
            append(summary).append(':')
            values.forEach { diagnostic ->
                append("\n- ").append(diagnostic.code).append(" at ").append(diagnostic.path)
                    .append(": ").append(diagnostic.message)
            }
        }
        ValidationOutput.JSON -> buildString {
            append("{\"successful\":").append(values.isEmpty())
            append(",\"summary\":\"").append(jsonEscape(summary)).append("\",\"diagnostics\":[")
            values.forEachIndexed { index, diagnostic ->
                if (index > 0) append(',')
                append("{\"code\":\"").append(diagnostic.code).append("\",\"path\":\"")
                    .append(jsonEscape(diagnostic.path)).append("\",\"message\":\"")
                    .append(jsonEscape(diagnostic.message)).append("\"}")
            }
            append("]}")
        }
    }

    private fun jsonEscape(value: String): String = buildString(value.length) {
        value.forEach { character ->
            when (character) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\b' -> append("\\b")
                '\u000C' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character.code < 0x20) {
                    append("\\u").append(character.code.toString(16).padStart(4, '0'))
                } else {
                    append(character)
                }
            }
        }
    }

    private fun boundedRaw(value: String): String = if (value.length <= MAX_RAW_CHARACTERS) {
        value
    } else {
        value.take(MAX_RAW_CHARACTERS) + "... <truncated>"
    }

    private companion object {
        const val MAX_RAW_CHARACTERS = 32_000
    }
}

private fun splitAmounts(
    amount: Int,
    maximum: Int,
): List<Int> {
    require(amount > 0) { "Amount must be positive" }
    require(maximum > 0) { "Maximum stack size must be positive" }
    val result = ArrayList<Int>()
    var remaining = amount
    while (remaining > 0) {
        val next = minOf(remaining, maximum)
        result += next
        remaining -= next
    }
    return result
}

private fun giveAtomically(
    inventory: PlayerInventory,
    incoming: List<ItemStack>,
) {
    val original = inventory.storageContents.map { item -> item?.clone() }.toTypedArray()
    val simulated = original.map { item -> item?.clone() }.toTypedArray()
    require(canFit(simulated, incoming)) { "The target player does not have enough inventory space" }
    try {
        val leftovers = inventory.addItem(*incoming.map(ItemStack::clone).toTypedArray())
        check(leftovers.isEmpty()) { "Inventory changed while committing the give operation" }
    } catch (failure: RuntimeException) {
        inventory.storageContents = original
        throw failure
    }
}

private fun canFit(
    storage: Array<ItemStack?>,
    incoming: List<ItemStack>,
): Boolean {
    incoming.forEach { source ->
        var remaining = source.amount
        storage.indices.forEach { index ->
            val existing = storage[index] ?: return@forEach
            if (remaining > 0 && existing.isSimilar(source)) {
                val capacity = (existing.maxStackSize - existing.amount).coerceAtLeast(0)
                val moved = minOf(capacity, remaining)
                existing.amount += moved
                remaining -= moved
            }
        }
        storage.indices.forEach { index ->
            if (remaining > 0 && (storage[index] == null || storage[index]?.type == Material.AIR)) {
                val moved = minOf(source.maxStackSize, remaining)
                storage[index] = source.clone().also { it.amount = moved }
                remaining -= moved
            }
        }
        if (remaining > 0) return false
    }
    return true
}

private fun readSlot(
    inventory: PlayerInventory,
    slot: InventorySlot,
): ItemStack? = when (slot) {
    InventorySlot.MAIN_HAND -> inventory.itemInMainHand
    InventorySlot.OFF_HAND -> inventory.itemInOffHand
    InventorySlot.HELMET -> inventory.helmet
    InventorySlot.CHESTPLATE -> inventory.chestplate
    InventorySlot.LEGGINGS -> inventory.leggings
    InventorySlot.BOOTS -> inventory.boots
}?.takeUnless { it.type == Material.AIR }?.clone()

private fun writeSlot(
    inventory: PlayerInventory,
    slot: InventorySlot,
    stack: ItemStack,
) {
    when (slot) {
        InventorySlot.MAIN_HAND -> inventory.setItemInMainHand(stack)
        InventorySlot.OFF_HAND -> inventory.setItemInOffHand(stack)
        InventorySlot.HELMET -> inventory.setHelmet(stack)
        InventorySlot.CHESTPLATE -> inventory.setChestplate(stack)
        InventorySlot.LEGGINGS -> inventory.setLeggings(stack)
        InventorySlot.BOOTS -> inventory.setBoots(stack)
    }
}

private fun renderDataValue(value: ItemDataValue): String = when (value) {
    is BooleanDataValue -> value.value.toString()
    is IntegerDataValue -> value.value.toString()
    is LongDataValue -> value.value.toString()
    is DecimalDataValue -> value.value.toString()
    is StringDataValue -> value.value
    is UuidDataValue -> value.value.toString()
    is NamespacedKeyDataValue -> value.value.toString()
    is ListDataValue -> value.values.joinToString(prefix = "[", postfix = "]", transform = ::renderDataValue)
    is CompoundDataValue -> value.entries.entries.joinToString(prefix = "{", postfix = "}") { (key, child) ->
        "$key: ${renderDataValue(child)}"
    }
}

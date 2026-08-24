package com.iroselle.itemerness.nms.v26_2

import com.mojang.datafixers.util.Either
import com.mojang.datafixers.util.Pair
import java.lang.reflect.Field
import java.lang.reflect.Modifier
import java.util.Optional
import java.util.UUID
import net.minecraft.core.RegistryAccess
import net.minecraft.core.RegistrySynchronization
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.advancements.AdvancementHolder
import net.minecraft.core.component.DataComponentExactPredicate
import net.minecraft.core.particles.ItemParticleOption
import net.minecraft.core.particles.ParticleOptions
import net.minecraft.network.chat.ChatType
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.numbers.NumberFormat
import net.minecraft.network.protocol.Packet
import net.minecraft.network.protocol.common.ClientboundDisconnectPacket
import net.minecraft.network.protocol.common.ClientboundResourcePackPushPacket
import net.minecraft.network.protocol.common.ClientboundServerLinksPacket
import net.minecraft.network.protocol.common.ClientboundShowDialogPacket
import net.minecraft.network.protocol.configuration.ClientboundRegistryDataPacket
import net.minecraft.network.protocol.game.ClientGamePacketListener
import net.minecraft.network.protocol.game.ClientboundBossEventPacket
import net.minecraft.network.protocol.game.ClientboundBlockEntityDataPacket
import net.minecraft.network.protocol.game.ClientboundBundlePacket
import net.minecraft.network.protocol.game.ClientboundCommandSuggestionsPacket
import net.minecraft.network.protocol.game.ClientboundContainerSetContentPacket
import net.minecraft.network.protocol.game.ClientboundContainerSetSlotPacket
import net.minecraft.network.protocol.game.ClientboundDisguisedChatPacket
import net.minecraft.network.protocol.game.ClientboundExplodePacket
import net.minecraft.network.protocol.game.ClientboundLevelParticlesPacket
import net.minecraft.network.protocol.game.ClientboundLevelChunkWithLightPacket
import net.minecraft.network.protocol.game.ClientboundMapItemDataPacket
import net.minecraft.network.protocol.game.ClientboundMerchantOffersPacket
import net.minecraft.network.protocol.game.ClientboundOpenScreenPacket
import net.minecraft.network.protocol.game.ClientboundPlaceGhostRecipePacket
import net.minecraft.network.protocol.game.ClientboundPlayerChatPacket
import net.minecraft.network.protocol.game.ClientboundPlayerCombatKillPacket
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket
import net.minecraft.network.protocol.game.ClientboundRecipeBookAddPacket
import net.minecraft.network.protocol.game.ClientboundServerDataPacket
import net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket
import net.minecraft.network.protocol.game.ClientboundSetCursorItemPacket
import net.minecraft.network.protocol.game.ClientboundSetEntityDataPacket
import net.minecraft.network.protocol.game.ClientboundSetEquipmentPacket
import net.minecraft.network.protocol.game.ClientboundSetObjectivePacket
import net.minecraft.network.protocol.game.ClientboundSetPlayerInventoryPacket
import net.minecraft.network.protocol.game.ClientboundSetPlayerTeamPacket
import net.minecraft.network.protocol.game.ClientboundSetScorePacket
import net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket
import net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket
import net.minecraft.network.protocol.game.ClientboundTabListPacket
import net.minecraft.network.protocol.game.ClientboundTagQueryPacket
import net.minecraft.network.protocol.game.ClientboundTestInstanceBlockStatus
import net.minecraft.network.protocol.game.ClientboundUpdateAdvancementsPacket
import net.minecraft.network.protocol.game.ClientboundUpdateRecipesPacket
import net.minecraft.network.protocol.login.ClientboundLoginDisconnectPacket
import net.minecraft.network.protocol.status.ClientboundStatusResponsePacket
import net.minecraft.network.protocol.status.ServerStatus
import net.minecraft.network.syncher.EntityDataSerializer
import net.minecraft.network.syncher.EntityDataSerializers
import net.minecraft.network.syncher.SynchedEntityData
import net.minecraft.server.ServerLinks
import net.minecraft.world.entity.EquipmentSlot
import net.minecraft.world.BossEvent
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.crafting.SelectableRecipe
import net.minecraft.world.item.crafting.StonecutterRecipe
import net.minecraft.world.item.trading.ItemCost
import net.minecraft.world.item.trading.MerchantOffer
import net.minecraft.world.item.trading.MerchantOffers
import net.minecraft.world.level.saveddata.maps.MapDecoration
import net.minecraft.world.scores.Objective
import net.minecraft.world.scores.PlayerTeam
import net.minecraft.world.scores.Scoreboard
import net.minecraft.world.scores.criteria.ObjectiveCriteria

/** Rebuilds the direct 26.2 outbound item carriers without mutating their inputs. */
internal class NmsOutboundPacketProjector(
    private val itemProjector: NmsItemStackProjector,
    registration: NmsProjectionRegistration = NmsProjectionRegistration.NONE,
    sessionViewerId: UUID? = null,
    sanitizingSession: Boolean = false,
    destructiveItemSanitization: Boolean = false,
    private val limits: NmsProjectionLimits = NmsProjectionLimits.DEFAULT,
    private val registryAccessSource: () -> RegistryAccess? = {
        RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)
    },
) {
    private val customPayloadRegistration = registration as? NmsCustomPayloadRegistration
        ?: NmsCustomPayloadRegistration.NONE
    private val packetSession = sessionViewerId?.let { viewerId ->
        if (sanitizingSession) {
            itemProjector.newSanitizingSession(viewerId)
        } else {
            itemProjector.newSession(viewerId)
        }
    }
    private val packetItemBudget = sessionViewerId?.let { NmsPacketItemProjectionBudget(limits) }
    private val packetPayloadBudget = packetItemBudget?.payloadBudget
    private val recursiveItemProjector = NmsRecursiveItemProjector(
        shallowProjector = itemProjector,
        registration = NmsProjectionRegistration.NONE,
        customPayloadRegistration = customPayloadRegistration,
        packetSession = packetSession,
        packetBudget = packetItemBudget,
        destructiveSanitization = destructiveItemSanitization,
        registryAccessSource = { requireNotNull(registryAccessSource()) { "Registry access is unavailable" } },
    )
    private val inventoryItemProjector = NmsRecursiveItemProjector(
        shallowProjector = itemProjector,
        registration = registration,
        customPayloadRegistration = customPayloadRegistration,
        packetSession = packetSession,
        packetBudget = packetItemBudget,
        destructiveSanitization = destructiveItemSanitization,
        registryAccessSource = { requireNotNull(registryAccessSource()) { "Registry access is unavailable" } },
    )
    private val merchantCostItemProjector = NmsRecursiveItemProjector(
        shallowProjector = itemProjector,
        registration = registration.markerOnly(),
        customPayloadRegistration = customPayloadRegistration,
        packetSession = packetSession,
        packetBudget = packetItemBudget,
        destructiveSanitization = destructiveItemSanitization,
        registryAccessSource = { requireNotNull(registryAccessSource()) { "Registry access is unavailable" } },
    )
    private val componentProjector = recursiveItemProjector.componentProjector()
    private val structuredPayloadProjector = NmsStructuredPayloadProjector(
        recursiveItemProjector,
        componentProjector,
        packetPayloadBudget,
    )
    private val canonicalNbtProjector = NmsCanonicalNbtProjector(recursiveItemProjector)

    init {
        inventoryItemProjector.bindDialogProjector(structuredPayloadProjector)
        merchantCostItemProjector.bindDialogProjector(structuredPayloadProjector)
    }

    fun project(
        source: Packet<*>,
        viewerId: UUID,
        registration: NmsProjectionRegistration,
    ): Packet<*> = NmsOutboundPacketProjector(
        itemProjector,
        registration,
        sessionViewerId = viewerId,
        registryAccessSource = registryAccessSource,
    ).project(source, viewerId)

    fun projectUnbound(source: Packet<*>): Packet<*> = NmsOutboundPacketProjector(
        itemProjector,
        NmsProjectionRegistration.NONE,
        sessionViewerId = UNBOUND_VIEWER_ID,
        sanitizingSession = true,
        registryAccessSource = registryAccessSource,
    ).project(source, UNBOUND_VIEWER_ID)

    /**
     * Rebuilds a packet from its original canonical input without viewer state or inbound
     * capabilities. The same exhaustive carrier traversal is used with a larger, still-bounded
     * emergency budget. A declared carrier is therefore never returned raw merely because the
     * ordinary projection budget was exhausted.
     */
    fun canonicalFallback(
        source: Packet<*>,
        registration: NmsProjectionRegistration,
    ): Packet<*> = NmsOutboundPacketProjector(
        itemProjector,
        registration,
        sessionViewerId = UNBOUND_VIEWER_ID,
        sanitizingSession = true,
        destructiveItemSanitization = true,
        limits = NmsProjectionLimits.CANONICAL_FALLBACK,
        registryAccessSource = registryAccessSource,
    ).project(source, UNBOUND_VIEWER_ID)

    fun project(source: Packet<*>, viewerId: UUID): Packet<*> =
        if (packetSession == null) {
            NmsOutboundPacketProjector(
                itemProjector,
                NmsProjectionRegistration.NONE,
                sessionViewerId = viewerId,
                registryAccessSource = registryAccessSource,
            ).project(source, viewerId, ProjectionBudget(limits))
        } else {
            project(source, viewerId, ProjectionBudget(limits))
        }

    fun isProjectionCarrier(source: Packet<*>): Boolean = when (source) {
        is ClientboundContainerSetContentPacket,
        is ClientboundContainerSetSlotPacket,
        is ClientboundSetCursorItemPacket,
        is ClientboundSetPlayerInventoryPacket,
        is ClientboundSetEquipmentPacket,
        is ClientboundMerchantOffersPacket,
        is ClientboundSetEntityDataPacket,
        is ClientboundLevelParticlesPacket,
        is ClientboundExplodePacket,
        is ClientboundSystemChatPacket,
        is ClientboundDisguisedChatPacket,
        is ClientboundPlayerChatPacket,
        is ClientboundSetActionBarTextPacket,
        is ClientboundSetTitleTextPacket,
        is ClientboundSetSubtitleTextPacket,
        is ClientboundTabListPacket,
        is ClientboundOpenScreenPacket,
        is ClientboundCommandSuggestionsPacket,
        is ClientboundMapItemDataPacket,
        is ClientboundPlayerInfoUpdatePacket,
        is ClientboundDisconnectPacket,
        is ClientboundResourcePackPushPacket,
        is ClientboundServerLinksPacket,
        is ClientboundShowDialogPacket,
        is ClientboundBossEventPacket,
        is ClientboundSetObjectivePacket,
        is ClientboundSetPlayerTeamPacket,
        is ClientboundSetScorePacket,
        is ClientboundUpdateAdvancementsPacket,
        is ClientboundUpdateRecipesPacket,
        is ClientboundRecipeBookAddPacket,
        is ClientboundPlaceGhostRecipePacket,
        is ClientboundPlayerCombatKillPacket,
        is ClientboundServerDataPacket,
        is ClientboundTestInstanceBlockStatus,
        is ClientboundTagQueryPacket,
        is ClientboundBlockEntityDataPacket,
        is ClientboundLevelChunkWithLightPacket,
        is ClientboundBundlePacket,
        is ClientboundStatusResponsePacket,
        is ClientboundRegistryDataPacket,
        is ClientboundLoginDisconnectPacket,
        -> true
        else -> false
    }

    private fun project(
        source: Packet<*>,
        viewerId: UUID,
        budget: ProjectionBudget,
    ): Packet<*> {
        budget.enterPacket()
        return when (source) {
            is ClientboundContainerSetContentPacket -> projectContainerContent(source, viewerId)
            is ClientboundContainerSetSlotPacket -> projectContainerSlot(source, viewerId)
            is ClientboundSetCursorItemPacket -> projectCursor(source, viewerId)
            is ClientboundSetPlayerInventoryPacket -> projectPlayerInventory(source, viewerId)
            is ClientboundSetEquipmentPacket -> projectEquipment(source, viewerId)
            is ClientboundMerchantOffersPacket -> projectMerchantOffers(source, viewerId)
            is ClientboundSetEntityDataPacket -> projectEntityData(source, viewerId)
            is ClientboundLevelParticlesPacket -> projectLevelParticles(source, viewerId)
            is ClientboundExplodePacket -> projectExplode(source, viewerId)
            is ClientboundSystemChatPacket -> projectSystemChat(source, viewerId)
            is ClientboundDisguisedChatPacket -> projectDisguisedChat(source, viewerId)
            is ClientboundPlayerChatPacket -> projectPlayerChat(source, viewerId)
            is ClientboundSetActionBarTextPacket -> projectActionBar(source, viewerId)
            is ClientboundSetTitleTextPacket -> projectTitle(source, viewerId)
            is ClientboundSetSubtitleTextPacket -> projectSubtitle(source, viewerId)
            is ClientboundTabListPacket -> projectTabList(source, viewerId)
            is ClientboundOpenScreenPacket -> projectOpenScreen(source, viewerId)
            is ClientboundCommandSuggestionsPacket -> projectCommandSuggestions(source, viewerId)
            is ClientboundMapItemDataPacket -> projectMapData(source, viewerId)
            is ClientboundPlayerInfoUpdatePacket -> projectPlayerInfo(source, viewerId)
            is ClientboundDisconnectPacket -> projectDisconnect(source, viewerId)
            is ClientboundResourcePackPushPacket -> projectResourcePackPush(source, viewerId)
            is ClientboundServerLinksPacket -> projectServerLinks(source, viewerId)
            is ClientboundShowDialogPacket -> projectShowDialog(source, viewerId)
            is ClientboundBossEventPacket -> projectBossEvent(source, viewerId)
            is ClientboundSetObjectivePacket -> projectObjective(source, viewerId)
            is ClientboundSetPlayerTeamPacket -> projectTeam(source, viewerId)
            is ClientboundSetScorePacket -> projectScore(source, viewerId)
            is ClientboundUpdateAdvancementsPacket -> projectAdvancements(source, viewerId)
            is ClientboundUpdateRecipesPacket -> projectUpdateRecipes(source, viewerId)
            is ClientboundRecipeBookAddPacket -> projectRecipeBook(source, viewerId)
            is ClientboundPlaceGhostRecipePacket -> projectGhostRecipe(source, viewerId)
            is ClientboundPlayerCombatKillPacket -> projectCombatKill(source, viewerId)
            is ClientboundServerDataPacket -> projectServerData(source, viewerId)
            is ClientboundTestInstanceBlockStatus -> projectTestStatus(source, viewerId)
            is ClientboundTagQueryPacket -> projectTagQuery(source, viewerId)
            is ClientboundBlockEntityDataPacket -> projectBlockEntityData(source, viewerId)
            is ClientboundLevelChunkWithLightPacket -> projectLevelChunk(source, viewerId)
            is ClientboundBundlePacket -> projectBundle(source, viewerId, budget)
            is ClientboundStatusResponsePacket -> projectStatusResponse(source, viewerId)
            is ClientboundRegistryDataPacket -> projectRegistryData(source, viewerId)
            is ClientboundLoginDisconnectPacket -> projectLoginDisconnect(source, viewerId)
            else -> source
        }
    }

    private fun projectStatusResponse(
        source: ClientboundStatusResponsePacket,
        viewerId: UUID,
    ): ClientboundStatusResponsePacket {
        val status = source.status()
        val description = structuredPayloadProjector.projectComponent(status.description(), viewerId)
        if (description === status.description()) return source
        return ClientboundStatusResponsePacket(
            ServerStatus(
                description,
                status.players(),
                status.version(),
                status.favicon(),
                status.enforcesSecureChat(),
            ),
        )
    }

    private fun projectRegistryData(
        source: ClientboundRegistryDataPacket,
        viewerId: UUID,
    ): ClientboundRegistryDataPacket {
        requireProjectionInput(source.entries().size <= limits.structuredEntries) {
            "Registry data packet exceeds the projection entry limit"
        }
        val session = canonicalNbtProjector.newSession(
            viewerId,
            requireRegistryAccess(),
            currentItemBudget().nbtBudget,
        )
        var changed = false
        val entries = source.entries().map { entry ->
            if (entry.data().isEmpty) {
                entry
            } else {
                val original = entry.data().orElseThrow()
                val projected = session.project(original)
                if (!projected.changed) {
                    entry
                } else {
                    changed = true
                    RegistrySynchronization.PackedRegistryEntry(entry.id(), Optional.of(projected.tag))
                }
            }
        }
        return if (!changed) {
            source
        } else {
            ClientboundRegistryDataPacket(source.registry(), java.util.List.copyOf(entries))
        }
    }

    private fun projectLoginDisconnect(
        source: ClientboundLoginDisconnectPacket,
        viewerId: UUID,
    ): ClientboundLoginDisconnectPacket {
        val reason = structuredPayloadProjector.projectComponent(source.reason(), viewerId)
        return if (reason === source.reason()) source else ClientboundLoginDisconnectPacket(reason)
    }

    private fun projectContainerContent(
        source: ClientboundContainerSetContentPacket,
        viewerId: UUID,
    ): ClientboundContainerSetContentPacket {
        var changed = false
        val projectedItems = ArrayList<ItemStack>(source.items().size)
        source.items().forEach { item ->
            val projected = inventoryItemProjector.project(item, viewerId)
            projectedItems += projected
            changed = changed || projected !== item
        }
        val projectedCarried = inventoryItemProjector.project(source.carriedItem(), viewerId)
        changed = changed || projectedCarried !== source.carriedItem()
        if (!changed) {
            return source
        }
        return ClientboundContainerSetContentPacket(
            source.containerId(),
            source.stateId(),
            java.util.List.copyOf(projectedItems),
            projectedCarried,
        )
    }

    private fun projectContainerSlot(
        source: ClientboundContainerSetSlotPacket,
        viewerId: UUID,
    ): ClientboundContainerSetSlotPacket {
        val projected = inventoryItemProjector.project(source.item, viewerId)
        if (projected === source.item) {
            return source
        }
        return ClientboundContainerSetSlotPacket(
            source.containerId,
            source.stateId,
            source.slot,
            projected,
        )
    }

    private fun projectCursor(
        source: ClientboundSetCursorItemPacket,
        viewerId: UUID,
    ): ClientboundSetCursorItemPacket {
        val projected = inventoryItemProjector.project(source.contents(), viewerId)
        return if (projected === source.contents()) source else ClientboundSetCursorItemPacket(projected)
    }

    private fun projectPlayerInventory(
        source: ClientboundSetPlayerInventoryPacket,
        viewerId: UUID,
    ): ClientboundSetPlayerInventoryPacket {
        val projected = inventoryItemProjector.project(source.contents(), viewerId)
        return if (projected === source.contents()) {
            source
        } else {
            ClientboundSetPlayerInventoryPacket(source.slot(), projected)
        }
    }

    private fun projectEquipment(
        source: ClientboundSetEquipmentPacket,
        viewerId: UUID,
    ): ClientboundSetEquipmentPacket {
        var changed = false
        val projectedSlots = ArrayList<Pair<EquipmentSlot, ItemStack>>(source.slots.size)
        source.slots.forEach { entry ->
            val item = entry.second
            val projected = recursiveItemProjector.project(item, viewerId)
            projectedSlots += if (projected === item) entry else Pair.of(entry.first, projected)
            changed = changed || projected !== item
        }
        if (!changed) {
            return source
        }
        return ClientboundSetEquipmentPacket(
            source.entity,
            java.util.List.copyOf(projectedSlots),
            NmsEquipmentPacketAccess.sanitize(source),
        )
    }

    private fun projectMerchantOffers(
        source: ClientboundMerchantOffersPacket,
        viewerId: UUID,
    ): ClientboundMerchantOffersPacket {
        var changed = false
        val offers = MerchantOffers()
        source.offers.forEach { offer ->
            val projected = projectMerchantOffer(offer, viewerId)
            changed = changed || projected !== offer
            offers += projected
        }
        if (!changed) {
            return source
        }
        return ClientboundMerchantOffersPacket(
            source.containerId,
            offers,
            source.villagerLevel,
            source.villagerXp,
            source.showProgress(),
            source.canRestock(),
        )
    }

    private fun projectMerchantOffer(source: MerchantOffer, viewerId: UUID): MerchantOffer {
        val costA = projectItemCost(source.itemCostA, viewerId)
        val originalCostB = source.itemCostB
        val costB = if (originalCostB.isEmpty) {
            originalCostB
        } else {
            val original = originalCostB.orElseThrow()
            val projected = projectItemCost(original, viewerId)
            if (projected === original) originalCostB else Optional.of(projected)
        }
        // Merchant contents are a display surface. They need the stable marker so a creative
        // middle-click copy cannot become an unmanaged forged item, but the display itself must
        // never mint a restoration capability.
        val result = merchantCostItemProjector.project(source.result, viewerId)
        if (costA === source.itemCostA && costB == originalCostB && result === source.result) {
            return source
        }

        return MerchantOffer(
            costA,
            costB,
            result,
            source.uses,
            source.maxUses,
            source.xp,
            source.priceMultiplier,
            source.demand,
        ).also { projected ->
            projected.rewardExp = source.shouldRewardExp()
            projected.specialPriceDiff = source.specialPriceDiff
            projected.ignoreDiscounts = source.ignoreDiscounts
        }
    }

    private fun projectItemCost(source: ItemCost, viewerId: UUID): ItemCost {
        val original = source.itemStack()
        val projected = merchantCostItemProjector.project(original, viewerId)
        if (projected === original) {
            return source
        }

        val positiveComponents = projected.componentsPatch.split().added()
        return ItemCost(
            source.item(),
            source.count(),
            DataComponentExactPredicate.allOf(positiveComponents),
        )
    }

    private fun projectEntityData(
        source: ClientboundSetEntityDataPacket,
        viewerId: UUID,
    ): ClientboundSetEntityDataPacket {
        var changed = false
        val payloadBudget = currentPayloadBudget()
        val values = source.packedItems().map { value ->
            val projected = projectEntityDataValue(value, viewerId, payloadBudget)
            changed = changed || projected !== value
            projected
        }
        return if (!changed) {
            source
        } else {
            ClientboundSetEntityDataPacket(source.id(), java.util.List.copyOf(values))
        }
    }

    private fun projectEntityDataValue(
        source: SynchedEntityData.DataValue<*>,
        viewerId: UUID,
        payloadBudget: NmsPayloadProjectionBudget,
    ): SynchedEntityData.DataValue<*> {
        val serializer = source.serializer()
        val projected: Any = when {
            serializer === EntityDataSerializers.ITEM_STACK ->
                recursiveItemProjector.project(source.value() as ItemStack, viewerId)
            serializer === EntityDataSerializers.PARTICLE ->
                projectParticle(source.value() as ParticleOptions, viewerId)
            serializer === EntityDataSerializers.PARTICLES ->
                projectParticles(source.value() as List<*>, viewerId)
            serializer === EntityDataSerializers.COMPONENT ->
                structuredPayloadProjector.projectComponent(source.value() as Component, viewerId, payloadBudget)
            serializer === EntityDataSerializers.OPTIONAL_COMPONENT ->
                projectOptionalComponent(source.value() as Optional<*>, viewerId, payloadBudget)
            else -> return source
        }
        return if (projected === source.value()) source else rebuildDataValue(source, projected)
    }

    private fun projectLevelParticles(
        source: ClientboundLevelParticlesPacket,
        viewerId: UUID,
    ): ClientboundLevelParticlesPacket {
        val particle = projectParticle(source.particle, viewerId)
        if (particle === source.particle) {
            return source
        }
        return ClientboundLevelParticlesPacket(
            particle,
            source.isOverrideLimiter,
            source.alwaysShow(),
            source.x,
            source.y,
            source.z,
            source.xDist,
            source.yDist,
            source.zDist,
            source.maxSpeed,
            source.count,
        )
    }

    private fun projectExplode(
        source: ClientboundExplodePacket,
        viewerId: UUID,
    ): ClientboundExplodePacket {
        val particle = projectParticle(source.explosionParticle(), viewerId)
        return if (particle === source.explosionParticle()) {
            source
        } else {
            ClientboundExplodePacket(
                source.center(),
                source.radius(),
                source.blockCount(),
                source.playerKnockback(),
                particle,
                source.explosionSound(),
                source.blockParticles(),
            )
        }
    }

    private fun projectParticle(source: ParticleOptions, viewerId: UUID): ParticleOptions {
        if (source !is ItemParticleOption) {
            return source
        }
        val item = recursiveItemProjector.project(source.item, viewerId)
        return if (item === source.item) source else ItemParticleOption(source.type, item)
    }

    private fun projectParticles(source: List<*>, viewerId: UUID): List<*> {
        var changed = false
        val particles = source.map { value ->
            val particle = value as? ParticleOptions
                ?: error("PARTICLES entity data contains a non-particle value")
            val projected = projectParticle(particle, viewerId)
            changed = changed || projected !== particle
            projected
        }
        return if (!changed) source else java.util.List.copyOf(particles)
    }

    private fun projectOptionalComponent(
        source: Optional<*>,
        viewerId: UUID,
        payloadBudget: NmsPayloadProjectionBudget,
    ): Optional<*> {
        if (source.isEmpty) {
            return source
        }
        val component = source.orElseThrow() as? Component
            ?: error("OPTIONAL_COMPONENT entity data contains a non-component value")
        val projected = structuredPayloadProjector.projectComponent(component, viewerId, payloadBudget)
        return if (projected === component) source else Optional.of(projected)
    }

    private fun projectSystemChat(
        source: ClientboundSystemChatPacket,
        viewerId: UUID,
    ): ClientboundSystemChatPacket {
        val content = structuredPayloadProjector.projectComponent(source.content(), viewerId)
        return if (content === source.content()) source else ClientboundSystemChatPacket(content, source.overlay())
    }

    private fun projectDisguisedChat(
        source: ClientboundDisguisedChatPacket,
        viewerId: UUID,
    ): ClientboundDisguisedChatPacket {
        val message = structuredPayloadProjector.projectComponent(source.message(), viewerId)
        val chatType = projectChatType(source.chatType(), viewerId)
        return if (message === source.message() && chatType === source.chatType()) {
            source
        } else {
            ClientboundDisguisedChatPacket(message, chatType)
        }
    }

    private fun projectPlayerChat(
        source: ClientboundPlayerChatPacket,
        viewerId: UUID,
    ): ClientboundPlayerChatPacket {
        val unsignedContent = source.unsignedContent()?.let { component ->
            structuredPayloadProjector.projectComponent(component, viewerId)
        }
        val chatType = projectChatType(source.chatType(), viewerId)
        return if (unsignedContent === source.unsignedContent() && chatType === source.chatType()) {
            source
        } else {
            ClientboundPlayerChatPacket(
                source.globalIndex(),
                source.sender(),
                source.index(),
                source.signature(),
                source.body(),
                unsignedContent,
                source.filterMask(),
                chatType,
            )
        }
    }

    private fun projectChatType(source: ChatType.Bound, viewerId: UUID): ChatType.Bound {
        val name = structuredPayloadProjector.projectComponent(source.name(), viewerId)
        val targetName = projectComponentOptional(source.targetName(), viewerId)
        return if (name === source.name() && targetName == source.targetName()) {
            source
        } else {
            ChatType.Bound(source.chatType(), name, targetName)
        }
    }

    private fun projectActionBar(
        source: ClientboundSetActionBarTextPacket,
        viewerId: UUID,
    ): ClientboundSetActionBarTextPacket {
        val text = structuredPayloadProjector.projectComponent(source.text(), viewerId)
        return if (text === source.text()) source else ClientboundSetActionBarTextPacket(text)
    }

    private fun projectTitle(
        source: ClientboundSetTitleTextPacket,
        viewerId: UUID,
    ): ClientboundSetTitleTextPacket {
        val text = structuredPayloadProjector.projectComponent(source.text(), viewerId)
        return if (text === source.text()) source else ClientboundSetTitleTextPacket(text)
    }

    private fun projectSubtitle(
        source: ClientboundSetSubtitleTextPacket,
        viewerId: UUID,
    ): ClientboundSetSubtitleTextPacket {
        val text = structuredPayloadProjector.projectComponent(source.text(), viewerId)
        return if (text === source.text()) source else ClientboundSetSubtitleTextPacket(text)
    }

    private fun projectTabList(
        source: ClientboundTabListPacket,
        viewerId: UUID,
    ): ClientboundTabListPacket {
        val header = structuredPayloadProjector.projectComponent(source.header(), viewerId)
        val footer = structuredPayloadProjector.projectComponent(source.footer(), viewerId)
        return if (header === source.header() && footer === source.footer()) {
            source
        } else {
            ClientboundTabListPacket(header, footer)
        }
    }

    private fun projectOpenScreen(
        source: ClientboundOpenScreenPacket,
        viewerId: UUID,
    ): ClientboundOpenScreenPacket {
        val title = structuredPayloadProjector.projectComponent(source.title, viewerId)
        return if (title === source.title) {
            source
        } else {
            ClientboundOpenScreenPacket(source.containerId, source.type, title)
        }
    }

    private fun projectCommandSuggestions(
        source: ClientboundCommandSuggestionsPacket,
        viewerId: UUID,
    ): ClientboundCommandSuggestionsPacket {
        var changed = false
        val payloadBudget = currentPayloadBudget()
        val suggestions = source.suggestions().map { entry ->
            val tooltip = projectComponentOptional(entry.tooltip(), viewerId, payloadBudget)
            if (tooltip == entry.tooltip()) {
                entry
            } else {
                changed = true
                ClientboundCommandSuggestionsPacket.Entry(entry.text(), tooltip)
            }
        }
        return if (!changed) {
            source
        } else {
            ClientboundCommandSuggestionsPacket(
                source.id(),
                source.start(),
                source.length(),
                java.util.List.copyOf(suggestions),
            )
        }
    }

    private fun projectMapData(
        source: ClientboundMapItemDataPacket,
        viewerId: UUID,
    ): ClientboundMapItemDataPacket {
        val originalDecorations = source.decorations()
        if (originalDecorations.isEmpty) {
            return source
        }
        var changed = false
        val payloadBudget = currentPayloadBudget()
        val decorations = originalDecorations.orElseThrow().map { decoration ->
            val name = projectComponentOptional(decoration.name(), viewerId, payloadBudget)
            if (name == decoration.name()) {
                decoration
            } else {
                changed = true
                MapDecoration(decoration.type(), decoration.x(), decoration.y(), decoration.rot(), name)
            }
        }
        return if (!changed) {
            source
        } else {
            ClientboundMapItemDataPacket(
                source.mapId(),
                source.scale(),
                source.locked(),
                Optional.of(java.util.List.copyOf(decorations)),
                source.colorPatch(),
            )
        }
    }

    private fun projectPlayerInfo(
        source: ClientboundPlayerInfoUpdatePacket,
        viewerId: UUID,
    ): ClientboundPlayerInfoUpdatePacket {
        var changed = false
        val payloadBudget = currentPayloadBudget()
        val entries = source.entries().map { entry ->
            val originalName = entry.displayName()
            val displayName = originalName?.let { component ->
                structuredPayloadProjector.projectComponent(component, viewerId, payloadBudget)
            }
            if (displayName === originalName) {
                entry
            } else {
                changed = true
                ClientboundPlayerInfoUpdatePacket.Entry(
                    entry.profileId(),
                    entry.profile(),
                    entry.listed(),
                    entry.latency(),
                    entry.gameMode(),
                    displayName,
                    entry.showHat(),
                    entry.listOrder(),
                    entry.chatSession(),
                )
            }
        }
        return if (!changed) {
            source
        } else {
            ClientboundPlayerInfoUpdatePacket(
                java.util.EnumSet.copyOf(source.actions()),
                java.util.List.copyOf(entries),
            )
        }
    }

    private fun projectDisconnect(
        source: ClientboundDisconnectPacket,
        viewerId: UUID,
    ): ClientboundDisconnectPacket {
        val reason = structuredPayloadProjector.projectComponent(source.reason(), viewerId)
        return if (reason === source.reason()) source else ClientboundDisconnectPacket(reason)
    }

    private fun projectResourcePackPush(
        source: ClientboundResourcePackPushPacket,
        viewerId: UUID,
    ): ClientboundResourcePackPushPacket {
        val prompt = projectComponentOptional(source.prompt(), viewerId)
        return if (prompt == source.prompt()) {
            source
        } else {
            ClientboundResourcePackPushPacket(
                source.id(),
                source.url(),
                source.hash(),
                source.required(),
                prompt,
            )
        }
    }

    private fun projectServerLinks(
        source: ClientboundServerLinksPacket,
        viewerId: UUID,
    ): ClientboundServerLinksPacket {
        requireProjectionInput(source.links().size <= limits.structuredEntries) {
            "Server links packet exceeds the projection entry limit"
        }
        var changed = false
        val payloadBudget = currentPayloadBudget()
        val links = source.links().map { entry ->
            val customLabel = entry.type().right()
            if (customLabel.isEmpty) {
                entry
            } else {
                val original = customLabel.orElseThrow()
                val projected = structuredPayloadProjector.projectComponent(original, viewerId, payloadBudget)
                if (projected === original) {
                    entry
                } else {
                    changed = true
                    ServerLinks.UntrustedEntry(Either.right(projected), entry.link())
                }
            }
        }
        return if (!changed) {
            source
        } else {
            ClientboundServerLinksPacket(java.util.List.copyOf(links))
        }
    }

    private fun projectShowDialog(
        source: ClientboundShowDialogPacket,
        viewerId: UUID,
    ): ClientboundShowDialogPacket {
        val dialog = structuredPayloadProjector.projectDialog(source.dialog(), viewerId)
        return if (dialog === source.dialog()) source else ClientboundShowDialogPacket(dialog)
    }

    private fun projectBossEvent(
        source: ClientboundBossEventPacket,
        viewerId: UUID,
    ): ClientboundBossEventPacket {
        var result = source
        source.dispatch(object : ClientboundBossEventPacket.Handler {
            override fun add(
                id: UUID,
                name: Component,
                progress: Float,
                color: BossEvent.BossBarColor,
                overlay: BossEvent.BossBarOverlay,
                darkenScreen: Boolean,
                playMusic: Boolean,
                createWorldFog: Boolean,
            ) {
                val projected = structuredPayloadProjector.projectComponent(name, viewerId)
                if (projected === name) return
                val event = object : BossEvent(id, projected, color, overlay) {}
                event.progress = progress
                event.setDarkenScreen(darkenScreen)
                event.setPlayBossMusic(playMusic)
                event.setCreateWorldFog(createWorldFog)
                result = ClientboundBossEventPacket.createAddPacket(event)
            }

            override fun updateName(id: UUID, name: Component) {
                val projected = structuredPayloadProjector.projectComponent(name, viewerId)
                if (projected === name) return
                val event = object : BossEvent(
                    id,
                    projected,
                    BossEvent.BossBarColor.WHITE,
                    BossEvent.BossBarOverlay.PROGRESS,
                ) {}
                result = ClientboundBossEventPacket.createUpdateNamePacket(event)
            }
        })
        return result
    }

    private fun projectObjective(
        source: ClientboundSetObjectivePacket,
        viewerId: UUID,
    ): ClientboundSetObjectivePacket {
        if (source.method != ClientboundSetObjectivePacket.METHOD_ADD &&
            source.method != ClientboundSetObjectivePacket.METHOD_CHANGE
        ) {
            return source
        }
        val displayName = structuredPayloadProjector.projectComponent(source.displayName, viewerId)
        val numberFormat = projectNumberFormatOptional(source.numberFormat, viewerId)
        if (displayName === source.displayName && numberFormat == source.numberFormat) {
            return source
        }
        val objective = Objective(
            Scoreboard(),
            source.objectiveName,
            ObjectiveCriteria.DUMMY,
            displayName,
            source.renderType,
            false,
            numberFormat.orElse(null),
        )
        return ClientboundSetObjectivePacket(objective, source.method)
    }

    private fun projectTeam(
        source: ClientboundSetPlayerTeamPacket,
        viewerId: UUID,
    ): ClientboundSetPlayerTeamPacket {
        if (source.parameters.isEmpty) {
            return source
        }
        val parameters = source.parameters.orElseThrow()
        val displayName = structuredPayloadProjector.projectComponent(parameters.displayName, viewerId)
        val prefix = structuredPayloadProjector.projectComponent(parameters.playerPrefix, viewerId)
        val suffix = structuredPayloadProjector.projectComponent(parameters.playerSuffix, viewerId)
        if (
            displayName === parameters.displayName &&
            prefix === parameters.playerPrefix &&
            suffix === parameters.playerSuffix
        ) {
            return source
        }

        val team = PlayerTeam(Scoreboard(), source.name)
        team.setDisplayName(displayName)
        team.setPlayerPrefix(prefix)
        team.setPlayerSuffix(suffix)
        team.setNameTagVisibility(parameters.nameTagVisibility)
        team.setCollisionRule(parameters.collisionRule)
        team.setColor(parameters.color)
        team.unpackOptions(parameters.options)
        val createNew = source.teamAction == ClientboundSetPlayerTeamPacket.Action.ADD
        if (createNew) {
            team.players.addAll(source.players)
        }
        return ClientboundSetPlayerTeamPacket.createAddOrModifyPacket(team, createNew)
    }

    private fun projectScore(
        source: ClientboundSetScorePacket,
        viewerId: UUID,
    ): ClientboundSetScorePacket {
        val display = projectComponentOptional(source.display(), viewerId)
        val numberFormat = projectNumberFormatOptional(source.numberFormat(), viewerId)
        return if (display == source.display() && numberFormat == source.numberFormat()) {
            source
        } else {
            ClientboundSetScorePacket(
                source.owner(),
                source.objectiveName(),
                source.score(),
                display,
                numberFormat,
            )
        }
    }

    private fun projectAdvancements(
        source: ClientboundUpdateAdvancementsPacket,
        viewerId: UUID,
    ): ClientboundUpdateAdvancementsPacket {
        requireProjectionInput(source.added.size <= limits.structuredEntries) {
            "Advancement packet exceeds the projection entry limit"
        }
        var changed = false
        val payloadBudget = currentPayloadBudget()
        val added = source.added.map { advancement ->
            val projected = structuredPayloadProjector.projectAdvancement(
                advancement,
                viewerId,
                payloadBudget,
                depth = 0,
            )
            changed = changed || projected !== advancement
            projected
        }
        return if (!changed) {
            source
        } else {
            ClientboundUpdateAdvancementsPacket(
                source.shouldReset(),
                java.util.List.copyOf(added),
                source.removed,
                source.progress,
                source.shouldShowAdvancements(),
            )
        }
    }

    private fun projectUpdateRecipes(
        source: ClientboundUpdateRecipesPacket,
        viewerId: UUID,
    ): ClientboundUpdateRecipesPacket {
        requireProjectionInput(source.stonecutterRecipes().entries().size <= limits.structuredEntries) {
            "Stonecutter recipe packet exceeds the projection entry limit"
        }
        val recipes = structuredPayloadProjector.projectStonecutterRecipes(source.stonecutterRecipes(), viewerId)
        return if (recipes === source.stonecutterRecipes()) {
            source
        } else {
            ClientboundUpdateRecipesPacket(java.util.Map.copyOf(source.itemSets()), recipes)
        }
    }

    private fun projectRecipeBook(
        source: ClientboundRecipeBookAddPacket,
        viewerId: UUID,
    ): ClientboundRecipeBookAddPacket {
        requireProjectionInput(source.entries().size <= limits.structuredEntries) {
            "Recipe book packet exceeds the projection entry limit"
        }
        var changed = false
        val payloadBudget = currentPayloadBudget()
        val entries = source.entries().map { entry ->
            val contents = structuredPayloadProjector.projectRecipeDisplayEntry(
                entry.contents(),
                viewerId,
                payloadBudget,
                depth = 0,
            )
            if (contents === entry.contents()) {
                entry
            } else {
                changed = true
                ClientboundRecipeBookAddPacket.Entry(contents, entry.flags())
            }
        }
        return if (!changed) {
            source
        } else {
            ClientboundRecipeBookAddPacket(java.util.List.copyOf(entries), source.replace())
        }
    }

    private fun projectGhostRecipe(
        source: ClientboundPlaceGhostRecipePacket,
        viewerId: UUID,
    ): ClientboundPlaceGhostRecipePacket {
        val display = structuredPayloadProjector.projectRecipeDisplay(source.recipeDisplay(), viewerId)
        return if (display === source.recipeDisplay()) {
            source
        } else {
            ClientboundPlaceGhostRecipePacket(source.containerId(), display)
        }
    }

    private fun projectCombatKill(
        source: ClientboundPlayerCombatKillPacket,
        viewerId: UUID,
    ): ClientboundPlayerCombatKillPacket {
        val message = structuredPayloadProjector.projectComponent(source.message(), viewerId)
        return if (message === source.message()) source else ClientboundPlayerCombatKillPacket(source.playerId(), message)
    }

    private fun projectServerData(
        source: ClientboundServerDataPacket,
        viewerId: UUID,
    ): ClientboundServerDataPacket {
        val motd = structuredPayloadProjector.projectComponent(source.motd(), viewerId)
        return if (motd === source.motd()) source else ClientboundServerDataPacket(motd, source.iconBytes())
    }

    private fun projectTestStatus(
        source: ClientboundTestInstanceBlockStatus,
        viewerId: UUID,
    ): ClientboundTestInstanceBlockStatus {
        val status = structuredPayloadProjector.projectComponent(source.status(), viewerId)
        return if (status === source.status()) source else ClientboundTestInstanceBlockStatus(status, source.size())
    }

    private fun projectTagQuery(
        source: ClientboundTagQueryPacket,
        viewerId: UUID,
    ): ClientboundTagQueryPacket {
        val sourceTag = source.tag ?: return source
        val session = canonicalNbtProjector.newSession(
            viewerId,
            requireRegistryAccess(),
            currentItemBudget().nbtBudget,
        )
        val projected = session.project(sourceTag)
        return if (!projected.changed) {
            source
        } else {
            ClientboundTagQueryPacket(source.transactionId, projected.tag)
        }
    }

    private fun projectBlockEntityData(
        source: ClientboundBlockEntityDataPacket,
        viewerId: UUID,
    ): ClientboundBlockEntityDataPacket {
        val session = canonicalNbtProjector.newSession(
            viewerId,
            requireRegistryAccess(),
            currentItemBudget().nbtBudget,
        )
        val projected = session.project(source.tag)
        return if (!projected.changed) {
            source
        } else {
            ClientboundBlockEntityDataPacket(source.pos, source.type, projected.tag)
        }
    }

    private fun projectLevelChunk(
        source: ClientboundLevelChunkWithLightPacket,
        viewerId: UUID,
    ): ClientboundLevelChunkWithLightPacket {
        val registryAccess = requireRegistryAccess()
        val copy = NmsChunkPacketAccess.wireCopy(source, registryAccess, limits.chunkPacketBytes)
        val session = canonicalNbtProjector.newSession(
            viewerId,
            registryAccess,
            currentItemBudget().nbtBudget,
        )
        val changed = NmsChunkPacketAccess.rewriteBlockEntityTags(copy, session::project)
        return if (changed) copy else source
    }

    private fun requireRegistryAccess(): RegistryAccess = registryAccessSource()
        ?: throw NmsProjectionInfrastructureException(
            "Registry access is unavailable for canonical NBT projection",
        )

    private fun currentItemBudget(): NmsPacketItemProjectionBudget = packetItemBudget
        ?: throw NmsProjectionInfrastructureException("Packet item budget is unavailable")

    private fun currentPayloadBudget(): NmsPayloadProjectionBudget = packetPayloadBudget
        ?: throw NmsProjectionInfrastructureException("Packet payload budget is unavailable")

    private fun projectNumberFormatOptional(
        source: Optional<NumberFormat>,
        viewerId: UUID,
    ): Optional<NumberFormat> {
        if (source.isEmpty) return source
        val original = source.orElseThrow()
        val projected = structuredPayloadProjector.projectNumberFormat(original, viewerId)
        return if (projected === original) source else Optional.of(projected)
    }

    private fun projectComponentOptional(
        source: Optional<Component>,
        viewerId: UUID,
        payloadBudget: NmsPayloadProjectionBudget? = null,
    ): Optional<Component> {
        if (source.isEmpty) {
            return source
        }
        val original = source.orElseThrow()
        val projected = if (payloadBudget == null) {
            structuredPayloadProjector.projectComponent(original, viewerId)
        } else {
            structuredPayloadProjector.projectComponent(original, viewerId, payloadBudget)
        }
        return if (projected === original) source else Optional.of(projected)
    }

    @Suppress("UNCHECKED_CAST")
    private fun rebuildDataValue(
        source: SynchedEntityData.DataValue<*>,
        value: Any,
    ): SynchedEntityData.DataValue<*> = SynchedEntityData.DataValue(
        source.id(),
        source.serializer() as EntityDataSerializer<Any>,
        value,
    )

    private fun projectBundle(
        source: ClientboundBundlePacket,
        viewerId: UUID,
        budget: ProjectionBudget,
    ): ClientboundBundlePacket {
        budget.enterBundle()
        try {
            var changed = false
            val projectedPackets = ArrayList<Packet<in ClientGamePacketListener>>()
            source.subPackets().forEach { packet ->
                val projected = project(packet, viewerId, budget)
                @Suppress("UNCHECKED_CAST")
                projectedPackets += projected as Packet<in ClientGamePacketListener>
                changed = changed || projected !== packet
            }
            if (!changed) {
                return source
            }
            return ClientboundBundlePacket(java.util.List.copyOf(projectedPackets))
        } finally {
            budget.leaveBundle()
        }
    }

    private class ProjectionBudget(
        private val limits: NmsProjectionLimits,
    ) {
        private var packetCount = 0
        private var bundleDepth = 0

        fun enterPacket() {
            packetCount++
            requireProjectionInput(packetCount <= limits.packets) {
                "Outbound bundle exceeds the packet projection limit"
            }
        }

        fun enterBundle() {
            bundleDepth++
            requireProjectionInput(bundleDepth <= limits.bundleDepth) {
                "Outbound bundle exceeds the recursion limit"
            }
        }

        fun leaveBundle() {
            bundleDepth--
        }
    }

    private companion object {
        val UNBOUND_VIEWER_ID: UUID = UUID(0L, 0L)
    }
}

/** Exact-version access to Paper's private equipment sanitization flag. */
internal object NmsEquipmentPacketAccess {
    private val sanitizeField: Field = ClientboundSetEquipmentPacket::class.java
        .getDeclaredField("sanitize")
        .also { field ->
            check(field.type == Boolean::class.javaPrimitiveType) {
                "ClientboundSetEquipmentPacket.sanitize is not boolean"
            }
            check(!Modifier.isStatic(field.modifiers)) {
                "ClientboundSetEquipmentPacket.sanitize unexpectedly became static"
            }
            check(field.trySetAccessible()) {
                "Cannot access ClientboundSetEquipmentPacket.sanitize"
            }
        }

    fun sanitize(packet: ClientboundSetEquipmentPacket): Boolean = sanitizeField.getBoolean(packet)

    fun verifyAbi() {
        check(Modifier.isPrivate(sanitizeField.modifiers)) {
            "ClientboundSetEquipmentPacket.sanitize is no longer private"
        }
    }
}

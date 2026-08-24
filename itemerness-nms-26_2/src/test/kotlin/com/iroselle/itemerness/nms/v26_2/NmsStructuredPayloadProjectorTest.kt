package com.iroselle.itemerness.nms.v26_2

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.ItemProjector
import com.iroselle.itemerness.projection.LocaleId
import com.iroselle.itemerness.projection.ProjectionContext
import com.iroselle.itemerness.projection.ProjectionContextSource
import com.iroselle.itemerness.projection.ProjectionGeneration
import com.iroselle.itemerness.projection.ProjectionRefreshAdapter
import com.iroselle.itemerness.projection.ProjectionResyncSink
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.ProjectionRuntime
import com.iroselle.itemerness.projection.RenderedDisplay
import com.iroselle.itemerness.projection.RenderedText
import com.iroselle.itemerness.projection.ViewerProjectionSnapshot
import com.mojang.datafixers.util.Either
import io.papermc.paper.configuration.GlobalConfiguration
import java.util.Optional
import java.util.OptionalInt
import java.util.UUID
import net.minecraft.SharedConstants
import net.minecraft.advancements.Advancement
import net.minecraft.advancements.AdvancementHolder
import net.minecraft.advancements.AdvancementRequirements
import net.minecraft.advancements.AdvancementRewards
import net.minecraft.advancements.AdvancementType
import net.minecraft.advancements.DisplayInfo
import net.minecraft.core.Holder
import net.minecraft.core.HolderSet
import net.minecraft.core.RegistryAccess
import net.minecraft.core.component.DataComponentMap
import net.minecraft.core.component.DataComponents
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.nbt.CompoundTag
import net.minecraft.nbt.NbtOps
import net.minecraft.network.chat.ClickEvent
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.HoverEvent
import net.minecraft.network.chat.Style
import net.minecraft.network.chat.numbers.FixedFormat
import net.minecraft.network.chat.numbers.StyledFormat
import net.minecraft.network.protocol.common.ClientboundServerLinksPacket
import net.minecraft.network.protocol.common.ClientboundDisconnectPacket
import net.minecraft.network.protocol.common.ClientboundResourcePackPushPacket
import net.minecraft.network.protocol.common.ClientboundShowDialogPacket
import net.minecraft.network.protocol.common.ServerboundCustomClickActionPacket
import net.minecraft.network.protocol.game.ClientboundBossEventPacket
import net.minecraft.network.protocol.game.ClientboundBundlePacket
import net.minecraft.network.protocol.game.ClientboundPlaceGhostRecipePacket
import net.minecraft.network.protocol.game.ClientboundPlayerCombatKillPacket
import net.minecraft.network.protocol.game.ClientboundRecipeBookAddPacket
import net.minecraft.network.protocol.game.ClientboundServerDataPacket
import net.minecraft.network.protocol.game.ClientboundSetObjectivePacket
import net.minecraft.network.protocol.game.ClientboundSetPlayerTeamPacket
import net.minecraft.network.protocol.game.ClientboundSetScorePacket
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket
import net.minecraft.network.protocol.game.ClientboundTestInstanceBlockStatus
import net.minecraft.network.protocol.game.ClientboundUpdateAdvancementsPacket
import net.minecraft.network.protocol.game.ClientboundUpdateRecipesPacket
import net.minecraft.resources.Identifier
import net.minecraft.server.Bootstrap
import net.minecraft.server.ServerLinks
import net.minecraft.server.dialog.ActionButton
import net.minecraft.server.dialog.CommonButtonData
import net.minecraft.server.dialog.CommonDialogData
import net.minecraft.server.dialog.ConfirmationDialog
import net.minecraft.server.dialog.Dialog
import net.minecraft.server.dialog.DialogAction
import net.minecraft.server.dialog.DialogListDialog
import net.minecraft.server.dialog.Input
import net.minecraft.server.dialog.MultiActionDialog
import net.minecraft.server.dialog.NoticeDialog
import net.minecraft.server.dialog.ServerLinksDialog
import net.minecraft.server.dialog.action.Action
import net.minecraft.server.dialog.action.StaticAction
import net.minecraft.server.dialog.action.CustomAll
import net.minecraft.server.dialog.body.ItemBody
import net.minecraft.server.dialog.body.PlainMessage
import net.minecraft.server.dialog.input.BooleanInput
import net.minecraft.server.dialog.input.NumberRangeInput
import net.minecraft.server.dialog.input.SingleOptionInput
import net.minecraft.server.dialog.input.TextInput
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.ItemStackTemplate
import net.minecraft.world.item.Items
import net.minecraft.world.item.component.CustomData
import net.minecraft.world.item.crafting.display.FurnaceRecipeDisplay
import net.minecraft.world.item.crafting.Ingredient
import net.minecraft.world.item.crafting.RecipeBookCategory
import net.minecraft.world.item.crafting.RecipeHolder
import net.minecraft.world.item.crafting.SelectableRecipe
import net.minecraft.world.item.crafting.StonecutterRecipe
import net.minecraft.world.item.crafting.display.RecipeDisplay
import net.minecraft.world.item.crafting.display.RecipeDisplayEntry
import net.minecraft.world.item.crafting.display.RecipeDisplayId
import net.minecraft.world.item.crafting.display.ShapedCraftingRecipeDisplay
import net.minecraft.world.item.crafting.display.ShapelessCraftingRecipeDisplay
import net.minecraft.world.item.crafting.display.SlotDisplay
import net.minecraft.world.item.crafting.display.SmithingRecipeDisplay
import net.minecraft.world.item.crafting.display.StonecutterRecipeDisplay
import net.minecraft.world.item.equipment.trim.TrimPattern
import net.minecraft.world.BossEvent
import net.minecraft.world.scores.Objective
import net.minecraft.world.scores.PlayerTeam
import net.minecraft.world.scores.Scoreboard
import net.minecraft.world.scores.criteria.ObjectiveCriteria
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class NmsStructuredPayloadProjectorTest {
    @Test
    fun `all recipe display and nested slot variants project their item and component leaves`() {
        val leaf = managedSlot()
        val pattern = Holder.direct(
            TrimPattern(Identifier.parse("itemerness:test_pattern"), carrierComponent("pattern"), false),
        )
        val aggregate = SlotDisplay.Composite(
            listOf(
                leaf,
                SlotDisplay.Composite(listOf(leaf)),
                SlotDisplay.DyedSlotDemo(leaf, leaf),
                SlotDisplay.OnlyWithComponent(leaf, DataComponents.CUSTOM_DATA),
                SlotDisplay.SmithingTrimDemoSlotDisplay(leaf, leaf, pattern),
                SlotDisplay.WithAnyPotion(leaf),
                SlotDisplay.WithRemainder(leaf, leaf),
            ),
        )
        val recipes: List<RecipeDisplay> = listOf(
            ShapedCraftingRecipeDisplay(1, 1, listOf(aggregate), aggregate, aggregate),
            ShapelessCraftingRecipeDisplay(listOf(aggregate), aggregate, aggregate),
            FurnaceRecipeDisplay(aggregate, aggregate, aggregate, aggregate, 120, 0.75F),
            SmithingRecipeDisplay(aggregate, aggregate, aggregate, aggregate, aggregate),
            StonecutterRecipeDisplay(aggregate, aggregate, aggregate),
        )
        val projector = structuredProjector()

        recipes.forEach { source ->
            val projected = projector.projectRecipeDisplay(source, VIEWER_ID)

            assertNotSame(source, projected)
            recipeSlots(projected).flatMap(::slotStacks).forEach(::assertProjected)
            val projectedPatterns = recipeSlots(projected).flatMap(::trimPatterns)
            assertTrue(projectedPatterns.isNotEmpty())
            projectedPatterns.forEach { trim -> assertProjectedCarrier(trim.value().description()) }
        }

        recipeSlots(recipes.first()).flatMap(::slotStacks).forEach(::assertCanonical)
        assertCanonical(shownItem(pattern.value().description()))
    }

    @Test
    fun `advancement and number formats preserve their shape while projecting component leaves`() {
        val display = DisplayInfo(
            template(canonicalStack()),
            carrierComponent("title"),
            carrierComponent("description"),
            Optional.empty(),
            AdvancementType.CHALLENGE,
            false,
            true,
            true,
        ).also { it.setLocation(4.5F, -3.25F) }
        val source = AdvancementHolder(
            Identifier.parse("itemerness:test"),
            Advancement(
                Optional.empty(),
                Optional.of(display),
                AdvancementRewards.EMPTY,
                emptyMap(),
                AdvancementRequirements.EMPTY,
                true,
            ),
        )
        val projector = structuredProjector()

        val projected = projector.projectAdvancement(source, VIEWER_ID)
        val projectedDisplay = projected.value().display().orElseThrow()

        assertNotSame(source, projected)
        assertProjected(projectedDisplay.icon.create())
        assertProjectedCarrier(projectedDisplay.title)
        assertProjectedCarrier(projectedDisplay.description)
        assertEquals(AdvancementType.CHALLENGE, projectedDisplay.type)
        assertEquals(4.5F, projectedDisplay.x)
        assertEquals(-3.25F, projectedDisplay.y)
        assertFalse(projectedDisplay.shouldShowToast())
        assertTrue(projectedDisplay.shouldAnnounceChat())
        assertTrue(projectedDisplay.isHidden)
        assertTrue(projected.value().sendsTelemetryEvent())
        assertCanonical(display.icon.create())
        assertCanonical(shownItem(display.title))

        val fixed = FixedFormat(carrierComponent("fixed"))
        val projectedFixed = projector.projectNumberFormat(fixed, VIEWER_ID) as FixedFormat
        assertNotSame(fixed, projectedFixed)
        assertProjectedCarrier(projectedFixed.value())

        val styled = StyledFormat(Style.EMPTY.withHoverEvent(HoverEvent.ShowItem(template(canonicalStack()))))
        val projectedStyled = projector.projectNumberFormat(styled, VIEWER_ID) as StyledFormat
        assertNotSame(styled, projectedStyled)
        assertProjected((projectedStyled.style().hoverEvent as HoverEvent.ShowItem).item().create())
        assertCanonical((styled.style().hoverEvent as HoverEvent.ShowItem).item().create())

        val packet = ClientboundUpdateAdvancementsPacket(
            true,
            listOf(source),
            setOf(Identifier.parse("itemerness:removed")),
            emptyMap(),
            false,
        )
        val projectedPacket = outboundProjector().project(packet, VIEWER_ID) as ClientboundUpdateAdvancementsPacket
        assertNotSame(packet, projectedPacket)
        assertProjected(projectedPacket.added.single().value().display().orElseThrow().icon.create())
        assertTrue(projectedPacket.shouldReset())
        assertFalse(projectedPacket.shouldShowAdvancements())
        assertEquals(packet.removed, projectedPacket.removed)
    }

    @Test
    fun `recipe display entry stonecutter set and every recipe packet envelope are rebuilt`() {
        val slot = managedSlot()
        val display = StonecutterRecipeDisplay(slot, slot, slot)
        val entry = RecipeDisplayEntry(
            RecipeDisplayId(17),
            display,
            OptionalInt.of(9),
            RecipeBookCategory(),
            Optional.empty(),
        )
        val selectable: SelectableRecipe<StonecutterRecipe> = SelectableRecipe(
            slot,
            Optional.empty<RecipeHolder<StonecutterRecipe>>(),
        )
        val stonecutter = SelectableRecipe.SingleInputSet(
            listOf(SelectableRecipe.SingleInputEntry(Ingredient.of(Items.STONE), selectable)),
        )
        val projector = structuredProjector()

        val projectedEntry = projector.projectRecipeDisplayEntry(entry, VIEWER_ID)
        assertNotSame(entry, projectedEntry)
        assertProjected(((projectedEntry.display() as StonecutterRecipeDisplay).result() as SlotDisplay.ItemStackSlotDisplay).stack().create())
        assertEquals(17, projectedEntry.id().index())
        assertEquals(OptionalInt.of(9), projectedEntry.group())

        val projectedSet = projector.projectStonecutterRecipes(stonecutter, VIEWER_ID)
        assertNotSame(stonecutter, projectedSet)
        assertProjected(
            (projectedSet.entries().single().recipe().optionDisplay() as SlotDisplay.ItemStackSlotDisplay).stack().create(),
        )

        val outbound = outboundProjector()
        val book = ClientboundRecipeBookAddPacket(
            listOf(ClientboundRecipeBookAddPacket.Entry(entry, true, true)),
            true,
        )
        val projectedBook = outbound.project(book, VIEWER_ID) as ClientboundRecipeBookAddPacket
        assertNotSame(book, projectedBook)
        assertTrue(projectedBook.replace())
        assertTrue(projectedBook.entries().single().notification())
        assertTrue(projectedBook.entries().single().highlight())
        assertProjected(
            (((projectedBook.entries().single().contents().display() as StonecutterRecipeDisplay).result())
                as SlotDisplay.ItemStackSlotDisplay).stack().create(),
        )

        val update = ClientboundUpdateRecipesPacket(emptyMap(), stonecutter)
        val projectedUpdate = outbound.project(update, VIEWER_ID) as ClientboundUpdateRecipesPacket
        assertNotSame(update, projectedUpdate)
        assertProjected(
            (projectedUpdate.stonecutterRecipes().entries().single().recipe().optionDisplay()
                as SlotDisplay.ItemStackSlotDisplay).stack().create(),
        )

        val ghost = ClientboundPlaceGhostRecipePacket(12, display)
        val projectedGhost = outbound.project(ghost, VIEWER_ID) as ClientboundPlaceGhostRecipePacket
        assertNotSame(ghost, projectedGhost)
        assertEquals(12, projectedGhost.containerId())
        assertProjected(
            ((projectedGhost.recipeDisplay() as StonecutterRecipeDisplay).result()
                as SlotDisplay.ItemStackSlotDisplay).stack().create(),
        )
        assertCanonical(slot.stack().create())
    }

    @Test
    fun `boss scoreboard objective team and score component surfaces preserve packet state`() {
        val outbound = outboundProjector()
        val boss = object : BossEvent(
            UUID.fromString("d4d5539c-96db-4f57-b957-ebcfc8391d21"),
            carrierComponent("boss"),
            BossEvent.BossBarColor.BLUE,
            BossEvent.BossBarOverlay.NOTCHED_10,
        ) {}
        boss.progress = 0.35F
        boss.setDarkenScreen(true)
        boss.setPlayBossMusic(true)
        val bossPacket = ClientboundBossEventPacket.createAddPacket(boss)
        val projectedBoss = outbound.project(bossPacket, VIEWER_ID) as ClientboundBossEventPacket
        var bossName: Component? = null
        var bossProgress = 0.0F
        projectedBoss.dispatch(object : ClientboundBossEventPacket.Handler {
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
                bossName = name
                bossProgress = progress
                assertEquals(BossEvent.BossBarColor.BLUE, color)
                assertEquals(BossEvent.BossBarOverlay.NOTCHED_10, overlay)
                assertTrue(darkenScreen)
                assertTrue(playMusic)
                assertFalse(createWorldFog)
            }
        })
        assertProjectedCarrier(requireNotNull(bossName))
        assertEquals(0.35F, bossProgress)

        val scoreboard = Scoreboard()
        val objective = Objective(
            scoreboard,
            "objective",
            ObjectiveCriteria.DUMMY,
            carrierComponent("objective"),
            ObjectiveCriteria.RenderType.HEARTS,
            false,
            FixedFormat(carrierComponent("format")),
        )
        val objectivePacket = ClientboundSetObjectivePacket(objective, ClientboundSetObjectivePacket.METHOD_ADD)
        val projectedObjective = outbound.project(objectivePacket, VIEWER_ID) as ClientboundSetObjectivePacket
        assertProjectedCarrier(projectedObjective.displayName)
        assertProjectedCarrier((projectedObjective.numberFormat.orElseThrow() as FixedFormat).value())
        assertEquals("objective", projectedObjective.objectiveName)
        assertEquals(ObjectiveCriteria.RenderType.HEARTS, projectedObjective.renderType)

        val team = PlayerTeam(scoreboard, "team").also { value ->
            value.setDisplayName(carrierComponent("team"))
            value.setPlayerPrefix(carrierComponent("prefix"))
            value.setPlayerSuffix(carrierComponent("suffix"))
            value.players += "member"
        }
        val teamPacket = ClientboundSetPlayerTeamPacket.createAddOrModifyPacket(team, true)
        val projectedTeam = outbound.project(teamPacket, VIEWER_ID) as ClientboundSetPlayerTeamPacket
        val parameters = projectedTeam.parameters.orElseThrow()
        assertProjectedCarrier(parameters.displayName)
        assertProjectedCarrier(parameters.playerPrefix)
        assertProjectedCarrier(parameters.playerSuffix)
        assertEquals(listOf("member"), projectedTeam.players.toList())
        assertEquals(ClientboundSetPlayerTeamPacket.Action.ADD, projectedTeam.teamAction)

        val scorePacket = ClientboundSetScorePacket(
            "owner",
            "objective",
            41,
            Optional.of(carrierComponent("score")),
            Optional.of(FixedFormat(carrierComponent("score format"))),
        )
        val projectedScore = outbound.project(scorePacket, VIEWER_ID) as ClientboundSetScorePacket
        assertProjectedCarrier(projectedScore.display().orElseThrow())
        assertProjectedCarrier((projectedScore.numberFormat().orElseThrow() as FixedFormat).value())
        assertEquals(41, projectedScore.score())
        assertCanonical(shownItem(boss.name))
    }

    @Test
    fun `every dialog form projects common bodies inputs buttons and nested show-dialog actions`() {
        val nested = NoticeDialog(simpleCommon("nested"), actionButton("nested action"))
        val nestedAction: Optional<Action> = Optional.of(
            StaticAction(ClickEvent.ShowDialog(Holder.direct<Dialog>(nested))),
        )
        val common = completeCommon()
        val action = ActionButton(
            CommonButtonData(carrierComponent("action"), Optional.of(carrierComponent("tooltip")), 137),
            nestedAction,
        )
        val exit = Optional.of(actionButton("exit"))
        val sources: List<Dialog> = listOf(
            ConfirmationDialog(common, action, actionButton("no")),
            NoticeDialog(common, action),
            MultiActionDialog(common, listOf(action), exit, 3),
            DialogListDialog(common, HolderSet.direct(Holder.direct<Dialog>(nested)), exit, 2, 181),
            ServerLinksDialog(common, exit, 4, 192),
        )
        val projector = structuredProjector()

        sources.forEach { source ->
            val projected = projector.projectDialog(Holder.direct(source), VIEWER_ID).value()
            assertNotSame(source, projected)
            assertProjectedCarrier(projected.common().title())
            assertProjectedCarrier(projected.common().externalTitle().orElseThrow())
        }

        val projected = projector.projectDialog(Holder.direct<Dialog>(sources[2]), VIEWER_ID).value() as MultiActionDialog
        val projectedCommon = projected.common()
        assertProjectedCarrier((projectedCommon.body()[0] as PlainMessage).contents())
        val itemBody = projectedCommon.body()[1] as ItemBody
        assertProjected(itemBody.item().create())
        assertProjectedCarrier(itemBody.description().orElseThrow().contents())

        val controls = projectedCommon.inputs().associate { it.key() to it.control() }
        assertProjectedCarrier((controls.getValue("boolean") as BooleanInput).label())
        assertProjectedCarrier((controls.getValue("number") as NumberRangeInput).label())
        val single = controls.getValue("single") as SingleOptionInput
        assertProjectedCarrier(single.label())
        assertProjectedCarrier(single.entries().single().display().orElseThrow())
        assertProjectedCarrier((controls.getValue("text") as TextInput).label())

        val projectedAction = projected.actions().single()
        assertProjectedCarrier(projectedAction.button().label())
        assertProjectedCarrier(projectedAction.button().tooltip().orElseThrow())
        val showDialog = (projectedAction.action().orElseThrow() as StaticAction).value() as ClickEvent.ShowDialog
        assertProjectedCarrier(showDialog.dialog().value().common().title())

        assertCanonical(itemBodySource(common).item().create())
        assertCanonical(shownItem(common.title()))
        assertCanonical(shownItem(nested.common().title()))
    }

    @Test
    fun `component show-dialog server links and direct show-dialog packets project atomically`() {
        val nested = NoticeDialog(simpleCommon("click nested"), actionButton("ok"))
        val clickComponent = Component.literal("open").withStyle { style ->
            style.withClickEvent(ClickEvent.ShowDialog(Holder.direct<Dialog>(nested)))
        }
        val serverLinks = ClientboundServerLinksPacket(
            listOf(
                ServerLinks.UntrustedEntry(Either.left(ServerLinks.KnownLinkType.WEBSITE), "https://example.test"),
                ServerLinks.UntrustedEntry(Either.right(carrierComponent("custom link")), "https://custom.test"),
            ),
        )
        val projector = outboundProjector()

        val projectedChat = projector.project(
            ClientboundSystemChatPacket(clickComponent, false),
            VIEWER_ID,
        ) as ClientboundSystemChatPacket
        val projectedClick = projectedChat.content().style.clickEvent as ClickEvent.ShowDialog
        assertProjectedCarrier(projectedClick.dialog().value().common().title())

        val projectedLinks = projector.project(serverLinks, VIEWER_ID) as ClientboundServerLinksPacket
        assertNotSame(serverLinks, projectedLinks)
        assertTrue(projectedLinks.links()[0].type().left().isPresent)
        assertProjectedCarrier(projectedLinks.links()[1].type().right().orElseThrow())
        assertCanonical(shownItem(serverLinks.links()[1].type().right().orElseThrow()))

        val dialogPacket = ClientboundShowDialogPacket(Holder.direct<Dialog>(nested))
        val projectedDialog = projector.project(dialogPacket, VIEWER_ID) as ClientboundShowDialogPacket
        assertNotSame(dialogPacket, projectedDialog)
        assertProjectedCarrier(projectedDialog.dialog().value().common().title())

        val directComponents = listOf(
            ClientboundDisconnectPacket(carrierComponent("disconnect")),
            ClientboundResourcePackPushPacket(
                UUID.fromString("2aef0336-11cf-4810-83ee-99ea1ec0a52c"),
                "https://example.test/pack.zip",
                "hash",
                true,
                Optional.of(carrierComponent("resource pack")),
            ),
            ClientboundPlayerCombatKillPacket(4, carrierComponent("combat")),
            ClientboundServerDataPacket(carrierComponent("motd"), Optional.empty()),
            ClientboundTestInstanceBlockStatus(carrierComponent("test status"), Optional.empty()),
        )
        directComponents.forEach { source ->
            val projected = projector.project(source, VIEWER_ID)
            val component = when (projected) {
                is ClientboundDisconnectPacket -> projected.reason()
                is ClientboundResourcePackPushPacket -> projected.prompt().orElseThrow()
                is ClientboundPlayerCombatKillPacket -> projected.message()
                is ClientboundServerDataPacket -> projected.motd()
                is ClientboundTestInstanceBlockStatus -> projected.status()
                else -> error("Unexpected packet type: ${projected.javaClass.name}")
            }
            assertNotSame(source, projected)
            assertProjectedCarrier(component)
        }
    }

    @Test
    fun `custom click payload uses an opaque connection capability and restores exact canonical nbt`() {
        val state = connectionState()
        val id = Identifier.fromNamespaceAndPath("itemerness", "custom-action")
        val canonicalPayload = CompoundTag().apply { put("item", encodedCanonicalStack()) }
        val component = Component.literal("custom").withStyle { style ->
            style.withClickEvent(ClickEvent.Custom(id, Optional.of(canonicalPayload)))
        }
        val projectedPacket = outboundProjector().project(
            ClientboundSystemChatPacket(component, false),
            VIEWER_ID,
            state,
        ) as ClientboundSystemChatPacket
        val projectedClick = projectedPacket.content().style.clickEvent as ClickEvent.Custom
        val wirePayload = projectedClick.payload().orElseThrow()

        assertTrue(wirePayload is CompoundTag)
        assertTrue((wirePayload as CompoundTag).contains(NmsCustomClickTokenCodec.ACTION_KEY))
        assertFalse(wirePayload.contains("item"))

        val inbound = NmsInboundPacketProjector(state, ProjectionResyncSink.REJECTING).project(
            ServerboundCustomClickActionPacket(id, Optional.of(wirePayload)),
            VIEWER_ID,
        ) as InboundPacketDecision.Forward
        val restored = inbound.packet as ServerboundCustomClickActionPacket
        assertEquals(canonicalPayload, restored.payload().orElseThrow())
        assertCanonical(decodeStack((restored.payload().orElseThrow() as CompoundTag).get("item") as CompoundTag))

        val tampered = (wirePayload as CompoundTag).copy().apply { putString("forged", "value") }
        val rejected = NmsInboundPacketProjector(state, ProjectionResyncSink.REJECTING).project(
            ServerboundCustomClickActionPacket(id, Optional.of(tampered)),
            VIEWER_ID,
        ) as InboundPacketDecision.RejectCustomClick
        assertEquals(CustomClickRejectReason.PAYLOAD_CHANGED, rejected.reason)

        val wrongAction = NmsInboundPacketProjector(state, ProjectionResyncSink.REJECTING).project(
            ServerboundCustomClickActionPacket(
                Identifier.fromNamespaceAndPath("itemerness", "wrong-action"),
                Optional.of(wirePayload),
            ),
            VIEWER_ID,
        ) as InboundPacketDecision.RejectCustomClick
        assertEquals(CustomClickRejectReason.ACTION_CHANGED, wrongAction.reason)
    }

    @Test
    fun `dialog static custom action receives a return capability and restores canonical nbt`() {
        val state = connectionState()
        val id = Identifier.fromNamespaceAndPath("itemerness", "dialog-static-custom")
        val canonicalPayload = CompoundTag().apply { put("item", encodedCanonicalStack()) }
        val action = ActionButton(
            CommonButtonData(Component.literal("submit"), Optional.empty(), 150),
            Optional.of(StaticAction(ClickEvent.Custom(id, Optional.of(canonicalPayload)))),
        )
        val source = ClientboundShowDialogPacket(
            Holder.direct<Dialog>(NoticeDialog(simpleCommon("static custom"), action)),
        )

        val projected = outboundProjector().project(source, VIEWER_ID, state) as ClientboundShowDialogPacket
        val staticAction = (projected.dialog().value() as NoticeDialog).action().action().orElseThrow() as StaticAction
        val projectedClick = staticAction.value() as ClickEvent.Custom
        val wirePayload = projectedClick.payload().orElseThrow()
        assertTrue((wirePayload as CompoundTag).contains(NmsCustomClickTokenCodec.ACTION_KEY))
        assertFalse(wirePayload.contains("item"))

        val inbound = NmsInboundPacketProjector(state, ProjectionResyncSink.REJECTING).project(
            ServerboundCustomClickActionPacket(id, Optional.of(wirePayload)),
            VIEWER_ID,
        ) as InboundPacketDecision.Forward
        val restored = (inbound.packet as ServerboundCustomClickActionPacket).payload().orElseThrow()
        assertEquals(canonicalPayload, restored)
    }

    @Test
    fun `custom-all additions restore protected canonical fields while preserving client inputs`() {
        val state = connectionState()
        val id = Identifier.fromNamespaceAndPath("itemerness", "custom-all")
        val canonicalAdditions = CompoundTag().apply { put("item", encodedCanonicalStack()) }
        val action = ActionButton(
            CommonButtonData(Component.literal("submit"), Optional.empty(), 150),
            Optional.of(CustomAll(id, Optional.of(canonicalAdditions))),
        )
        val source = ClientboundShowDialogPacket(
            Holder.direct<Dialog>(NoticeDialog(simpleCommon("custom all"), action)),
        )

        val projected = outboundProjector().project(source, VIEWER_ID, state) as ClientboundShowDialogPacket
        val projectedAction = (projected.dialog().value() as NoticeDialog).action().action().orElseThrow() as CustomAll
        val wireAdditions = projectedAction.additions().orElseThrow()
        assertTrue(wireAdditions.contains(NmsCustomClickTokenCodec.ACTION_KEY))
        assertProjected(decodeStack(wireAdditions.get("item") as CompoundTag))

        val returnedPayload = wireAdditions.copy().apply { putString("player_input", "accepted") }
        val inbound = NmsInboundPacketProjector(state, ProjectionResyncSink.REJECTING).project(
            ServerboundCustomClickActionPacket(id, Optional.of(returnedPayload)),
            VIEWER_ID,
        ) as InboundPacketDecision.Forward
        val restored = (inbound.packet as ServerboundCustomClickActionPacket).payload().orElseThrow() as CompoundTag
        assertEquals("accepted", restored.getString("player_input").orElseThrow())
        assertFalse(restored.contains(NmsCustomClickTokenCodec.ACTION_KEY))
        assertCanonical(decodeStack(restored.get("item") as CompoundTag))

        val tampered = wireAdditions.copy().apply {
            put("item", encodedCanonicalStack())
        }
        val rejected = NmsInboundPacketProjector(state, ProjectionResyncSink.REJECTING).project(
            ServerboundCustomClickActionPacket(id, Optional.of(tampered)),
            VIEWER_ID,
        ) as InboundPacketDecision.RejectCustomClick
        assertEquals(CustomClickRejectReason.PAYLOAD_CHANGED, rejected.reason)
    }

    @Test
    fun `protected custom action rejects a removed capability and forged canonical payload`() {
        val state = connectionState()
        val id = Identifier.fromNamespaceAndPath("itemerness", "protected-action")
        val canonical = CompoundTag().apply { put("item", encodedCanonicalStack()) }
        val projectedPacket = outboundProjector().project(
            ClientboundSystemChatPacket(
                Component.literal("protected").withStyle { style ->
                    style.withClickEvent(ClickEvent.Custom(id, Optional.of(canonical)))
                },
                false,
            ),
            VIEWER_ID,
            state,
        ) as ClientboundSystemChatPacket
        val wire = (projectedPacket.content().style.clickEvent as ClickEvent.Custom)
            .payload()
            .orElseThrow() as CompoundTag

        val stripped = wire.copy().apply {
            remove(NmsCustomClickTokenCodec.ACTION_KEY)
            put("item", encodedCanonicalStack())
        }
        val forged = NmsInboundPacketProjector(state, ProjectionResyncSink.REJECTING).project(
            ServerboundCustomClickActionPacket(id, Optional.of(stripped)),
            VIEWER_ID,
        ) as InboundPacketDecision.RejectCustomClick
        assertEquals(CustomClickRejectReason.MISSING_TOKEN, forged.reason)

        val empty = NmsInboundPacketProjector(state, ProjectionResyncSink.REJECTING).project(
            ServerboundCustomClickActionPacket(id, Optional.empty()),
            VIEWER_ID,
        ) as InboundPacketDecision.RejectCustomClick
        assertEquals(CustomClickRejectReason.MISSING_TOKEN, empty.reason)

        val unmanaged = ServerboundCustomClickActionPacket(
            Identifier.fromNamespaceAndPath("example", "unmanaged"),
            Optional.of(CompoundTag().apply { putString("input", "kept") }),
        )
        val decision = NmsInboundPacketProjector(state, ProjectionResyncSink.REJECTING)
            .project(unmanaged, VIEWER_ID) as InboundPacketDecision.Forward
        assertSame(unmanaged, decision.packet)
    }

    @Test
    fun `cyclic dialog graph fails the whole outbound packet and refresh capability is advertised`() {
        val title = Component.literal("cycle")
        val dialog = NoticeDialog(
            CommonDialogData(
                title,
                Optional.empty(),
                true,
                false,
                DialogAction.CLOSE,
                emptyList(),
                emptyList(),
            ),
            actionButton("close"),
        )
        title.setStyle(Style.EMPTY.withClickEvent(ClickEvent.ShowDialog(Holder.direct<Dialog>(dialog))))
        val packet = ClientboundShowDialogPacket(Holder.direct<Dialog>(dialog))

        assertThrows(IllegalStateException::class.java) {
            structuredProjector().projectDialog(packet.dialog(), VIEWER_ID)
        }
        assertThrows(IllegalStateException::class.java) {
            outboundProjector().project(packet, VIEWER_ID)
        }
        assertTrue(ProjectionRefreshAdapter::class.java.isAssignableFrom(NmsProjectionAdapter::class.java))

        val twoNodeLabel = Component.empty().append(carrierComponent("bounded"))
        val oversizedGraph = ClientboundServerLinksPacket(
            List(2_049) { index ->
                ServerLinks.UntrustedEntry(Either.right(twoNodeLabel), "https://example.test/$index")
            },
        )
        assertThrows(IllegalStateException::class.java) {
            outboundProjector().project(oversizedGraph, VIEWER_ID)
        }
    }

    @Test
    fun `bundle shares one component node budget across every nested packet`() {
        fun links(suffix: String) = ClientboundServerLinksPacket(
            List(2_100) { index ->
                ServerLinks.UntrustedEntry(
                    Either.right(Component.literal("label-$index")),
                    "https://example.test/$suffix/$index",
                )
            },
        )
        val first = links("first")
        val second = links("second")

        assertSame(first, outboundProjector().project(first, VIEWER_ID))
        assertSame(second, outboundProjector().project(second, VIEWER_ID))
        assertThrows(IllegalStateException::class.java) {
            outboundProjector().project(ClientboundBundlePacket(listOf(first, second)), VIEWER_ID)
        }
    }

    private fun completeCommon(): CommonDialogData = CommonDialogData(
        carrierComponent("title"),
        Optional.of(carrierComponent("external")),
        false,
        false,
        DialogAction.CLOSE,
        listOf(
            PlainMessage(carrierComponent("plain"), 205),
            ItemBody(
                template(canonicalStack()),
                Optional.of(PlainMessage(carrierComponent("item description"), 177)),
                false,
                true,
                31,
                29,
            ),
        ),
        listOf(
            Input("boolean", BooleanInput(carrierComponent("boolean"), true, "yes", "no")),
            Input(
                "number",
                NumberRangeInput(
                    211,
                    carrierComponent("number"),
                    "itemerness.number",
                    NumberRangeInput.RangeInfo(1.0F, 9.0F, Optional.of(3.0F), Optional.of(2.0F)),
                ),
            ),
            Input(
                "single",
                SingleOptionInput(
                    222,
                    listOf(SingleOptionInput.Entry("one", Optional.of(carrierComponent("option")), true)),
                    carrierComponent("single"),
                    false,
                ),
            ),
            Input("text", TextInput(233, carrierComponent("text"), false, "initial", 64, Optional.empty())),
        ),
    )

    private fun simpleCommon(label: String): CommonDialogData = CommonDialogData(
        carrierComponent(label),
        Optional.empty(),
        true,
        false,
        DialogAction.CLOSE,
        emptyList(),
        emptyList(),
    )

    private fun actionButton(label: String): ActionButton = ActionButton(
        CommonButtonData(carrierComponent(label), Optional.empty(), 150),
        Optional.empty(),
    )

    private fun itemBodySource(common: CommonDialogData): ItemBody = common.body()[1] as ItemBody

    private fun structuredProjector(): NmsStructuredPayloadProjector {
        val recursive = NmsRecursiveItemProjector(NmsItemStackProjector(runtime()))
        return NmsStructuredPayloadProjector(recursive, recursive.componentProjector())
    }

    private fun outboundProjector(): NmsOutboundPacketProjector =
        NmsOutboundPacketProjector(NmsItemStackProjector(runtime()))

    private fun connectionState(): NmsConnectionProjectionState = NmsConnectionProjectionState(
        connectionGeneration = 13,
        hasher = { component -> component.value().hashCode() },
        registryAccess = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY),
    )

    private fun encodedCanonicalStack(): CompoundTag {
        val ops = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)
            .createSerializationContext(NbtOps.INSTANCE)
        return ItemStack.CODEC.encodeStart(ops, canonicalStack()).result().orElseThrow() as CompoundTag
    }

    private fun decodeStack(source: CompoundTag): ItemStack {
        val ops = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)
            .createSerializationContext(NbtOps.INSTANCE)
        return ItemStack.CODEC.parse(ops, source).result().orElseThrow()
    }

    private fun managedSlot(): SlotDisplay.ItemStackSlotDisplay =
        SlotDisplay.ItemStackSlotDisplay(template(canonicalStack()))

    private fun recipeSlots(source: RecipeDisplay): List<SlotDisplay> = when (source) {
        is ShapedCraftingRecipeDisplay -> source.ingredients() + source.result() + source.craftingStation()
        is ShapelessCraftingRecipeDisplay -> source.ingredients() + source.result() + source.craftingStation()
        is FurnaceRecipeDisplay -> listOf(source.ingredient(), source.fuel(), source.result(), source.craftingStation())
        is SmithingRecipeDisplay -> listOf(
            source.template(), source.base(), source.addition(), source.result(), source.craftingStation(),
        )
        is StonecutterRecipeDisplay -> listOf(source.input(), source.result(), source.craftingStation())
        else -> emptyList()
    }

    private fun slotStacks(source: SlotDisplay): List<ItemStack> = when (source) {
        is SlotDisplay.ItemStackSlotDisplay -> listOf(source.stack().create())
        is SlotDisplay.Composite -> source.contents().flatMap(::slotStacks)
        is SlotDisplay.DyedSlotDemo -> slotStacks(source.dye()) + slotStacks(source.target())
        is SlotDisplay.OnlyWithComponent -> slotStacks(source.source())
        is SlotDisplay.SmithingTrimDemoSlotDisplay -> slotStacks(source.base()) + slotStacks(source.material())
        is SlotDisplay.WithAnyPotion -> slotStacks(source.display())
        is SlotDisplay.WithRemainder -> slotStacks(source.input()) + slotStacks(source.remainder())
        else -> emptyList()
    }

    private fun trimPatterns(source: SlotDisplay): List<Holder<TrimPattern>> = when (source) {
        is SlotDisplay.Composite -> source.contents().flatMap(::trimPatterns)
        is SlotDisplay.DyedSlotDemo -> trimPatterns(source.dye()) + trimPatterns(source.target())
        is SlotDisplay.OnlyWithComponent -> trimPatterns(source.source())
        is SlotDisplay.SmithingTrimDemoSlotDisplay ->
            listOf(source.pattern()) + trimPatterns(source.base()) + trimPatterns(source.material())
        is SlotDisplay.WithAnyPotion -> trimPatterns(source.display())
        is SlotDisplay.WithRemainder -> trimPatterns(source.input()) + trimPatterns(source.remainder())
        else -> emptyList()
    }

    private fun carrierComponent(text: String): Component = Component.literal(text).withStyle { style ->
        style.withHoverEvent(HoverEvent.ShowItem(template(canonicalStack())))
    }

    private fun shownItem(component: Component): ItemStack =
        (component.style.hoverEvent as HoverEvent.ShowItem).item().create()

    private fun assertProjectedCarrier(component: Component) {
        assertProjected(shownItem(component))
    }

    private fun assertCanonical(stack: ItemStack) {
        assertTrue(stack.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
    }

    private fun assertProjected(stack: ItemStack) {
        assertFalse(stack.get(DataComponents.CUSTOM_DATA)?.contains(NmsCanonicalItemCodec.ROOT_KEY) == true)
        assertEquals("Projected item", stack.get(DataComponents.ITEM_NAME)?.string)
    }

    private fun template(stack: ItemStack): ItemStackTemplate = ItemStackTemplate.fromNonEmptyStack(stack)

    private fun canonicalStack(): ItemStack {
        val root = CompoundTag().apply {
            putInt("format", 1)
            putString("id", "itemerness:travel-token")
            putLong("created_against_revision", 1)
            putLong("instance_revision", 0)
            put("data_schemas", CompoundTag().apply { putInt("itemerness:common", 1) })
            put("data", CompoundTag().apply { putInt("example:charges", 3) })
        }
        return ItemStack(Items.PAPER).also { stack ->
            CustomData.set(
                DataComponents.CUSTOM_DATA,
                stack,
                CompoundTag().apply { put(NmsCanonicalItemCodec.ROOT_KEY, root) },
            )
            stack.set(DataComponents.ITEM_NAME, Component.literal("[itemerness:travel-token]"))
        }
    }

    private fun runtime(): ProjectionRuntime = ProjectionRuntime(
        projector = ItemProjector {
            ProjectionResult.Rendered(
                RenderedDisplay(
                    displayName = RenderedText.plain("Projected item"),
                    lore = listOf(RenderedText.plain("Projected lore")),
                ),
            )
        },
        contexts = ProjectionContextSource { viewerId ->
            if (viewerId != VIEWER_ID) {
                null
            } else {
                ProjectionContext(
                    viewer = ViewerProjectionSnapshot(
                        viewerId = VIEWER_ID,
                        revision = 1,
                        locale = LocaleId("en_us"),
                        theme = ItemKey.parse("itemerness:default"),
                        assetProfile = null,
                    ),
                    generation = ProjectionGeneration(catalogRevision = 1, epoch = 1),
                )
            }
        },
    )

    private companion object {
        val VIEWER_ID: UUID = UUID.fromString("bcd3dd37-9a36-4766-a2a1-146c80d10b5d")

        @JvmStatic
        @BeforeAll
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
            val global = GlobalConfiguration().also { configuration ->
                configuration.collisions = configuration.Collisions().also { collisions ->
                    collisions.enablePlayerCollisions = true
                }
            }
            GlobalConfiguration::class.java.getDeclaredField("instance").also { field ->
                check(field.trySetAccessible()) { "Cannot initialize Paper global configuration" }
                field.set(null, global)
            }
            Items.PAPER.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
            Items.STONE.builtInRegistryHolder().bindComponents(DataComponentMap.EMPTY)
        }
    }
}

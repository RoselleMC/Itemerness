package com.iroselle.itemerness.nms.v1_21_11

import com.google.gson.JsonParser
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.projection.TooltipLineEvidence
import com.mojang.serialization.JsonOps
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import net.minecraft.SharedConstants
import net.minecraft.core.component.DataComponentType
import net.minecraft.core.component.DataComponents
import net.minecraft.core.registries.BuiltInRegistries
import net.minecraft.network.chat.Component
import net.minecraft.server.Bootstrap
import net.minecraft.world.item.Item
import net.minecraft.world.item.ItemStack
import net.minecraft.world.item.Items
import net.minecraft.world.item.TooltipFlag
import net.minecraft.world.item.component.ItemAttributeModifiers
import net.minecraft.world.item.component.TooltipDisplay
import net.minecraft.world.item.enchantment.ItemEnchantments
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.MethodVisitor
import org.objectweb.asm.Opcodes

class NmsTooltipLineProbeTest {
    private val probe = NmsTestRegistries.probe

    @Test
    fun `every component read by the exact tooltip builder has an asserted probe sample`() {
        val read = dataComponentFieldsRead(ItemStack::class.java, setOf("addDetailsToTooltip", "addAttributeTooltips"))
            .mapTo(HashSet()) { name -> DataComponents::class.java.getField(name).get(null) as DataComponentType<*> }
        // LORE is replaced atomically by projection and CUSTOM_NAME blocks ownership outright.
        val unsampled = read - SAMPLES.keys - setOf(DataComponents.LORE)
        assertTrue(unsampled.isEmpty(), "Add a probe sample for ${unsampled.map(::id).sorted()}")

        val mismatches = SAMPLES.mapNotNull { (type, sample) ->
            val stack = sample.stack(type)
            val actual = outcome(probe.evidence(stack), type)
            if (actual == sample.expected) null else "${id(type)} expected ${sample.expected} but was $actual"
        }
        assertEquals(emptyList<String>(), mismatches)
    }

    @Test
    fun `attribution is complete and probing never mutates the stack`() {
        allSamples().forEach { (name, stack) ->
            val before = stack.copy()
            val measurement = probe.measure(stack)
            assertTrue(ItemStack.matches(before, stack), "probe mutated $name")
            if (measurement == null) return@forEach
            measurement.flags.forEachIndexed { index, flag ->
                assertEquals(0, flag.baseline, "baseline for $name")
                val full = countLines(stack, TooltipDisplay.DEFAULT.withHidden(DataComponents.LORE, true), FLAGS[index])
                assertEquals(full, flag.full, "full count for $name")
                if (flag.perComponent.isNotEmpty()) {
                    assertEquals(full, flag.baseline + flag.perComponent.values.sum(), "attribution for $name")
                }
            }
        }
    }

    @Test
    fun `clean stacks are silent and prototype defaults are probed`() {
        assertEquals(TooltipLineEvidence.SILENT, probe.evidence(ItemStack(Items.ECHO_SHARD)))
        assertEquals(TooltipLineEvidence.SILENT, probe.evidence(ItemStack(Items.BOOK)))
        // Default tool attribute lines come from the item prototype, not the stack patch; the old
        // hand list ignored them through hasNonDefault and let fixed-geometry themes hide them.
        val sword = probe.evidence(ItemStack(Items.DIAMOND_SWORD))
        assertFalse(sword.blocked)
        assertTrue(ItemKey.parse("minecraft:attribute_modifiers") in sword.emittingComponents, "$sword")
    }

    @Test
    fun `empty component values are silent`() {
        val stacks = listOf(
            ItemStack(Items.DIAMOND_SWORD).also { it.set(DataComponents.ATTRIBUTE_MODIFIERS, ItemAttributeModifiers.EMPTY) },
            ItemStack(Items.ECHO_SHARD).also { it.set(DataComponents.ENCHANTMENTS, ItemEnchantments.EMPTY) },
            ItemStack(Items.ECHO_SHARD).also { it.set(DataComponents.ATTRIBUTE_MODIFIERS, ItemAttributeModifiers.EMPTY) },
        )
        stacks.forEach { stack -> assertEquals(TooltipLineEvidence.SILENT, probe.evidence(stack), "$stack") }
    }

    @Test
    fun `hover text overrides forged names and missing registries block ownership`() {
        val template = Items.NETHERITE_UPGRADE_SMITHING_TEMPLATE
        assertTrue(NmsTooltipLineProbe.appendsHoverText(template.javaClass))
        assertEquals(TooltipLineEvidence.BLOCKED, probe.evidence(ItemStack(template)))
        assertEquals(
            TooltipLineEvidence.BLOCKED,
            probe.evidence(ItemStack(Items.ECHO_SHARD).also { it.set(DataComponents.CUSTOM_NAME, Component.literal("forged")) }),
        )
        val withoutRegistries = NmsTooltipLineProbe { null }
        assertEquals(TooltipLineEvidence.BLOCKED, withoutRegistries.evidence(ItemStack(Items.ECHO_SHARD)))
        val failingRegistries = NmsTooltipLineProbe { error("server unavailable") }
        assertEquals(TooltipLineEvidence.BLOCKED, failingRegistries.evidence(ItemStack(Items.ECHO_SHARD)))
        assertNull(NmsTooltipLineProbe.SERVER.measure(ItemStack(Items.ECHO_SHARD)))
    }

    @Test
    fun `subclasses that keep vanilla hover text are probed like plain items`() {
        // Server forks replace vanilla item classes, such as Canvas swords, without adding hover text.
        val bow = Items.BOW
        assertTrue(bow.javaClass != Item::class.java)
        assertFalse(NmsTooltipLineProbe.appendsHoverText(bow.javaClass))
        assertFalse(NmsTooltipLineProbe.appendsHoverText(Item::class.java))
        assertFalse(probe.evidence(ItemStack(bow)).blocked)
    }

    @Test
    fun `probe is deterministic across concurrent threads`() {
        val stacks = allSamples().values.toList()
        val expected = stacks.map(probe::evidence)
        val pool = Executors.newFixedThreadPool(8)
        try {
            val tasks = (0 until 8).map {
                Callable { (0 until 10).all { stacks.map(probe::evidence) == expected } }
            }
            assertTrue(pool.invokeAll(tasks).all { it.get() })
        } finally {
            pool.shutdown()
            pool.awaitTermination(10, TimeUnit.SECONDS)
        }
    }

    @Test
    fun `probe cost stays within the packet budget`() {
        val stack = ItemStack(Items.DIAMOND_SWORD).also { it.set(DataComponents.UNBREAKABLE, net.minecraft.util.Unit.INSTANCE) }
        val uncached = averageMicros { probe.measure(stack) }
        val cached = averageMicros { probe.evidence(stack) }
        println(
            "tooltip line probe: ${stack.components.size()} components, " +
                "%.2f us uncached, %.2f us cached per stack".format(uncached, cached),
        )
        // Generous bounds for slow CI; an uncached probe of a full sword measures in tens of microseconds.
        assertTrue(uncached < 1_000.0, "uncached probe took $uncached us")
        assertTrue(cached < uncached, "cached probe took $cached us, uncached $uncached us")
    }

    @Test
    fun `cached evidence ignores canonical custom data but follows other components`() {
        val first = ItemStack(Items.ECHO_SHARD).also {
            net.minecraft.world.item.component.CustomData.set(
                DataComponents.CUSTOM_DATA,
                it,
                net.minecraft.nbt.CompoundTag().apply { putString("example:instance", "first") },
            )
        }
        val second = first.copy().also {
            net.minecraft.world.item.component.CustomData.set(
                DataComponents.CUSTOM_DATA,
                it,
                net.minecraft.nbt.CompoundTag().apply { putString("example:instance", "second") },
            )
        }
        val unbreakable = second.copy().also { it.set(DataComponents.UNBREAKABLE, net.minecraft.util.Unit.INSTANCE) }

        assertEquals(TooltipLineEvidence.SILENT, probe.evidence(first))
        assertEquals(TooltipLineEvidence.SILENT, probe.evidence(second))
        assertEquals(setOf(ItemKey.parse("minecraft:unbreakable")), probe.evidence(unbreakable).emittingComponents)
    }

    private fun averageMicros(action: () -> Unit): Double {
        repeat(5_000) { action() }
        val rounds = 20_000
        val start = System.nanoTime()
        repeat(rounds) { action() }
        return (System.nanoTime() - start) / 1000.0 / rounds
    }

    private fun outcome(evidence: TooltipLineEvidence, type: DataComponentType<*>): Outcome = when {
        evidence.blocked -> Outcome.BLOCKED
        id(type) in evidence.emittingComponents.map(ItemKey::toString) -> Outcome.EMITS
        else -> Outcome.SILENT
    }

    private fun countLines(stack: ItemStack, display: TooltipDisplay, flag: TooltipFlag): Int {
        var count = 0
        stack.addDetailsToTooltip(Context, display, null, flag) { _: Component -> count++ }
        return count
    }

    private object Context : Item.TooltipContext {
        override fun registries() = NmsTestRegistries.lookup
        override fun tickRate(): Float = 20.0f
        override fun mapData(id: net.minecraft.world.level.saveddata.maps.MapId) = null
        override fun isPeaceful(): Boolean = false
    }

    private fun allSamples(): Map<String, ItemStack> {
        val result = LinkedHashMap<String, ItemStack>()
        BuiltInRegistries.ITEM.forEach { item -> result["default ${BuiltInRegistries.ITEM.getKey(item)}"] = ItemStack(item) }
        SAMPLES.forEach { (type, sample) -> result["sample ${id(type)}"] = sample.stack(type) }
        return result
    }

    private enum class Outcome { EMITS, SILENT, BLOCKED }

    private class Sample(
        val json: String,
        val expected: Outcome,
        val item: Item = Items.ECHO_SHARD,
    ) {
        fun stack(type: DataComponentType<*>): ItemStack = ItemStack(item).also { stack -> set(stack, type, json) }

        private fun <T : Any> set(stack: ItemStack, type: DataComponentType<T>, json: String) {
            val ops = NmsTestRegistries.lookup.createSerializationContext(JsonOps.INSTANCE)
            stack.set(type, type.codecOrThrow().parse(ops, JsonParser.parseString(json)).getOrThrow())
        }
    }

    private fun dataComponentFieldsRead(type: Class<*>, methods: Set<String>): Set<String> {
        val resource = "/${type.name.replace('.', '/')}.class"
        val bytes = requireNotNull(type.getResourceAsStream(resource)) { "Missing class bytes: $resource" }
            .use { stream -> stream.readAllBytes() }
        val fields = LinkedHashSet<String>()
        ClassReader(bytes).accept(object : ClassVisitor(Opcodes.ASM9) {
            override fun visitMethod(
                access: Int,
                name: String,
                descriptor: String,
                signature: String?,
                exceptions: Array<out String>?,
            ): MethodVisitor? {
                if (name !in methods) return null
                return object : MethodVisitor(Opcodes.ASM9) {
                    override fun visitFieldInsn(opcode: Int, owner: String, name: String, descriptor: String) {
                        if (opcode == Opcodes.GETSTATIC && owner == "net/minecraft/core/component/DataComponents") {
                            fields += name
                        }
                    }
                }
            }
        }, ClassReader.SKIP_DEBUG or ClassReader.SKIP_FRAMES)
        return fields
    }

    private companion object {
        val FLAGS by lazy { listOf(TooltipFlag.NORMAL, TooltipFlag.NORMAL.asCreative()) }

        fun id(type: DataComponentType<*>): String = BuiltInRegistries.DATA_COMPONENT_TYPE.getKey(type).toString()

        /**
         * One hand-written sample per component read by the exact tooltip builder. A new version
         * that reads a new component fails the coverage test until a sample is added here.
         */
        val SAMPLES: Map<DataComponentType<*>, Sample> by lazy {
            mapOf(
                DataComponents.CUSTOM_NAME to Sample("\"forged\"", Outcome.BLOCKED),
                DataComponents.TROPICAL_FISH_PATTERN to Sample("\"kob\"", Outcome.EMITS),
                DataComponents.INSTRUMENT to Sample("\"minecraft:ponder_goat_horn\"", Outcome.EMITS),
                DataComponents.MAP_ID to Sample("1", Outcome.EMITS),
                DataComponents.BEES to Sample(
                    """[{"entity_data":{"id":"minecraft:bee"},"ticks_in_hive":0,"min_ticks_in_hive":0}]""",
                    Outcome.EMITS,
                ),
                DataComponents.CONTAINER_LOOT to Sample("""{"loot_table":"minecraft:chests/simple_dungeon"}""", Outcome.EMITS),
                DataComponents.CONTAINER to Sample("""[{"slot":0,"item":{"id":"minecraft:stone","count":1}}]""", Outcome.EMITS),
                DataComponents.BANNER_PATTERNS to Sample("""[{"pattern":"minecraft:stripe_bottom","color":"red"}]""", Outcome.EMITS),
                DataComponents.POT_DECORATIONS to Sample(
                    """["minecraft:brick","minecraft:angler_pottery_sherd","minecraft:brick","minecraft:brick"]""",
                    Outcome.EMITS,
                ),
                DataComponents.WRITTEN_BOOK_CONTENT to Sample("""{"title":"Title","author":"Author"}""", Outcome.EMITS),
                DataComponents.CHARGED_PROJECTILES to Sample("""[{"id":"minecraft:arrow","count":1}]""", Outcome.EMITS),
                DataComponents.FIREWORKS to Sample("""{"flight_duration":1,"explosions":[]}""", Outcome.EMITS),
                DataComponents.FIREWORK_EXPLOSION to Sample("""{"shape":"star","colors":[16711680]}""", Outcome.EMITS),
                DataComponents.POTION_CONTENTS to Sample("""{"potion":"minecraft:swiftness"}""", Outcome.EMITS),
                DataComponents.JUKEBOX_PLAYABLE to Sample("\"minecraft:13\"", Outcome.EMITS),
                DataComponents.TRIM to Sample("""{"material":"minecraft:gold","pattern":"minecraft:coast"}""", Outcome.EMITS),
                DataComponents.STORED_ENCHANTMENTS to Sample("""{"minecraft:sharpness":1}""", Outcome.EMITS),
                DataComponents.ENCHANTMENTS to Sample("""{"minecraft:sharpness":1}""", Outcome.EMITS),
                DataComponents.DYED_COLOR to Sample("16711680", Outcome.EMITS),
                DataComponents.PROFILE to Sample("""{"name":"Steve"}""", Outcome.EMITS),
                DataComponents.ATTRIBUTE_MODIFIERS to Sample(
                    """[{"type":"minecraft:attack_damage","amount":3.0,"id":"example:damage","operation":"add_value","slot":"mainhand"}]""",
                    Outcome.EMITS,
                ),
                DataComponents.INTANGIBLE_PROJECTILE to Sample("{}", Outcome.EMITS),
                DataComponents.UNBREAKABLE to Sample("{}", Outcome.EMITS),
                DataComponents.OMINOUS_BOTTLE_AMPLIFIER to Sample("1", Outcome.EMITS),
                DataComponents.SUSPICIOUS_STEW_EFFECTS to Sample("""[{"id":"minecraft:speed","duration":160}]""", Outcome.EMITS),
                DataComponents.BLOCK_STATE to Sample("""{"honey_level":"3"}""", Outcome.EMITS),
                DataComponents.ENTITY_DATA to Sample("""{"id":"minecraft:pig"}""", Outcome.EMITS),
                // Only spawner block items print block entity data, and those are Item subclasses.
                DataComponents.BLOCK_ENTITY_DATA to Sample("""{"id":"minecraft:chest"}""", Outcome.SILENT),
                DataComponents.CAN_BREAK to Sample("""{"blocks":"minecraft:stone"}""", Outcome.EMITS),
                DataComponents.CAN_PLACE_ON to Sample("""{"blocks":"minecraft:stone"}""", Outcome.EMITS),
                // Durability is an advanced (F3+H) line, which is out of scope for ownership.
                DataComponents.DAMAGE to Sample("1", Outcome.SILENT, Items.DIAMOND_SWORD),
            )
        }

        @JvmStatic
        @BeforeAll
        @Suppress("DEPRECATION")
        fun bootstrapMinecraft() {
            SharedConstants.tryDetectVersion()
            Bootstrap.bootStrap()
        }
    }
}

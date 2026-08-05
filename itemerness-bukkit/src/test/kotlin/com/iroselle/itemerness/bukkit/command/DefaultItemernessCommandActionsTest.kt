package com.iroselle.itemerness.bukkit.command

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.FoliaScheduler
import com.iroselle.itemerness.bukkit.api.EffectiveItemDataResolver
import com.iroselle.itemerness.bukkit.api.PdcFallbackRead
import com.iroselle.itemerness.bukkit.api.PdcFallbackReader
import com.iroselle.itemerness.bukkit.catalog.CanonicalDomainResult
import com.iroselle.itemerness.bukkit.catalog.PreparedRuntimeCatalogPublication
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogManager
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogPublication
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogUpdate
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridge
import com.iroselle.itemerness.bukkit.spi.BukkitCanonicalBridgeDescriptor
import com.iroselle.itemerness.bukkit.spi.CanonicalItemInspection
import com.iroselle.itemerness.bukkit.spi.PendingItemName
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.core.catalog.InstanceDataMutation
import com.iroselle.itemerness.projection.BooleanProjectionValue
import com.iroselle.itemerness.projection.CanonicalDataSchemaVersion
import com.iroselle.itemerness.projection.CanonicalDataSchemas
import com.iroselle.itemerness.projection.CanonicalItemFingerprint
import com.iroselle.itemerness.projection.CanonicalItemSnapshot
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.KeyProjectionValue
import com.iroselle.itemerness.projection.ListProjectionValue
import com.iroselle.itemerness.projection.LongProjectionValue
import com.iroselle.itemerness.projection.MinecraftVersion
import com.iroselle.itemerness.projection.ProjectionCompound
import com.iroselle.itemerness.projection.ProjectionValue
import com.iroselle.itemerness.projection.StringProjectionValue
import com.iroselle.itemerness.projection.UuidProjectionValue
import io.papermc.paper.threadedregions.scheduler.AsyncScheduler
import io.papermc.paper.threadedregions.scheduler.EntityScheduler
import io.papermc.paper.threadedregions.scheduler.GlobalRegionScheduler
import io.papermc.paper.threadedregions.scheduler.ScheduledTask
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.function.Consumer
import net.kyori.adventure.text.Component
import net.kyori.adventure.text.format.NamedTextColor
import org.bukkit.Material
import org.bukkit.Server
import org.bukkit.command.ConsoleCommandSender
import org.bukkit.entity.Player
import org.bukkit.inventory.ItemStack
import org.bukkit.inventory.PlayerInventory
import org.bukkit.plugin.Plugin
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class DefaultItemernessCommandActionsTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `refresh command reports a rejected coordinator request as failure`() {
        val platform = Platform()
        val refreshes = AtomicInteger()
        val actions = actions(
            platform,
            playerRefreshed = {
                refreshes.incrementAndGet()
                false
            },
        )

        actions.refreshPlayer(platform.console, platform.player)

        assertEquals(1, refreshes.get())
        assertEquals(
            listOf(Component.text("Visible item surface refresh is unavailable for Target", NamedTextColor.RED)),
            platform.messages,
        )
    }

    @Test
    fun `inactive runtime rejects reload before reply or async submission`() {
        val platform = Platform()
        val actions = actions(platform, runtimeActive = { false })

        actions.reload(platform.console, checkOnly = false)

        assertEquals(0, platform.globalSubmissions.get())
        assertEquals(0, platform.asyncSubmissions.get())
        assertEquals(emptyList<Component>(), platform.messages)
    }

    @Test
    fun `runtime retirement suppresses queued reload work and completion replies`() {
        val active = AtomicBoolean(true)
        val platform = Platform(runAsyncImmediately = false)
        val actions = actions(platform, runtimeActive = active::get)

        actions.reload(platform.console, checkOnly = false)
        assertEquals(1, platform.asyncSubmissions.get())
        assertEquals(1, platform.messages.size, "The initial progress reply should be delivered while active")

        active.set(false)
        platform.runQueuedAsync()

        assertEquals(1, platform.messages.size)
        assertEquals(1, platform.globalSubmissions.get())
    }

    @Test
    fun `runtime retirement suppresses an already queued entity action`() {
        val active = AtomicBoolean(true)
        val platform = Platform(runEntityImmediately = false)
        val actions = actions(platform, runtimeActive = active::get)

        actions.inspectSlot(
            platform.console,
            platform.player,
            InventorySlot.MAIN_HAND,
            locale = null,
            raw = false,
        )

        active.set(false)
        assertDoesNotThrow { platform.runQueuedEntity() }

        assertEquals(emptyList<Component>(), platform.messages)
    }

    @Test
    fun `scheduler rejection does not escape command actions`() {
        val platform = Platform(rejectGlobal = true)
        val actions = actions(platform)

        assertDoesNotThrow { actions.refreshAll(platform.console) }
        assertEquals(emptyList<Component>(), platform.messages)
    }

    @Test
    fun `reload keeps the active revision when downstream publication fails`() {
        installBundledDomain()
        val platform = Platform()
        val catalog = RuntimeCatalogManager(directory)
        assertEquals(1, (catalog.reload() as RuntimeCatalogUpdate.Published).active.domain.revision)
        var projectedRevision = 1L
        val actions = actions(
            platform,
            catalog = catalog,
            catalogPublication = RuntimeCatalogPublication { candidate ->
                object : PreparedRuntimeCatalogPublication {
                    override fun commit() {
                        projectedRevision = candidate.domain.revision
                        error("projection rejected candidate")
                    }

                    override fun rollback() {
                        projectedRevision = 1
                    }
                }
            },
        )

        actions.reload(platform.console, checkOnly = false)

        assertEquals(1, catalog.catalogRevision)
        assertEquals(1, projectedRevision)
        assertEquals(
            Component.text(
                "Catalog publication failed; revision 1 remains active: projection rejected candidate",
                NamedTextColor.RED,
            ),
            platform.messages.last(),
        )
    }

    @Test
    fun `give cannot commit stacks created against a catalog retired concurrently`() {
        installBundledDomain()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(
            itemFile,
            Files.readString(itemFile).replaceFirst(
                "  framed-relic:\n    enabled: false",
                "  framed-relic:\n    enabled: true",
            ),
        )
        val catalog = RuntimeCatalogManager(directory)
        assertEquals(1, (catalog.reload() as RuntimeCatalogUpdate.Published).active.domain.revision)
        val createEntered = CountDownLatch(1)
        val releaseCreate = CountDownLatch(1)
        val bridge = proxy(BukkitCanonicalItemBridge::class.java) { method, _ ->
            when (method.name) {
                "create" -> {
                    createEntered.countDown()
                    assertTrue(releaseCreate.await(5, TimeUnit.SECONDS))
                    TestItemStack()
                }
                else -> defaultValue(method)
            }
        }
        val platform = Platform()
        val actions = actions(platform, catalog = catalog, bridge = bridge)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val give = executor.submit {
                actions.give(
                    platform.console,
                    platform.player,
                    com.iroselle.itemerness.api.ItemKey.parse("itemerness:framed-relic"),
                    1,
                )
            }
            assertTrue(createEntered.await(5, TimeUnit.SECONDS))
            Files.writeString(itemFile, Files.readString(itemFile).replaceFirst("enabled: true", "enabled: false"))
            assertEquals(2, (catalog.reload() as RuntimeCatalogUpdate.Published).active.domain.revision)
            releaseCreate.countDown()
            give.get(5, TimeUnit.SECONDS)

            assertEquals(
                Component.text(
                    "Catalog changed before the give operation could commit; retry the command",
                    NamedTextColor.RED,
                ),
                platform.messages.last(),
            )
        } finally {
            releaseCreate.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun `data mutation preserves a concurrent noncanonical component replacement`() {
        installBundledDomain()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(itemFile, Files.readString(itemFile).replaceFirst("enabled: false", "enabled: true"))
        val catalog = RuntimeCatalogManager(directory)
        val runtime = (catalog.reload() as RuntimeCatalogUpdate.Published).active
        val itemKey = ItemKey.parse("itemerness:travel-token")
        val definition = requireNotNull(runtime.domain.findItem(itemKey))
        val initial = TestItemStack().also { stack ->
            stack.canonical = runtime.domain.createInstance(itemKey).toSnapshot(
                definition,
                PendingItemName(
                    runtime.settings.pendingName(itemKey),
                    runtime.settings.pendingNameColorRgb,
                ),
                stack.amount,
            )
            stack.foreignCustomData = "other-plugin:old"
            stack.vanillaComponent = "minecraft:custom_name:old"
        }
        val platform = Platform(initialMainHand = initial)
        val concurrentReplacement = AtomicReference<TestItemStack?>()
        val bridge = object : BukkitCanonicalItemBridge {
            override val descriptor = BukkitCanonicalBridgeDescriptor(
                ItemKey.parse("itemerness:test-command-bridge"),
                MinecraftVersion("26.1.2"),
            )

            override fun create(
                definition: ItemDefinition,
                instance: CanonicalItemInstance,
                pendingName: PendingItemName,
                amount: Int,
            ): ItemStack = error("create is not used by this test")

            override fun rewrite(
                source: ItemStack,
                definition: ItemDefinition,
                instance: CanonicalItemInstance,
                pendingName: PendingItemName,
            ): ItemStack {
                val baseline = source as TestItemStack
                val replacement = baseline.clone().also { changed ->
                    changed.foreignCustomData = "other-plugin:new"
                    changed.vanillaComponent = "minecraft:custom_name:new"
                }
                concurrentReplacement.set(replacement)
                platform.replaceMainHand(replacement)
                return baseline.clone().also { rewritten ->
                    rewritten.canonical = instance.toSnapshot(definition, pendingName, baseline.amount)
                }
            }

            override fun inspect(source: ItemStack): CanonicalItemInspection =
                CanonicalItemInspection.Managed(requireNotNull((source as TestItemStack).canonical))

            override fun canonicalSnbt(source: ItemStack): String? = null
        }
        val actions = actions(
            platform,
            catalog = catalog,
            bridge = bridge,
            playerRefreshed = { true },
        )

        actions.writeData(
            platform.console,
            platform.player,
            InventorySlot.MAIN_HAND,
            DataKey.parse("example:quality"),
            "example:rare",
        )

        assertTrue(platform.currentMainHand() === concurrentReplacement.get())
        val preserved = platform.currentMainHand() as TestItemStack
        assertEquals("other-plugin:new", preserved.foreignCustomData)
        assertEquals("minecraft:custom_name:new", preserved.vanillaComponent)
        assertEquals(0, requireNotNull(preserved.canonical).instanceRevision)
        assertEquals(
            Component.text(
                "Target's mainhand slot changed before the edit committed",
                NamedTextColor.RED,
            ),
            platform.messages.last(),
        )
    }

    @Test
    fun `data mutation does not write when immediate refresh reservation is rejected`() {
        installBundledDomain()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(itemFile, Files.readString(itemFile).replaceFirst("enabled: false", "enabled: true"))
        val catalog = RuntimeCatalogManager(directory)
        val runtime = (catalog.reload() as RuntimeCatalogUpdate.Published).active
        val itemKey = ItemKey.parse("itemerness:travel-token")
        val definition = requireNotNull(runtime.domain.findItem(itemKey))
        val initial = TestItemStack().also { stack ->
            stack.canonical = runtime.domain.createInstance(itemKey).toSnapshot(
                definition,
                PendingItemName(
                    runtime.settings.pendingName(itemKey),
                    runtime.settings.pendingNameColorRgb,
                ),
                stack.amount,
            )
        }
        val platform = Platform(initialMainHand = initial)
        val bridge = object : BukkitCanonicalItemBridge {
            override val descriptor = BukkitCanonicalBridgeDescriptor(
                ItemKey.parse("itemerness:test-command-bridge"),
                MinecraftVersion("26.1.2"),
            )

            override fun create(
                definition: ItemDefinition,
                instance: CanonicalItemInstance,
                pendingName: PendingItemName,
                amount: Int,
            ): ItemStack = error("create is not used by this test")

            override fun rewrite(
                source: ItemStack,
                definition: ItemDefinition,
                instance: CanonicalItemInstance,
                pendingName: PendingItemName,
            ): ItemStack = (source as TestItemStack).clone().also { rewritten ->
                rewritten.canonical = instance.toSnapshot(definition, pendingName, source.amount)
            }

            override fun inspect(source: ItemStack): CanonicalItemInspection =
                CanonicalItemInspection.Managed(requireNotNull((source as TestItemStack).canonical))

            override fun canonicalSnbt(source: ItemStack): String? = null
        }
        val actions = actions(
            platform,
            catalog = catalog,
            bridge = bridge,
            playerRefreshed = { false },
        )

        actions.writeData(
            platform.console,
            platform.player,
            InventorySlot.MAIN_HAND,
            DataKey.parse("example:quality"),
            "example:rare",
        )

        assertTrue(platform.currentMainHand() === initial)
        assertEquals(0, requireNotNull(initial.canonical).instanceRevision)
        assertEquals(
            Component.text(
                "Visible item surface refresh is unavailable for Target; the slot was not changed",
                NamedTextColor.RED,
            ),
            platform.messages.last(),
        )
    }

    @Test
    fun `localized inspect view is rendered by the presentation engine and keeps private data masked`() {
        installBundledDomain()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(
            itemFile,
            Files.readString(itemFile).replaceFirst(
                "  survey-codex:\n    enabled: false",
                "  survey-codex:\n    enabled: true",
            ),
            Charsets.UTF_8,
        )
        val catalog = RuntimeCatalogManager(directory)
        val runtime = (catalog.reload() as RuntimeCatalogUpdate.Published).active
        val itemKey = ItemKey.parse("itemerness:survey-codex")
        val restored = CanonicalDomainResult.Valid(
            definition = requireNotNull(runtime.domain.findItem(itemKey)),
            instance = runtime.domain.createInstance(itemKey),
        )
        val actions = actions(Platform(), catalog = catalog)

        val inspection = actions.renderInspection(
            restored = restored,
            runtime = runtime,
            amount = 1,
            locale = "zh_cn",
            managesVanillaTooltipLines = true,
        )

        assertTrue(inspection.contains("view.name=勘探手册"), inspection)
        assertTrue(inspection.contains("记录本次远征发现的地标"), inspection)
        assertTrue(inspection.contains("example:metadata=<restricted>"), inspection)
        assertTrue(!inspection.contains("completion"), inspection)
    }

    @Test
    fun `data read command uses the same declared PDC fallback precedence as projection`() {
        installBundledDomain()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(itemFile, Files.readString(itemFile).replaceFirst("enabled: false", "enabled: true"))
        val catalog = RuntimeCatalogManager(directory)
        val runtime = (catalog.reload() as RuntimeCatalogUpdate.Published).active
        val itemKey = ItemKey.parse("itemerness:travel-token")
        val quality = DataKey.parse("example:quality")
        val definition = requireNotNull(runtime.domain.findItem(itemKey))
        val instance = runtime.domain.editInstance(
            runtime.domain.createInstance(itemKey),
            listOf(InstanceDataMutation.Remove(quality)),
        )
        val stack = TestItemStack().also { source ->
            source.canonical = instance.toSnapshot(
                definition,
                PendingItemName(runtime.settings.pendingName(itemKey), runtime.settings.pendingNameColorRgb),
                source.amount,
            )
        }
        val platform = Platform(initialMainHand = stack)
        val bridge = object : BukkitCanonicalItemBridge {
            override val descriptor = BukkitCanonicalBridgeDescriptor(
                ItemKey.parse("itemerness:test-command-bridge"),
                MinecraftVersion("26.1.2"),
            )

            override fun create(
                definition: ItemDefinition,
                instance: CanonicalItemInstance,
                pendingName: PendingItemName,
                amount: Int,
            ): ItemStack = error("create is not used by this test")

            override fun rewrite(
                source: ItemStack,
                definition: ItemDefinition,
                instance: CanonicalItemInstance,
                pendingName: PendingItemName,
            ): ItemStack = error("rewrite is not used by this test")

            override fun inspect(source: ItemStack): CanonicalItemInspection =
                CanonicalItemInspection.Managed(requireNotNull((source as TestItemStack).canonical))

            override fun canonicalSnbt(source: ItemStack): String? = null
        }
        val reads = ArrayList<ItemKey>()
        val resolver = EffectiveItemDataResolver(
            PdcFallbackReader { _, key, _ ->
                reads += key
                PdcFallbackRead.Value(NamespacedKeyDataValue(ItemKey.parse("example:rare")))
            },
        )
        val actions = actions(platform, catalog = catalog, bridge = bridge, effectiveItemData = resolver)

        actions.readData(platform.console, platform.player, InventorySlot.MAIN_HAND, quality)

        assertEquals(listOf(ItemKey.parse("legacyitems:quality")), reads)
        assertEquals(Component.text("example:rare", NamedTextColor.GRAY), platform.messages.last())
    }

    private fun actions(
        platform: Platform,
        playerRefreshed: (UUID) -> Boolean = { false },
        runtimeActive: () -> Boolean = { true },
        catalog: RuntimeCatalogManager = RuntimeCatalogManager(directory),
        catalogPublication: RuntimeCatalogPublication = RuntimeCatalogPublication.NO_OP,
        bridge: BukkitCanonicalItemBridge = proxy(BukkitCanonicalItemBridge::class.java) { method, _ ->
            defaultValue(method)
        },
        effectiveItemData: EffectiveItemDataResolver = EffectiveItemDataResolver(),
    ): DefaultItemernessCommandActions = DefaultItemernessCommandActions(
        plugin = platform.plugin,
        scheduler = FoliaScheduler(platform.plugin),
        catalog = catalog,
        bridge = bridge,
        catalogPublication = catalogPublication,
        playerRefreshed = playerRefreshed,
        runtimeActive = runtimeActive,
        effectiveItemData = effectiveItemData,
    )

    private fun installBundledDomain() {
        copyResource("config.yml")
        val resources = checkNotNull(javaClass.classLoader.getResourceAsStream("itemerness-resources.txt"))
            .bufferedReader(Charsets.UTF_8)
            .useLines { lines ->
                lines.map(String::trim)
                    .filter { it.isNotEmpty() && !it.startsWith('#') }
                    .toList()
            }
        resources.forEach(::copyResource)
    }

    private fun copyResource(path: String) {
        val destination = directory.resolve(path)
        Files.createDirectories(destination.parent)
        checkNotNull(javaClass.classLoader.getResourceAsStream(path)).use { input ->
            Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private class Platform(
        private val runAsyncImmediately: Boolean = true,
        private val runEntityImmediately: Boolean = true,
        private val rejectGlobal: Boolean = false,
        initialMainHand: ItemStack? = null,
    ) {
        val messages = ArrayList<Component>()
        val globalSubmissions = AtomicInteger()
        val asyncSubmissions = AtomicInteger()
        private val queuedAsync = ArrayList<() -> Unit>()
        private val queuedEntity = ArrayList<() -> Unit>()
        private val mainHand = AtomicReference(initialMainHand)
        private val task: ScheduledTask = proxy(ScheduledTask::class.java) { method, _ -> defaultValue(method) }

        val console: ConsoleCommandSender = proxy(ConsoleCommandSender::class.java) { method, arguments ->
            if (method.name == "sendMessage") {
                arguments.filterIsInstance<Component>().forEach(messages::add)
                null
            } else {
                defaultValue(method)
            }
        }

        private val entityScheduler: EntityScheduler = proxy(EntityScheduler::class.java) { method, arguments ->
            if (method.name == "run") {
                @Suppress("UNCHECKED_CAST")
                val action = arguments[1] as Consumer<ScheduledTask>
                if (runEntityImmediately) {
                    action.accept(task)
                } else {
                    queuedEntity += { action.accept(task) }
                }
                task
            } else {
                defaultValue(method)
            }
        }

        private val inventory: PlayerInventory = proxy(PlayerInventory::class.java) { method, arguments ->
            when (method.name) {
                "getItemInMainHand" -> mainHand.get()
                "setItemInMainHand" -> {
                    mainHand.set(arguments.single() as ItemStack)
                    null
                }
                else -> defaultValue(method)
            }
        }

        val player: Player = proxy(Player::class.java) { method, arguments ->
            when (method.name) {
                "getScheduler" -> entityScheduler
                "getInventory" -> inventory
                "getUniqueId" -> PLAYER_ID
                "getEntityId" -> 37
                "getName" -> "Target"
                "sendMessage" -> {
                    arguments.filterIsInstance<Component>().forEach(messages::add)
                    null
                }
                else -> defaultValue(method)
            }
        }

        private val globalScheduler: GlobalRegionScheduler = proxy(GlobalRegionScheduler::class.java) { method, arguments ->
            if (method.name == "run") {
                globalSubmissions.incrementAndGet()
                if (rejectGlobal) throw IllegalStateException("scheduler rejected")
                @Suppress("UNCHECKED_CAST")
                (arguments[1] as Consumer<ScheduledTask>).accept(task)
                task
            } else {
                defaultValue(method)
            }
        }

        private val asyncScheduler: AsyncScheduler = proxy(AsyncScheduler::class.java) { method, arguments ->
            if (method.name == "runNow") {
                asyncSubmissions.incrementAndGet()
                @Suppress("UNCHECKED_CAST")
                val action = arguments[1] as Consumer<ScheduledTask>
                if (runAsyncImmediately) {
                    action.accept(task)
                } else {
                    queuedAsync += { action.accept(task) }
                }
                task
            } else {
                defaultValue(method)
            }
        }

        private val server: Server = proxy(Server::class.java) { method, _ ->
            when (method.name) {
                "getGlobalRegionScheduler" -> globalScheduler
                "getAsyncScheduler" -> asyncScheduler
                "getConsoleSender" -> console
                else -> defaultValue(method)
            }
        }

        val plugin: Plugin = proxy(Plugin::class.java) { method, _ ->
            when (method.name) {
                "getServer" -> server
                "getName" -> "Itemerness"
                "isEnabled" -> true
                else -> defaultValue(method)
            }
        }

        fun runQueuedAsync() {
            queuedAsync.toList().also { queuedAsync.clear() }.forEach { it() }
        }

        fun runQueuedEntity() {
            queuedEntity.toList().also { queuedEntity.clear() }.forEach { it() }
        }

        fun currentMainHand(): ItemStack? = mainHand.get()

        fun replaceMainHand(stack: ItemStack) {
            mainHand.set(stack)
        }
    }

    private companion object {
        val PLAYER_ID: UUID = UUID.fromString("00000000-0000-0000-0000-000000000037")

        fun <T> proxy(
            type: Class<T>,
            invocation: (Method, List<Any?>) -> Any?,
        ): T = type.cast(
            Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { proxy, method, arguments ->
                when (method.name) {
                    "toString" -> "TestProxy(${type.simpleName})"
                    "hashCode" -> System.identityHashCode(proxy)
                    "equals" -> proxy === arguments?.singleOrNull()
                    else -> invocation(method, arguments?.toList().orEmpty())
                }
            },
        )

        fun defaultValue(method: Method): Any? = when (method.returnType) {
            java.lang.Boolean.TYPE -> false
            java.lang.Byte.TYPE -> 0.toByte()
            java.lang.Short.TYPE -> 0.toShort()
            java.lang.Integer.TYPE -> 0
            java.lang.Long.TYPE -> 0L
            java.lang.Float.TYPE -> 0F
            java.lang.Double.TYPE -> 0.0
            java.lang.Character.TYPE -> '\u0000'
            else -> null
        }
    }
}

@Suppress("DEPRECATION")
private class TestItemStack : ItemStack() {
    private var quantity = 1
    var canonical: CanonicalItemSnapshot? = null
    var foreignCustomData: String? = null
    var vanillaComponent: String? = null

    override fun getType(): Material = Material.PAPER

    override fun getAmount(): Int = quantity

    override fun setAmount(amount: Int) {
        quantity = amount
    }

    override fun getMaxStackSize(): Int = 64

    public override fun clone(): TestItemStack = TestItemStack().also { copy ->
        copy.amount = amount
        copy.canonical = canonical
        copy.foreignCustomData = foreignCustomData
        copy.vanillaComponent = vanillaComponent
    }

    override fun equals(other: Any?): Boolean =
        other is TestItemStack &&
            quantity == other.quantity &&
            canonical == other.canonical &&
            foreignCustomData == other.foreignCustomData &&
            vanillaComponent == other.vanillaComponent

    override fun hashCode(): Int {
        var result = quantity
        result = 31 * result + (canonical?.hashCode() ?: 0)
        result = 31 * result + (foreignCustomData?.hashCode() ?: 0)
        result = 31 * result + (vanillaComponent?.hashCode() ?: 0)
        return result
    }
}

private fun CanonicalItemInstance.toSnapshot(
    definition: ItemDefinition,
    pendingName: PendingItemName,
    amount: Int,
): CanonicalItemSnapshot = CanonicalItemSnapshot(
    itemKey = itemKey,
    materialKey = definition.material,
    count = amount,
    pendingName = pendingName.text,
    createdAgainstRevision = createdAgainstRevision,
    instanceRevision = instanceRevision,
    dataSchemas = CanonicalDataSchemas(
        schemaVersions.map { (key, version) -> CanonicalDataSchemaVersion(key, version) },
    ),
    instanceId = instanceId,
    data = ProjectionCompound(
        data.map { (key, value) -> ProjectionCompound.Entry(key.toString(), value.toProjectionValue()) },
    ),
    fingerprint = CanonicalItemFingerprint(byteArrayOf(1, instanceRevision.toByte())),
)

private fun ItemDataValue.toProjectionValue(): ProjectionValue = when (this) {
    is BooleanDataValue -> BooleanProjectionValue(value)
    is IntegerDataValue -> IntegerProjectionValue(value)
    is LongDataValue -> LongProjectionValue(value)
    is DecimalDataValue -> DecimalProjectionValue(BigDecimal.valueOf(value))
    is StringDataValue -> StringProjectionValue(value)
    is UuidDataValue -> UuidProjectionValue(value)
    is NamespacedKeyDataValue -> KeyProjectionValue(value)
    is ListDataValue -> ListProjectionValue(values.map(ItemDataValue::toProjectionValue))
    is CompoundDataValue -> ProjectionCompound(
        entries.map { (key, value) -> ProjectionCompound.Entry(key, value.toProjectionValue()) },
    )
}

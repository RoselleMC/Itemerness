package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ApiAction
import com.iroselle.itemerness.api.ApiCallResult
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.PreviewDataProvider
import com.iroselle.itemerness.api.PreviewDataRequest
import com.iroselle.itemerness.api.PreviewDataResult
import com.iroselle.itemerness.api.PreviewItem
import com.iroselle.itemerness.api.PreviewParameter
import com.iroselle.itemerness.api.PreviewParameterType
import com.iroselle.itemerness.api.PreviewScenario
import com.iroselle.itemerness.bukkit.access.AccessDecision
import com.iroselle.itemerness.bukkit.access.AccessPolicy
import com.iroselle.itemerness.bukkit.api.AuthenticatedPluginCaller
import com.iroselle.itemerness.bukkit.api.FakePlugin
import com.iroselle.itemerness.bukkit.api.PluginCallerRegistry
import com.iroselle.itemerness.bukkit.api.PreviewProviderRegistry
import com.iroselle.itemerness.bukkit.catalog.MaterialProperties
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogValidator
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.editor.agent.CompilerBridge
import com.iroselle.itemerness.editor.agent.PreviewParameters
import com.iroselle.itemerness.editor.agent.ScenarioSelection
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonObject
import com.iroselle.itemerness.editor.protocol.JsonValue
import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

/** Preview data providers (#13): draft inputs, scenario parameters, layering, ownership and failure. */
class PreviewDataProviderTest {
    @TempDir lateinit var directory: Path
    private val metrics = BuiltinFontMetricsLoader.bundled("26.1.2")
    private val owner = FakePlugin("Itemerness")
    private val consumer = FakePlugin("ExampleConsumer")
    private val registry = PreviewProviderRegistry()
    private val broker = PreviewDataBroker(owner.instance, registry, accessPolicy = { allowAll() }, timeoutMillis = 300)
    private val bridge = CompilerBridge(BundledBuiltinFontMetrics(metrics), "test", previewData = broker)
    private val attackDamage = DataKey.parse("example:attack-damage")
    private val requiredLevel = DataKey.parse("example:required-level")
    private val validator = RuntimeCatalogValidator(enchantmentProvider = { emptySet() }) { mapOf(
        ItemKey.parse("minecraft:paper") to MaterialProperties(64, null),
        ItemKey.parse("minecraft:netherite_sword") to MaterialProperties(1, 2031),
        ItemKey.parse("minecraft:book") to MaterialProperties(64, null),
        ItemKey.parse("minecraft:bundle") to MaterialProperties(1, null),
        ItemKey.parse("minecraft:echo_shard") to MaterialProperties(64, null),
    ) }

    /** Multiplies the draft's required level by the `scale` parameter, the way a template range would. */
    private inner class Scaling(
        private val output: (PreviewDataRequest, Int) -> Map<DataKey, ItemDataValue> = { request, level ->
            mapOf(attackDamage to DecimalDataValue(level * ((request.parameters["scale"] as? IntegerDataValue)?.value ?: 3).toDouble()))
        },
        private val delayMillis: Long = 0,
    ) : PreviewDataProvider {
        val reads = ArrayList<ApiCallResult<ItemDataValue?>>()
        override val revision = "test:1"
        override fun scenarios(item: PreviewItem) = listOf(
            PreviewScenario("base", "Base template"),
            PreviewScenario("build", "Build", listOf(
                PreviewParameter("scale", "Scale", PreviewParameterType.IntegerType, minimum = 1.0, maximum = 30.0),
                PreviewParameter("sockets", "Sockets", PreviewParameterType.ListOf(PreviewParameterType.Compound(listOf(
                    PreviewParameter("rune", "Rune", PreviewParameterType.KeyType, optional = false),
                    PreviewParameter("rank", "Rank", PreviewParameterType.IntegerType, minimum = 1.0, maximum = 5.0),
                )), maximumSize = 8)),
            )),
        )
        override fun provide(request: PreviewDataRequest): PreviewDataResult {
            if (delayMillis > 0) Thread.sleep(delayMillis)
            val level = request.item.readData(requiredLevel).also(reads::add)
            reads += request.item.readData(attackDamage)
            return PreviewDataResult(output(request, ((level as ApiCallResult.Success).value as IntegerDataValue).value), listOf("computed"))
        }
    }

    @AfterEach fun close() = broker.close()

    @Test
    fun `provider values computed from the draft render and are labelled with their origin`() {
        val provider = Scaling()
        register(provider)
        val document = document()
        val artifact = preview(document, ScenarioSelection("ExampleConsumer", "base", obj()))
        assertTrue(lore(artifact).any { "36.0" in it }, lore(artifact).toString())
        val provenance = artifact.requiredObject("previewData")
        assertEquals("applied", provenance.requiredString("status"))
        assertEquals("test:1", provenance.requiredString("revision"))
        assertEquals(listOf("example:attack-damage"), provenance.requiredStrings("providedKeys"))
        assertEquals(listOf("computed"), provenance.requiredStrings("messages"))
        // Definition data is readable; instance data is not an input.
        assertEquals(ApiCallResult.Success(IntegerDataValue(12)), provider.reads[0])
        assertTrue(provider.reads[1] is ApiCallResult.Denied)

        // An edit to the draft definition changes the provider's input without saving anything.
        val raised = edit(document) { item -> definitionData(item, "example:required-level", int(20)) }
        assertTrue(lore(preview(raised, ScenarioSelection("ExampleConsumer", "base", obj()))).any { "60.0" in it })
    }

    @Test
    fun `scenario parameters are typed and validated before the provider runs`() {
        register(Scaling())
        val document = document()
        val sockets = list(compound("rune" to str("example:fire-gem"), "rank" to int(2)))
        val built = preview(document, ScenarioSelection("ExampleConsumer", "build", obj("scale" to int(5), "sockets" to sockets)))
        assertTrue(lore(built).any { "60.0" in it }, lore(built).toString())
        for (invalid in listOf(obj("scale" to int(31)), obj("scale" to dec("2.5")), obj("unknown" to int(1)),
            obj("sockets" to list(compound("rank" to int(1)))))) {
            val failed = preview(document, ScenarioSelection("ExampleConsumer", "build", invalid)).requiredObject("previewData")
            assertEquals("PARAMETERS_INVALID", failed.requiredObject("failure").requiredString("code"), Json.canonicalize(invalid))
        }

        val scenarios = JsonObject.of(bridge.previewScenarios(Json.canonicalize(document), digest(document), EMBER, "en_us"), "scenarios")
        val provider = scenarios.requiredObjects("providers").single()
        assertEquals("ExampleConsumer", provider.requiredString("plugin"))
        assertEquals(listOf("base", "build"), provider.requiredObjects("scenarios").map { it.requiredString("id") })
        val socketType = provider.requiredObjects("scenarios")[1].requiredObjects("parameters")[1].requiredObject("type")
        assertEquals("list", socketType.requiredString("kind"))
        assertEquals("compound", socketType.requiredObject("element").requiredString("kind"))
    }

    @Test
    fun `a manual preview value overrides the provider for its key only`() {
        register(Scaling())
        val document = edit(document()) { item ->
            JsonValue.Obj(item.entries + ("previewData" to JsonValue.Arr(listOf(obj("key" to JsonValue.Text("example:attack-damage"), "value" to dec("99.5"))))))
        }
        val artifact = preview(document, ScenarioSelection("ExampleConsumer", "base", obj()))
        assertTrue(lore(artifact).any { "99.5" in it }, lore(artifact).toString())
        val provenance = artifact.requiredObject("previewData")
        assertEquals(emptyList<String>(), provenance.requiredStrings("providedKeys"))
        assertEquals(listOf("example:attack-damage"), provenance.requiredStrings("overriddenKeys"))
    }

    @Test
    fun `unauthorized keys, slow providers and missing providers fail visibly and keep the preview`() {
        register(Scaling(output = { _, _ -> mapOf(DataKey.parse("itemerness:created-at") to LongDataValue(1)) }))
        val document = document()
        assertFailure(preview(document, ScenarioSelection("ExampleConsumer", "base", obj())), "KEY_NOT_WRITABLE")

        register(Scaling(delayMillis = 2_000))
        assertFailure(preview(document, ScenarioSelection("ExampleConsumer", "base", obj())), "TIMEOUT")

        register(Scaling(output = { _, _ -> mapOf(attackDamage to IntegerDataValue(1)) }))
        assertFailure(preview(document, ScenarioSelection("ExampleConsumer", "base", obj())), "VALUE_INVALID")

        registry.retire("ExampleConsumer")
        assertFailure(preview(document, ScenarioSelection("ExampleConsumer", "base", obj())), "PROVIDER_UNAVAILABLE")
        assertFailure(preview(document, ScenarioSelection("ExampleConsumer", "missing", obj())), "PROVIDER_UNAVAILABLE")
    }

    @Test
    fun `parameter decoding rejects values outside the declaration`() {
        val parameters = listOf(
            PreviewParameter("affixes", "Affixes", PreviewParameterType.ListOf(PreviewParameterType.TextType, maximumSize = 2), choices = listOf("a/x", "b/y")),
            PreviewParameter("seed", "Seed", PreviewParameterType.LongType),
            PreviewParameter("level", "Level", PreviewParameterType.IntegerType, optional = false),
        )
        val decoded = PreviewParameters.decode(parameters, obj("affixes" to list(str("a/x")), "level" to int(3)))
        assertEquals(mapOf("affixes" to ListDataValue(listOf(com.iroselle.itemerness.api.StringDataValue("a/x"))), "level" to IntegerDataValue(3)), decoded)
        for (invalid in listOf(
            obj("level" to int(1), "affixes" to list(str("c/z"))),
            obj("level" to int(1), "affixes" to list(str("a/x"), str("a/x"), str("a/x"))),
            obj("level" to int(1), "seed" to dec("1.5")),
            obj("level" to int(3_000_000_000)),
            obj("seed" to int(1)),
        )) {
            assertThrows(IllegalArgumentException::class.java) { PreviewParameters.decode(parameters, invalid) }
        }
        assertEquals(CompoundDataValue(mapOf("rune" to com.iroselle.itemerness.api.NamespacedKeyDataValue(ItemKey.parse("example:fire-gem")))),
            PreviewParameters.decode(listOf(PreviewParameter("socket", "Socket", PreviewParameterType.Compound(listOf(
                PreviewParameter("rune", "Rune", PreviewParameterType.KeyType))))),
                obj("socket" to compound("rune" to str("example:fire-gem"))))["socket"])
        // Longs travel as strings, so values beyond 2^53 arrive intact.
        assertEquals(LongDataValue(Long.MAX_VALUE), PreviewParameters.decode(parameters, obj("level" to int(1), "seed" to int(Long.MAX_VALUE)))["seed"])
    }

    private fun assertFailure(artifact: JsonObject, code: String) {
        val provenance = artifact.requiredObject("previewData")
        assertEquals("failed", provenance.requiredString("status"))
        assertEquals(code, provenance.requiredObject("failure").requiredString("code"))
        assertTrue(artifact.requiredObjects("diagnostics").any { it.requiredString("code") == "PREVIEW.PROVIDER_FAILED" && it.requiredString("severity") == "WARNING" })
        assertEquals(JsonValue.Null, artifact.raw("failure"), "the item still renders from the remaining data")
    }

    private fun register(provider: PreviewDataProvider) {
        val caller = (AuthenticatedPluginCaller.authenticate(consumer.instance, PluginCallerRegistry(listOf(consumer.instance))) as ApiCallResult.Success).value
        registry.register(caller, provider)
    }

    private fun preview(document: JsonValue, scenario: ScenarioSelection): JsonObject {
        val outcome = bridge.compilePreview(Json.canonicalize(document), CompilerBridge.PreviewContext(
            itemId = EMBER, locale = "en_us", requestedTheme = null, assetProfile = null, capabilities = emptyList(), metricsRevision = null,
            resourcePackLoaded = false, managesVanillaTooltipLines = false, snapshotHash = digest(document), scenario = scenario,
        ))
        val json = when (outcome) {
            is CompilerBridge.Outcome.Rendered -> outcome.json
            is CompilerBridge.Outcome.Rejected -> outcome.json
        }
        return JsonObject.parse(json, "artifact")
    }

    private fun lore(artifact: JsonObject): List<String> = artifact.requiredObject("display").requiredObjects("lore").map { line ->
        line.requiredObjects("runs").joinToString("") { it.requiredString("text") }
    }

    private fun document(): JsonValue {
        val resources = Path.of("src/main/resources")
        (EditorCatalogFiles.DOMAINS + "config.yml").forEach { name ->
            val source = resources.resolve(name)
            if (Files.isDirectory(source)) {
                Files.walk(source).use { paths -> paths.forEach { path ->
                    val target = directory.resolve(resources.relativize(path))
                    if (Files.isDirectory(path)) Files.createDirectories(target) else if (!Files.exists(target)) Files.copy(path, target)
                } }
            } else if (!Files.exists(directory.resolve(name))) Files.copy(source, directory.resolve(name))
        }
        val read = EditorCatalogReader(directory, metrics, "test", validator).read()
        return edit(requireNotNull(JsonObject.of(read, "response").raw("document"))) { item -> JsonValue.Obj(item.entries + ("enabled" to JsonValue.Bool(true))) }
    }

    private fun edit(document: JsonValue, change: (JsonValue.Obj) -> JsonValue.Obj): JsonValue {
        val root = document as JsonValue.Obj
        val items = (root.entries.getValue("items") as JsonValue.Arr).values.map { value ->
            val item = value as JsonValue.Obj
            if ((item.entries.getValue("id") as JsonValue.Text).value.endsWith("ember-blade")) change(item) else item
        }
        return JsonValue.Obj(root.entries + ("items" to JsonValue.Arr(items)))
    }

    private fun definitionData(item: JsonValue.Obj, key: String, value: JsonValue): JsonValue.Obj {
        val definition = item.entries.getValue("definition") as JsonValue.Obj
        val data = (definition.entries.getValue("definitionData") as JsonValue.Arr).values.map { entry ->
            val assignment = entry as JsonValue.Obj
            if ((assignment.entries.getValue("key") as JsonValue.Text).value == key) JsonValue.Obj(assignment.entries + ("value" to value)) else assignment
        }
        return JsonValue.Obj(item.entries + ("definition" to JsonValue.Obj(definition.entries + ("definitionData" to JsonValue.Arr(data)))))
    }

    private fun int(value: Long) = obj("kind" to JsonValue.Text("integer"), "value" to JsonValue.Text(value.toString()))
    private fun int(value: Int) = int(value.toLong())
    private fun dec(value: String) = obj("kind" to JsonValue.Text("decimal"), "value" to JsonValue.Text(value))
    private fun str(value: String) = obj("kind" to JsonValue.Text("string"), "value" to JsonValue.Text(value))
    private fun list(vararg values: JsonValue) = obj("kind" to JsonValue.Text("list"), "values" to JsonValue.Arr(values.toList()))
    private fun compound(vararg entries: Pair<String, JsonValue>) = obj("kind" to JsonValue.Text("compound"), "entries" to obj(*entries))

    private fun digest(document: JsonValue) = com.iroselle.itemerness.editor.agent.EditorDraftStore.digest(Json.canonicalize(document))
    private fun obj(vararg entries: Pair<String, JsonValue>) = JsonValue.Obj(linkedMapOf(*entries))
    private fun allowAll() = AccessPolicy(ApiAction.entries.associateWith { action ->
        if (action == ApiAction.READ_DATA) AccessDecision.SCHEMA_POLICY else AccessDecision.ALLOW
    }, emptyList())

    private companion object {
        const val EMBER = "itemerness:ember-blade"
    }
}

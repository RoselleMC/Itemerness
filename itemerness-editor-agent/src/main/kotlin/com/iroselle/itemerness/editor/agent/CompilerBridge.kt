package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.core.catalog.CatalogDiagnostic
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.CatalogSnapshot
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.catalog.InstanceDataMutation
import com.iroselle.itemerness.core.catalog.SourceDataValue
import com.iroselle.itemerness.core.presentation.NestedItemPresentation
import com.iroselle.itemerness.core.presentation.PresentationBudgets
import com.iroselle.itemerness.core.presentation.PresentationCatalogSnapshot
import com.iroselle.itemerness.core.presentation.PresentationDisplay
import com.iroselle.itemerness.core.presentation.PresentationEngine
import com.iroselle.itemerness.core.presentation.PresentationRenderRequest
import com.iroselle.itemerness.core.presentation.PresentationRenderResult
import com.iroselle.itemerness.core.presentation.PresentationViewer
import com.iroselle.itemerness.core.presentation.TextDirection
import com.iroselle.itemerness.editor.protocol.BuiltinFontMetrics
import com.iroselle.itemerness.editor.protocol.Json
import com.iroselle.itemerness.editor.protocol.JsonException
import com.iroselle.itemerness.editor.protocol.JsonValue
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import java.security.MessageDigest
import java.util.HexFormat
import java.util.UUID

/**
 * Compiles an authoring document with the production compiler and renders one item.
 *
 * This is what makes a preview `server-verified` rather than `local`. The browser can measure text
 * and guess at wrapping; only this path runs `PresentationCompiler`, `CatalogCompiler`, and
 * `PresentationEngine` — the same three the plugin uses to project items to real players — against
 * this server's font metrics, resource-pack profiles, and budgets.
 *
 * It is deliberately free of Bukkit types. Compiling is pure computation over immutable inputs, so
 * it runs on the async scheduler; only publishing the result to a player needs an owning context.
 */
class CompilerBridge(
    private val builtinFontMetrics: BuiltinFontMetrics,
    private val agentVersion: String,
    /** Read per request so a catalog reload that changes the limits applies to the next preview. */
    private val budgets: () -> PresentationBudgets = { PresentationBudgets() },
    /** Plugin-computed values for preview scenarios; null when the platform offers no providers. */
    private val previewData: PreviewDataSource? = null,
    /** The canonical document for a snapshot hash the server holds, such as the saved draft. */
    private val snapshotDocuments: (String) -> String? = { null },
    private val validateRuntimeContent: (
        ProjectDocumentCodec.Decoded,
        CatalogSnapshot,
        PresentationCatalogSnapshot,
    ) -> List<CatalogDiagnostic> = { _, _, _ -> emptyList() },
) {
    private val documentCompiler = DocumentCompiler(builtinFontMetrics, budgets, validateRuntimeContent)
    private val recentCompilations = LinkedHashMap<Pair<String, PresentationBudgets>, Pair<Long, DocumentCompiler.Result>>()
    private val compilations = java.util.concurrent.atomic.AtomicInteger()
    /** Whole-document compilations performed so far; previews served from [compiled] do not count. */
    val compilationCount: Int get() = compilations.get()

    /**
     * Compiles a document once for all of its previews. Previewing another item, or warming several, sends
     * the same document again, and a production catalog takes hundreds of milliseconds to compile. Results
     * are immutable snapshots, so concurrent previews can share them. An entry also matches the current
     * budgets and expires, because runtime validation reads server registries that a reload can change.
     */
    private fun compiled(canonicalDocument: String, hash: String = documentDigest(canonicalDocument)): DocumentCompiler.Result {
        val key = hash to budgets()
        val now = System.nanoTime()
        synchronized(recentCompilations) {
            recentCompilations[key]?.takeIf { now - it.first < COMPILATION_LIFETIME_NANOS }?.let { return it.second }
        }
        compilations.incrementAndGet()
        val result = documentCompiler.compile(canonicalDocument)
        synchronized(recentCompilations) {
            recentCompilations.remove(key)
            recentCompilations[key] = now to result
            while (recentCompilations.size > RECENT_COMPILATIONS) recentCompilations.remove(recentCompilations.keys.first())
        }
        return result
    }

    fun validateDocument(document: JsonValue): List<JsonValue> = when (val result = compiled(Json.canonicalize(document))) {
        is DocumentCompiler.Result.Valid -> emptyList()
        is DocumentCompiler.Result.Invalid -> result.diagnostics.map { diagnosticJson(it.code, it.messageKey, it.params) } +
            diagnosticJson(result.code, result.messageKey, result.params)
    }

    class PreviewContext(
        val itemId: String,
        val locale: String,
        val requestedTheme: String?,
        val assetProfile: String?,
        capabilities: Collection<String>,
        val metricsRevision: String?,
        val resourcePackLoaded: Boolean,
        val managesVanillaTooltipLines: Boolean,
        val snapshotHash: String,
        val documentSchemaVersion: Int? = null,
        /** A provider scenario to compute instance data for; manual preview data still overrides it per key. */
        val scenario: ScenarioSelection? = null,
    ) {
        val capabilities: List<String> = java.util.List.copyOf(capabilities)

        fun withSnapshotHash(snapshotHash: String, documentSchemaVersion: Int? = this.documentSchemaVersion): PreviewContext =
            PreviewContext(
                itemId = itemId,
                locale = locale,
                requestedTheme = requestedTheme,
                assetProfile = assetProfile,
                capabilities = capabilities,
                metricsRevision = metricsRevision,
                resourcePackLoaded = resourcePackLoaded,
                managesVanillaTooltipLines = managesVanillaTooltipLines,
                snapshotHash = snapshotHash,
                documentSchemaVersion = documentSchemaVersion,
                scenario = scenario,
            )
    }

    sealed interface Outcome {
        /** A compiled preview. `json` is the artifact the plugin API returns to the editor. */
        data class Rendered(val json: String, val compileMillis: Long) : Outcome

        /** A structured refusal. Diagnostics travel as codes and keys, never rendered prose. */
        data class Rejected(val json: String, val compileMillis: Long) : Outcome
    }

    fun compilePreview(documentJson: String, requestContext: PreviewContext): Outcome {
        val started = System.nanoTime()
        val diagnostics = ArrayList<JsonValue>()
        val parsedDocument = try {
            Json.parse(documentJson)
        } catch (exception: JsonException) {
            return reject(
                "DECODE_FAILED",
                "diagnostics.document.decode_failed",
                mapOf("detail" to (exception.message ?: "invalid document")),
                requestContext,
                diagnostics,
                started,
            )
        }
        val canonicalDocument = Json.canonicalize(parsedDocument)
        val actualSnapshotHash = documentDigest(canonicalDocument)
        val documentVersion = ((parsedDocument as? JsonValue.Obj)?.entries?.get("schemaVersion") as? JsonValue.Num)
            ?.value?.toInt()
        val context = requestContext.withSnapshotHash(actualSnapshotHash, documentVersion)
        if (requestContext.snapshotHash != actualSnapshotHash) {
            return reject(
                "SNAPSHOT_MISMATCH",
                "diagnostics.document.snapshot_mismatch",
                mapOf("actual" to actualSnapshotHash),
                context,
                diagnostics,
                started,
            )
        }

        return render(compiled(canonicalDocument, actualSnapshotHash), context, diagnostics, started)
    }

    /**
     * Previews a canonical document whose hash the caller already verified against
     * [PreviewContext.snapshotHash], without parsing or hashing it again. A large document costs
     * several copies of its size each time it is re-encoded.
     */
    fun compileVerified(canonicalDocument: String, context: PreviewContext): Outcome =
        render(compiled(canonicalDocument, context.snapshotHash), context, ArrayList(), System.nanoTime())

    /**
     * Previews a snapshot the server already holds, either compiled recently or available from
     * [snapshotDocuments], so the editor need not upload an unchanged document again. Null means the
     * snapshot is unknown and the caller must send the document.
     */
    fun compileSnapshot(context: PreviewContext): Outcome? {
        val started = System.nanoTime()
        val compilation = recent(context.snapshotHash)
            ?: snapshotDocuments(context.snapshotHash)?.let { compiled(it, context.snapshotHash) }
            ?: return null
        return render(compilation, context, ArrayList(), started)
    }

    private fun recent(hash: String): DocumentCompiler.Result? {
        val now = System.nanoTime()
        return synchronized(recentCompilations) {
            recentCompilations[hash to budgets()]?.takeIf { now - it.first < COMPILATION_LIFETIME_NANOS }?.second
        }
    }

    private fun render(result: DocumentCompiler.Result, requestContext: PreviewContext, diagnostics: MutableList<JsonValue>, started: Long): Outcome {
        val compilation = when (result) {
            is DocumentCompiler.Result.Valid -> result
            is DocumentCompiler.Result.Invalid -> {
                diagnostics += result.diagnostics.map { diagnosticJson(it.code, it.messageKey, it.params) }
                return reject(result.code, result.messageKey, result.params, requestContext, diagnostics, started)
            }
        }
        val context = if (requestContext.documentSchemaVersion != null) requestContext
            else requestContext.withSnapshotHash(requestContext.snapshotHash, compilation.decoded.schemaVersion)
        val decoded = compilation.decoded
        val domainCatalog = compilation.domain
        val catalog = compilation.previewPresentation

        val itemKey =
            try {
                ItemKey.parse(context.itemId)
            } catch (exception: IllegalArgumentException) {
                return reject(
                    "UNKNOWN_ITEM",
                    "diagnostics.item.unknown",
                    mapOf("item" to context.itemId),
                    context,
                    diagnostics,
                    started,
                )
            }

        val definition = domainCatalog.findItem(itemKey) as? CatalogItemDefinition
            ?: return reject(
                "UNKNOWN_ITEM",
                "diagnostics.item.unknown",
                mapOf("item" to context.itemId),
                context,
                diagnostics,
                started,
            )

        val viewer = PresentationViewer(
            locale = context.locale,
            requestedTheme = context.requestedTheme?.let(ItemKey::parse),
            assetProfile = context.assetProfile?.let(ItemKey::parse),
            capabilities = context.capabilities.map(ItemKey::parse),
            metricsRevision = context.metricsRevision?.let(ItemKey::parse),
            facts = decoded.previewFacts.mapKeys { ItemKey.parse(it.key) },
            resourcePackLoaded = context.resourcePackLoaded,
            managesVanillaTooltipLines = context.managesVanillaTooltipLines,
            direction = TextDirection.LEFT_TO_RIGHT,
        )

        // Definition data, then provider values, then manual preview data: a manual value deliberately
        // overrides the provider for one key, for example to test an extreme width.
        var provided = context.scenario?.let { selection ->
            previewData?.provide(PreviewDataItem(definition, definition.definitionData, decoded, context.locale), selection)
                ?: ProvidedPreviewData.Failed(selection.plugin, selection.scenario, null, "PROVIDERS_UNSUPPORTED", "This server offers no preview data providers")
        }
        val manual = decoded.previewData[context.itemId].orEmpty()
        val instance = try {
            var created = domainCatalog.createInstance(itemKey)
            (provided as? ProvidedPreviewData.Applied)?.takeIf { it.values.isNotEmpty() }?.let { applied ->
                try {
                    created = domainCatalog.editInstance(created, applied.values.map { (key, value) -> InstanceDataMutation.Set(key, value) })
                } catch (exception: RuntimeException) {
                    provided = ProvidedPreviewData.Failed(applied.plugin, applied.scenario, applied.revision, "VALUE_INVALID",
                        exception.message ?: "The provider returned an invalid value")
                }
            }
            val mutations = manual.map { assignment ->
                val key = DataKey.parse(assignment.key)
                val keyDefinition = requireNotNull(domainCatalog.dataKeyDefinition(itemKey, key)) {
                    "Data key $key is not defined for $itemKey"
                }
                if (assignment.value == SourceDataValue.NullValue) {
                    InstanceDataMutation.Remove(key)
                } else {
                    InstanceDataMutation.Set(
                        key,
                        SourceValueConversion.convert(assignment.value, keyDefinition.type),
                    )
                }
            }
            domainCatalog.editInstance(created, mutations)
        } catch (exception: RuntimeException) {
            return reject(
                "DOCUMENT_INVALID",
                "diagnostics.document.preview_data_invalid",
                mapOf("item" to context.itemId, "detail" to (exception.message ?: "invalid preview data")),
                context,
                diagnostics,
                started,
            )
        }
        val data = LinkedHashMap(definition.definitionData).apply {
            putAll(instance.data)
        }
        val provenance = provided?.let { provenanceJson(it, manual.map { assignment -> assignment.key }.toSet()) }
        // An unavailable provider must not pass for a faithful runtime preview.
        (provided as? ProvidedPreviewData.Failed)?.let { failed ->
            diagnostics += diagnosticJson("PREVIEW.PROVIDER_FAILED", "diagnostics.preview.provider_failed", mapOf(
                "plugin" to failed.plugin, "scenario" to failed.scenario, "code" to failed.code, "detail" to failed.detail.take(512),
            ), severity = "WARNING")
        }

        val engine = PresentationEngine(catalog)
        val nestedItems = try {
            definition.contents.map { content ->
                NestedItemPresentation(
                    itemKey = content.item,
                    displayName = engine.itemDisplayName(content.item, viewer.locale).getOrThrow(),
                    amount = content.amount,
                )
            }
        } catch (exception: RuntimeException) {
            return reject(
                "NO_SAFE_THEME",
                "diagnostics.render.rendering_failed",
                mapOf("detail" to (exception.message ?: "nested item presentation failed")),
                context,
                diagnostics,
                started,
            )
        }

        val result = engine.render(PresentationRenderRequest(itemKey, data, viewer, nestedItems))
        val elapsed = (System.nanoTime() - started) / 1_000_000

        return when (result) {
            is PresentationRenderResult.Rendered ->
                Outcome.Rendered(
                    artifactJson(result.display, context, diagnostics, failure = null, compileMillis = elapsed, previewData = provenance),
                    elapsed,
                )

            is PresentationRenderResult.Rejected ->
                Outcome.Rejected(
                    artifactJson(
                        display = null,
                        context = context,
                        diagnostics = diagnostics,
                        failure = obj(
                            "code" to text(result.failure.code.name),
                            "messageKey" to text("diagnostics.render.${result.failure.code.name.lowercase()}"),
                            "params" to obj("detail" to text(result.failure.message)),
                        ),
                        compileMillis = elapsed,
                        previewData = provenance,
                    ),
                    elapsed,
                )
        }
    }

    // --- serialization ---------------------------------------------------------------------

    private fun artifactJson(
        display: PresentationDisplay?,
        context: PreviewContext,
        diagnostics: List<JsonValue>,
        failure: JsonValue?,
        compileMillis: Long,
        previewData: JsonValue? = null,
    ): String {
        val artifact = obj(
            "schemaVersion" to num(1.0),
            // Only a real compile on a real target may claim this. The mock in the control plane
            // reports "mock" for exactly the same reason.
            "origin" to text("agent"),
            "itemId" to text(context.itemId),
            "viewer" to viewerJson(context),
            "display" to (display?.let(::displayJson) ?: JsonValue.Null),
            "fidelity" to JsonValue.Arr(emptyList()),
            "diagnostics" to JsonValue.Arr(diagnostics),
            "digests" to obj(
                "snapshot" to text(context.snapshotHash),
                "compiler" to text(compilerDigest()),
                "documentSchema" to (context.documentSchemaVersion?.let { text("schema-$it") } ?: JsonValue.Null),
                "capability" to text(capabilityDigest(context)),
                "asset" to (context.metricsRevision?.let(::text) ?: JsonValue.Null),
            ),
            "compileMillis" to num(compileMillis.toDouble()),
            "failure" to (failure ?: JsonValue.Null),
            "previewData" to (previewData ?: JsonValue.Null),
        )
        return Json.canonicalize(artifact)
    }

    /** Which values came from a provider and which a manual preview value overrode, so the editor can label them. */
    private fun provenanceJson(provided: ProvidedPreviewData, manualKeys: Set<String>): JsonValue = when (provided) {
        is ProvidedPreviewData.Applied -> {
            val keys = provided.values.keys.map(DataKey::toString).sorted()
            obj(
                "plugin" to text(provided.plugin),
                "scenario" to text(provided.scenario),
                "revision" to text(provided.revision),
                "status" to text("applied"),
                "providedKeys" to JsonValue.Arr(keys.filter { it !in manualKeys }.map(::text)),
                "overriddenKeys" to JsonValue.Arr(keys.filter { it in manualKeys }.map(::text)),
                "messages" to JsonValue.Arr(provided.messages.take(16).map { text(it.take(512)) }),
                // The values let the editor's local draft paint the same data until the next verified preview.
                "values" to JsonValue.Arr(provided.values.entries.sortedBy { it.key.toString() }.map { (key, value) ->
                    obj("key" to text(key.toString()), "value" to PreviewParameters.valueJson(value))
                }),
                "failure" to JsonValue.Null,
            )
        }
        is ProvidedPreviewData.Failed -> obj(
            "plugin" to text(provided.plugin),
            "scenario" to text(provided.scenario),
            "revision" to (provided.revision?.let(::text) ?: JsonValue.Null),
            "status" to text("failed"),
            "providedKeys" to JsonValue.Arr(emptyList()),
            "overriddenKeys" to JsonValue.Arr(emptyList()),
            "messages" to JsonValue.Arr(emptyList()),
            "values" to JsonValue.Arr(emptyList()),
            "failure" to obj("code" to text(provided.code), "detail" to text(provided.detail.take(512))),
        )
    }

    /**
     * The scenarios each provider offers for one item of a draft. A document that does not compile or an
     * unknown item yields no providers and a failure code, so the editor can explain the empty list.
     */
    fun previewScenarios(documentJson: String, snapshotHash: String, itemId: String, locale: String): JsonValue {
        val canonical = try { Json.canonicalize(Json.parse(documentJson)) } catch (_: JsonException) { return scenariosFailed(itemId, "DECODE_FAILED") }
        if (documentDigest(canonical) != snapshotHash) return scenariosFailed(itemId, "SNAPSHOT_MISMATCH")
        return previewScenarios(compiled(canonical, snapshotHash), itemId, locale)
    }

    /** As above for a verified canonical document, or a held snapshot when [canonicalDocument] is null; null if unknown. */
    fun previewScenariosVerified(canonicalDocument: String?, snapshotHash: String, itemId: String, locale: String): JsonValue? {
        val result = canonicalDocument?.let { compiled(it, snapshotHash) }
            ?: recent(snapshotHash)
            ?: snapshotDocuments(snapshotHash)?.let { compiled(it, snapshotHash) }
            ?: return null
        return previewScenarios(result, itemId, locale)
    }

    private fun scenariosFailed(itemId: String, code: String) =
        obj("itemId" to text(itemId), "providers" to JsonValue.Arr(emptyList()), "failure" to text(code))

    private fun previewScenarios(result: DocumentCompiler.Result, itemId: String, locale: String): JsonValue {
        fun failed(code: String) = scenariosFailed(itemId, code)
        val compilation = result as? DocumentCompiler.Result.Valid ?: return failed("DOCUMENT_INVALID")
        val itemKey = try { ItemKey.parse(itemId) } catch (_: IllegalArgumentException) { return failed("UNKNOWN_ITEM") }
        val definition = compilation.domain.findItem(itemKey) as? CatalogItemDefinition ?: return failed("UNKNOWN_ITEM")
        val source = previewData ?: return obj("itemId" to text(itemId), "providers" to JsonValue.Arr(emptyList()), "failure" to JsonValue.Null)
        val providers = source.scenarios(PreviewDataItem(definition, definition.definitionData, compilation.decoded, locale)).map { offered ->
            when (offered) {
                is ProviderScenarios.Offered -> obj(
                    "plugin" to text(offered.plugin),
                    "status" to text("offered"),
                    "revision" to text(offered.revision),
                    "scenarios" to JsonValue.Arr(offered.scenarios.map(PreviewParameters::scenarioJson)),
                    "failure" to JsonValue.Null,
                )
                is ProviderScenarios.Failed -> obj(
                    "plugin" to text(offered.plugin),
                    "status" to text("failed"),
                    "revision" to JsonValue.Null,
                    "scenarios" to JsonValue.Arr(emptyList()),
                    "failure" to obj("code" to text(offered.code), "detail" to text(offered.detail.take(512))),
                )
            }
        }
        return obj("itemId" to text(itemId), "providers" to JsonValue.Arr(providers), "failure" to JsonValue.Null)
    }

    private fun viewerJson(context: PreviewContext): JsonValue =
        obj(
            "locale" to text(context.locale),
            "requestedTheme" to (context.requestedTheme?.let(::text) ?: JsonValue.Null),
            "assetProfile" to (context.assetProfile?.let(::text) ?: JsonValue.Null),
            "capabilities" to JsonValue.Arr(context.capabilities.map(::text)),
            "metricsRevision" to (context.metricsRevision?.let(::text) ?: JsonValue.Null),
            "resourcePackLoaded" to JsonValue.Bool(context.resourcePackLoaded),
            "managesVanillaTooltipLines" to JsonValue.Bool(context.managesVanillaTooltipLines),
            "direction" to text("LEFT_TO_RIGHT"),
        )

    private fun displayJson(display: PresentationDisplay): JsonValue =
        obj(
            "displayName" to lineJson(display.displayName),
            "lore" to JsonValue.Arr(display.lore.map(::lineJson)),
            "tooltipStyle" to (display.tooltipStyle?.toString()?.let(::text) ?: JsonValue.Null),
            "renderer" to text(display.renderer.name),
            "selectedTheme" to text(display.selectedTheme.toString()),
            "requestedTheme" to text(display.requestedTheme.toString()),
            "catalogRevision" to num(display.catalogRevision.toDouble()),
            "fallbackReasons" to JsonValue.Arr(
                display.fallbackReasons.map {
                    obj(
                        "theme" to text(it.theme.toString()),
                        "code" to text(it.code.name),
                        "detail" to text(it.detail),
                    )
                },
            ),
            "hiddenElements" to JsonValue.Arr(display.hiddenElements.map(::text)),
        )

    private fun lineJson(line: com.iroselle.itemerness.core.presentation.PresentationLine): JsonValue =
        obj(
            "runs" to JsonValue.Arr(
                line.runs.map { run ->
                    obj(
                        "text" to text(run.text),
                        "kind" to text(run.kind.name),
                        "unbreakable" to JsonValue.Bool(run.unbreakable),
                        "style" to obj(
                            "color" to (run.style.color?.let { num(it.toDouble()) } ?: JsonValue.Null),
                            "font" to (run.style.font?.toString()?.let(::text) ?: JsonValue.Null),
                            "bold" to JsonValue.Bool(run.style.bold),
                            "italic" to JsonValue.Bool(run.style.italic),
                            "underlined" to JsonValue.Bool(run.style.underlined),
                            "strikethrough" to JsonValue.Bool(run.style.strikethrough),
                        ),
                    )
                },
            ),
            "logicalWidthPixels" to num(line.logicalWidthPixels.toDouble()),
            "visualBounds" to obj(
                "left" to num(line.visualBounds.left),
                "right" to num(line.visualBounds.right),
                "top" to num(line.visualBounds.top),
                "bottom" to num(line.visualBounds.bottom),
            ),
        )

    private fun reject(
        code: String,
        messageKey: String,
        params: Map<String, String>,
        context: PreviewContext,
        diagnostics: MutableList<JsonValue>,
        startedNanos: Long,
    ): Outcome.Rejected {
        diagnostics += diagnosticJson("DOCUMENT.$code", messageKey, params)
        val elapsed = (System.nanoTime() - startedNanos) / 1_000_000
        return Outcome.Rejected(
            artifactJson(
                display = null,
                context = context,
                diagnostics = diagnostics,
                failure = obj(
                    "code" to text(code),
                    "messageKey" to text(messageKey),
                    "params" to obj(*params.map { it.key to text(it.value) }.toTypedArray()),
                ),
                compileMillis = elapsed,
            ),
            elapsed,
        )
    }

    private fun diagnosticJson(code: String, messageKey: String, params: Map<String, String>, severity: String = "ERROR"): JsonValue =
        obj(
            "code" to text(code),
            "severity" to text(severity),
            "origin" to text("agent"),
            "messageKey" to text(messageKey),
            "params" to obj(*params.map { it.key to text(it.value) }.toTypedArray()),
            "pointer" to JsonValue.Null,
            "nodeUuid" to JsonValue.Null,
            "businessId" to JsonValue.Null,
            "targetServerId" to JsonValue.Null,
            "fixKey" to JsonValue.Null,
        )

    /**
     * Identifies the compiler that produced an artifact. A preview compiled by a different plugin
     * build or client metrics is a different answer.
     */
    fun compilerDigest(): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$agentVersion|schemas-${ProjectDocumentCodec.SUPPORTED_SCHEMA_VERSIONS.joinToString(",")}|catalog-validation-8|metrics-${builtinFontMetrics.clientVersion}".toByteArray())
        return "sha256:${HexFormat.of().formatHex(digest)}"
    }

    private fun documentDigest(canonicalDocument: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(canonicalDocument.toByteArray(Charsets.UTF_8))
        return "sha256:${HexFormat.of().formatHex(digest)}"
    }

    private fun capabilityDigest(context: PreviewContext): String {
        val canonical = Json.canonicalize(
            obj(
                "assetProfile" to (context.assetProfile?.let(::text) ?: JsonValue.Null),
                "capabilities" to JsonValue.Arr(context.capabilities.sorted().map(::text)),
                "metricsRevision" to (context.metricsRevision?.let(::text) ?: JsonValue.Null),
            ),
        )
        val digest = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray())
        return "sha256:${HexFormat.of().formatHex(digest).substring(0, 32)}"
    }

    private companion object {
        /** The current document and the one before it, for example an export racing a newer preview. */
        const val RECENT_COMPILATIONS = 2
        val COMPILATION_LIFETIME_NANOS: Long = java.util.concurrent.TimeUnit.SECONDS.toNanos(60)

        fun text(value: String): JsonValue = JsonValue.Text(value)

        fun num(value: Double): JsonValue = JsonValue.Num(value)

        fun obj(vararg entries: Pair<String, JsonValue>): JsonValue = JsonValue.Obj(linkedMapOf(*entries))
    }
}

/** Converts preview values according to the compiled data schema before the domain edit validates them. */
internal object SourceValueConversion {
    fun convert(value: SourceDataValue, type: DataType): ItemDataValue {
        require(value != SourceDataValue.NullValue) { "Null preview values must be represented as removals" }
        return when (type) {
            DataType.BooleanType -> BooleanDataValue(
                (value as? SourceDataValue.BooleanValue).required("boolean").value,
            )
            DataType.IntegerType -> {
                val number = (value as? SourceDataValue.IntegerValue).required("integer").value
                require(number in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
                    "Integer preview value is outside the 32-bit range"
                }
                IntegerDataValue(number.toInt())
            }
            DataType.LongType -> LongDataValue((value as? SourceDataValue.IntegerValue).required("long").value)
            DataType.DecimalType -> DecimalDataValue(
                when (value) {
                    is SourceDataValue.DecimalValue -> value.value.toDouble()
                    is SourceDataValue.IntegerValue -> value.value.toDouble()
                    else -> throw IllegalArgumentException("Expected decimal preview data")
                },
            )
            DataType.StringType -> StringDataValue((value as? SourceDataValue.StringValue).required("string").value)
            DataType.UuidType -> UuidDataValue(
                UUID.fromString((value as? SourceDataValue.StringValue).required("UUID").value),
            )
            DataType.NamespacedKeyType -> NamespacedKeyDataValue(
                ItemKey.parse((value as? SourceDataValue.StringValue).required("namespaced key").value),
            )
            is DataType.ListType -> {
                val source = (value as? SourceDataValue.ListValue).required("list")
                ListDataValue(source.values.map { child -> convert(child, type.element) })
            }
            is DataType.CompoundType -> convertCompound(value, type)
        }
    }

    private fun convertCompound(value: SourceDataValue, type: DataType.CompoundType): CompoundDataValue {
        val source = (value as? SourceDataValue.CompoundValue).required("compound")
        val fields = type.fields
        if (fields == null) {
            return CompoundDataValue(
                source.entries.mapNotNull { (key, child) ->
                    if (child == SourceDataValue.NullValue) null else key to infer(child)
                }.toMap(),
            )
        }
        val fieldsByName = fields.associateBy { it.name }
        val unknown = source.entries.keys - fieldsByName.keys
        require(unknown.isEmpty()) { "Unknown compound preview fields: ${unknown.sorted().joinToString()}" }
        return CompoundDataValue(
            fields.mapNotNull { field ->
                val child = source.entries[field.name]
                if (child == null || child == SourceDataValue.NullValue) {
                    require(field.nullable) { "Required compound preview field ${field.name} is missing" }
                    null
                } else {
                    field.name to convert(child, field.type)
                }
            }.toMap(),
        )
    }

    private fun infer(value: SourceDataValue): ItemDataValue = when (value) {
        SourceDataValue.NullValue -> throw IllegalArgumentException("Lists cannot contain null preview values")
        is SourceDataValue.BooleanValue -> BooleanDataValue(value.value)
        is SourceDataValue.IntegerValue -> if (value.value in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
            IntegerDataValue(value.value.toInt())
        } else {
            LongDataValue(value.value)
        }
        is SourceDataValue.DecimalValue -> DecimalDataValue(value.value.toDouble())
        is SourceDataValue.StringValue -> StringDataValue(value.value)
        is SourceDataValue.ListValue -> ListDataValue(value.values.map(::infer))
        is SourceDataValue.CompoundValue -> CompoundDataValue(
            value.entries.mapNotNull { (key, child) ->
                if (child == SourceDataValue.NullValue) null else key to infer(child)
            }.toMap(),
        )
    }

    private fun <T : Any> T?.required(expected: String): T =
        requireNotNull(this) { "Expected $expected preview data" }
}

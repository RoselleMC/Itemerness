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
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.catalog.CatalogItemDefinition
import com.iroselle.itemerness.core.catalog.DataType
import com.iroselle.itemerness.core.catalog.InstanceDataMutation
import com.iroselle.itemerness.core.catalog.SourceDataValue
import com.iroselle.itemerness.core.presentation.NestedItemPresentation
import com.iroselle.itemerness.core.presentation.PresentationCompiler
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
) {
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
    ) {
        val capabilities: List<String> = java.util.List.copyOf(capabilities)

        fun withSnapshotHash(snapshotHash: String): PreviewContext =
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
            )
    }

    sealed interface Outcome {
        /** A compiled preview. `json` is the artifact the control plane relays to the browser. */
        data class Rendered(val json: String, val compileMillis: Long) : Outcome

        /** A structured refusal. Diagnostics travel as codes and keys, never rendered prose. */
        data class Rejected(val json: String, val compileMillis: Long) : Outcome
    }

    fun compilePreview(documentJson: String, requestContext: PreviewContext): Outcome {
        val started = System.nanoTime()
        val diagnostics = ArrayList<JsonValue>()
        val canonicalDocument = try {
            Json.canonicalize(Json.parse(documentJson))
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
        val actualSnapshotHash = documentDigest(canonicalDocument)
        val context = requestContext.withSnapshotHash(actualSnapshotHash)
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

        val decoded =
            try {
                ProjectDocumentCodec.decode(canonicalDocument, builtinFontMetrics)
            } catch (exception: JsonException) {
                return reject(
                    "DECODE_FAILED",
                    "diagnostics.document.decode_failed",
                    mapOf("detail" to (exception.message ?: "invalid document")),
                    context,
                    diagnostics,
                    started,
                )
            }

        val catalogCompilation = CatalogCompiler().compile(decoded.catalog)
        catalogCompilation.diagnostics.forEach { diagnostic ->
            diagnostics += diagnosticJson(
                code = "CATALOG.${diagnostic.code.name}",
                messageKey = "diagnostics.catalog.${diagnostic.code.name.lowercase()}",
                params = mapOf("path" to diagnostic.path, "detail" to diagnostic.message),
            )
        }
        val catalogCandidate = catalogCompilation.candidate
        if (catalogCandidate == null || catalogCompilation.diagnostics.isNotEmpty()) {
            return reject(
                "DOCUMENT_INVALID",
                "diagnostics.document.catalog_invalid",
                mapOf("diagnosticCount" to catalogCompilation.diagnostics.size.toString()),
                context,
                diagnostics,
                started,
            )
        }
        val domainCatalog = catalogCandidate.materializeValidationView()

        val presentationCompilation =
            PresentationCompiler(decoded.defaultLocale, decoded.budgets).compile(decoded.presentation)
        presentationCompilation.diagnostics.forEach { diagnostic ->
            diagnostics += diagnosticJson(
                code = "PRESENTATION.${diagnostic.code.name}",
                messageKey = "diagnostics.presentation.${diagnostic.code.name.lowercase()}",
                params = mapOf("path" to diagnostic.path, "detail" to diagnostic.message),
            )
        }

        val catalog = presentationCompilation.catalog
            ?: return reject(
                "NO_SAFE_THEME",
                "diagnostics.presentation.compilation_failed",
                emptyMap(),
                context,
                diagnostics,
                started,
            )

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

        val instance = try {
            val created = domainCatalog.createInstance(itemKey)
            val mutations = decoded.previewData[context.itemId].orEmpty().map { assignment ->
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
                    artifactJson(result.display, context, diagnostics, failure = null, compileMillis = elapsed),
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
                "documentSchema" to text("schema-${ProjectDocumentCodec.SUPPORTED_SCHEMA_VERSION}"),
                "capability" to text(capabilityDigest(context)),
                "asset" to (context.metricsRevision?.let(::text) ?: JsonValue.Null),
            ),
            "compileMillis" to num(compileMillis.toDouble()),
            "failure" to (failure ?: JsonValue.Null),
        )
        return Json.canonicalize(artifact)
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

    private fun diagnosticJson(code: String, messageKey: String, params: Map<String, String>): JsonValue =
        obj(
            "code" to text(code),
            "severity" to text("ERROR"),
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
     * build is a different answer, and the control plane needs to be able to tell.
     */
    fun compilerDigest(): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$agentVersion|schema-${ProjectDocumentCodec.SUPPORTED_SCHEMA_VERSION}".toByteArray())
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

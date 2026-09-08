package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.core.catalog.CatalogCompiler
import com.iroselle.itemerness.core.catalog.CatalogDiagnostic
import com.iroselle.itemerness.core.catalog.CatalogSnapshot
import com.iroselle.itemerness.core.presentation.CatalogPresentationValidator
import com.iroselle.itemerness.core.presentation.PresentationBudgets
import com.iroselle.itemerness.core.presentation.PresentationCatalogSnapshot
import com.iroselle.itemerness.core.presentation.PresentationCompiler
import com.iroselle.itemerness.core.presentation.ThemeRenderer
import com.iroselle.itemerness.editor.protocol.BuiltinFontMetrics
import com.iroselle.itemerness.editor.protocol.JsonException
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec

/** One validation path for previews and configuration transfer, including empty catalogs. */
internal class DocumentCompiler(
    private val metrics: BuiltinFontMetrics,
    private val validateRuntime: (ProjectDocumentCodec.Decoded, CatalogSnapshot, PresentationCatalogSnapshot) -> List<CatalogDiagnostic>,
) {
    data class Diagnostic(val code: String, val messageKey: String, val params: Map<String, String>)
    sealed interface Result {
        data class Valid(
            val decoded: ProjectDocumentCodec.Decoded,
            val domain: CatalogSnapshot,
            val presentation: PresentationCatalogSnapshot,
        ) : Result
        data class Invalid(
            val code: String,
            val messageKey: String,
            val params: Map<String, String>,
            val diagnostics: List<Diagnostic> = emptyList(),
        ) : Result
    }

    fun compile(canonicalDocument: String): Result {
        val decoded = try {
            ProjectDocumentCodec.decode(canonicalDocument, metrics)
        } catch (exception: JsonException) {
            return Result.Invalid("DECODE_FAILED", "diagnostics.document.decode_failed", mapOf("detail" to (exception.message ?: "invalid document")))
        }
        if (decoded.budgets != PresentationBudgets()) {
            return Result.Invalid("DOCUMENT_INVALID", "diagnostics.document.runtime_budgets_mismatch", emptyMap())
        }
        val diagnostics = ArrayList<Diagnostic>()
        val requestedClientVersion = decoded.measurementClientVersion
        if (requestedClientVersion != null && requestedClientVersion != "server" && requestedClientVersion != metrics.clientVersion) {
            diagnostics += Diagnostic("CATALOG.INVALID_VALUE", "diagnostics.catalog.invalid_value", mapOf(
                "path" to "measurement.clientVersion",
                "detail" to "Measurement client version $requestedClientVersion does not match the compiler font metrics ${metrics.clientVersion ?: "unknown"}",
            ))
        }
        decoded.presentation.themes.forEach { theme ->
            fun unsupported(field: String, detail: String) {
                diagnostics += Diagnostic("CATALOG.INVALID_VALUE", "diagnostics.catalog.invalid_value", mapOf("path" to "themes.${theme.id}.$field", "detail" to detail))
            }
            if (theme.content != null && theme.renderer != ThemeRenderer.NATIVE_TOOLTIP_STYLE) {
                unsupported("content", "Content area settings are only supported by native-tooltip-style YAML themes")
            }
            if (theme.requireExactFontMetrics && theme.renderer != ThemeRenderer.BITMAP_CANVAS) {
                unsupported("requireExactFontMetrics", "Exact font metrics are only configurable for bitmap-canvas YAML themes")
            }
            if (theme.characterFrame?.fallbackBidirectionalText == false) {
                unsupported("characterFrame.fallbackBidirectionalText", "Character-frame YAML requires bidirectional text fallback")
            }
            if (theme.tooltipStyle != null && theme.renderer !in setOf(ThemeRenderer.NATIVE_TOOLTIP_STYLE, ThemeRenderer.SEGMENTED_FRAME, ThemeRenderer.BITMAP_CANVAS)) {
                unsupported("tooltipStyle", "This YAML renderer does not accept a tooltip style")
            }
        }
        if (diagnostics.isNotEmpty()) return invalid(diagnostics)
        val catalogCompilation = CatalogCompiler().compile(decoded.catalog)
        diagnostics += catalogCompilation.diagnostics.map(::catalogDiagnostic)
        val candidate = catalogCompilation.candidate
        if (candidate == null || diagnostics.isNotEmpty()) return invalid(diagnostics)
        val domain = candidate.materializeValidationView()
        val presentationCompilation = PresentationCompiler(decoded.defaultLocale, decoded.budgets).compile(decoded.presentation)
        diagnostics += presentationCompilation.diagnostics.map { diagnostic ->
            Diagnostic("PRESENTATION.${diagnostic.code.name}", "diagnostics.presentation.${diagnostic.code.name.lowercase()}",
                mapOf("path" to diagnostic.path, "detail" to diagnostic.message))
        }
        val presentation = presentationCompilation.catalog
            ?: return Result.Invalid("NO_SAFE_THEME", "diagnostics.presentation.compilation_failed", emptyMap(), diagnostics)
        diagnostics += (CatalogPresentationValidator.validate(domain, presentation) + validateRuntime(decoded, domain, presentation)).map(::catalogDiagnostic)
        if (diagnostics.isNotEmpty()) return invalid(diagnostics)
        return Result.Valid(decoded, domain, presentation)
    }

    private fun invalid(diagnostics: List<Diagnostic>) = Result.Invalid("DOCUMENT_INVALID", "diagnostics.document.catalog_invalid",
        mapOf("diagnosticCount" to diagnostics.size.toString()), diagnostics)
    private fun catalogDiagnostic(diagnostic: CatalogDiagnostic) = Diagnostic("CATALOG.${diagnostic.code.name}",
        "diagnostics.catalog.${diagnostic.code.name.lowercase()}", mapOf("path" to diagnostic.path, "detail" to diagnostic.message))
}

package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.editor.protocol.JsonValue

/** A sanitized transfer refusal. Configuration contents and credentials are never logged. */
class CatalogTransferException(val code: String, diagnostics: Collection<JsonValue> = emptyList()) : RuntimeException(code) {
    val diagnostics: List<JsonValue> = java.util.List.copyOf(diagnostics)
}

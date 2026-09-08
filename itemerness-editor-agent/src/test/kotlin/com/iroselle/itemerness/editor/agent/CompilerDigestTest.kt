package com.iroselle.itemerness.editor.agent

import com.iroselle.itemerness.editor.protocol.BuiltinFontMetrics
import com.iroselle.itemerness.editor.protocol.ProjectDocumentCodec
import java.security.MessageDigest
import java.util.HexFormat
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

class CompilerDigestTest {
    @Test
    fun `catalog component semantics invalidate earlier compiler artifacts at the same plugin version`() {
        val bridge = CompilerBridge(BuiltinFontMetrics.NONE, "test")
        val prefix = "test|schemas-${ProjectDocumentCodec.SUPPORTED_SCHEMA_VERSIONS.joinToString(",")}|catalog-validation-"
        fun digest(value: String) = "sha256:${HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)),
        )}"

        assertEquals(digest(prefix + "7"), bridge.compilerDigest())
        assertNotEquals(digest(prefix + "6"), bridge.compilerDigest())
    }
}

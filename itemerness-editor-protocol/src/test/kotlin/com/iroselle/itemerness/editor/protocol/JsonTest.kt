package com.iroselle.itemerness.editor.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class JsonTest {
    private fun canonical(text: String) = Json.canonicalize(Json.parse(text))

    @Test
    fun `object keys are sorted by UTF-16 code unit`() {
        assertEquals("""{"A":3,"a":2,"b":1,"ä":4}""", canonical("""{"b":1,"a":2,"A":3,"ä":4}"""))
    }

    @Test
    fun `insertion order does not change the canonical form`() {
        assertEquals(canonical("""{"x":{"p":1,"q":2}}"""), canonical("""{"x":{"q":2,"p":1}}"""))
    }

    @Test
    fun `numbers use the ECMAScript form`() {
        assertEquals("[1,1.5,-8.5,1e+21,1e-7]", canonical("[1.0, 1.5, -8.5, 1e21, 1e-7]"))
    }

    @Test
    fun `duplicate keys are rejected instead of letting the last writer win`() {
        assertThrows(JsonException::class.java) { Json.parse("""{"a":1,"a":2}""") }
    }

    @Test
    fun `malformed documents are rejected`() {
        val invalid = listOf("{", "[1,]", """{"a"}""", "01", "1.", "\"unterminated", "{} trailing", "")
        for (text in invalid) {
            assertThrows(JsonException::class.java, { Json.parse(text) }, "expected <$text> to be rejected")
        }
    }

    @Test
    fun `control characters keep the shortest escape RFC 8785 requires`() {
        // Newline and tab take their two-character escapes; anything else below U+0020 takes
        // a lowercase \\u00xx form. Getting either wrong changes the hash of any document
        // whose text contains one.
        val text = "line\u000Abreak\u0009tab\u0001control"
        val parsed = Json.parse(Json.canonicalize(JsonValue.Text(text)))
        assertEquals("\"line\\nbreak\\ttab\\u0001control\"", Json.canonicalize(JsonValue.Text(text)))
        assertEquals(text, (parsed as JsonValue.Text).value)
    }

    @Test
    fun `strict accessors reject unknown keys and wrong types`() {
        val node = JsonObject.parse("""{"a":1,"b":"x"}""")
        assertThrows(JsonException::class.java) { node.rejectUnknown("a") }
        assertThrows(JsonException::class.java) { node.requiredString("a") }
        assertThrows(JsonException::class.java) { node.requiredInt("b") }
        assertThrows(JsonException::class.java) { node.requiredString("missing") }
        assertEquals(1, node.requiredInt("a"))
        assertEquals("x", node.requiredString("b"))
    }

    @Test
    fun `explicit nulls read as absent so optional fields round-trip`() {
        val node = JsonObject.parse("""{"a":null}""")
        assertNull(node.optionalString("a"))
        assertThrows(JsonException::class.java) { node.requiredString("a") }
    }

    @Test
    fun `nesting beyond the limit is rejected`() {
        val depth = JsonLimits.MAXIMUM_DEPTH + 2
        assertThrows(JsonException::class.java) { Json.parse("[".repeat(depth) + "]".repeat(depth)) }
    }
}

package com.iroselle.itemerness.editor.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

/**
 * `Double.toString` already produces the shortest round-tripping digits on this JVM; what differs
 * from JavaScript is the layout. These are the cases where the two disagree, and every one of them
 * would silently change a document's canonical hash and break the snapshot fence.
 */
class EcmaScriptNumbersTest {
    @Test
    fun `integral values drop the fraction Java would print`() {
        assertEquals("1", EcmaScriptNumbers.toString(1.0))
        assertEquals("0", EcmaScriptNumbers.toString(0.0))
        assertEquals("220", EcmaScriptNumbers.toString(220.0))
        assertEquals("-8", EcmaScriptNumbers.toString(-8.0))
        assertEquals("100", EcmaScriptNumbers.toString(100.0))
    }

    @Test
    fun `negative zero collapses so two documents cannot differ only by sign`() {
        assertEquals("0", EcmaScriptNumbers.toString(-0.0))
    }

    @Test
    fun `fractions keep their shortest form`() {
        assertEquals("1.5", EcmaScriptNumbers.toString(1.5))
        assertEquals("-8.5", EcmaScriptNumbers.toString(-8.5))
        assertEquals("0.5", EcmaScriptNumbers.toString(0.5))
        assertEquals("0.0625", EcmaScriptNumbers.toString(0.0625))
        assertEquals("38.5", EcmaScriptNumbers.toString(38.5))
    }

    @Test
    fun `small magnitudes stay decimal down to 1e-6`() {
        assertEquals("0.000001", EcmaScriptNumbers.toString(1e-6))
        assertEquals("1e-7", EcmaScriptNumbers.toString(1e-7))
    }

    @Test
    fun `large magnitudes switch to the JavaScript exponent form`() {
        assertEquals("1e+21", EcmaScriptNumbers.toString(1e21))
        assertEquals("1e+22", EcmaScriptNumbers.toString(1e22))
        assertEquals("100000000000000000000", EcmaScriptNumbers.toString(1e20))
        assertEquals("1.2345e+25", EcmaScriptNumbers.toString(1.2345e25))
    }

    @Test
    fun `non-finite values are rejected rather than serialized`() {
        assertThrows(JsonException::class.java) { EcmaScriptNumbers.toString(Double.NaN) }
        assertThrows(JsonException::class.java) { EcmaScriptNumbers.toString(Double.POSITIVE_INFINITY) }
    }
}

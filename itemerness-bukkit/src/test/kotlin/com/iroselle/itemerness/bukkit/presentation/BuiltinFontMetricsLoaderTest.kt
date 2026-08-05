package com.iroselle.itemerness.bukkit.presentation

import com.iroselle.itemerness.bukkit.config.StrictYamlException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

class BuiltinFontMetricsLoaderTest {
    @Test
    fun `bundled artifact exposes exact vanilla default and non-JP uniform metrics`() {
        val artifact = BuiltinFontMetricsLoader.bundled()
        val classic = artifact.tablesByRevision.getValue("builtin:minecraft-default-26.1.2")
        val uniform = artifact.tablesByRevision.getValue("builtin:minecraft-uniform-26.1.2")

        assertEquals("26.1.2", artifact.clientVersion)
        assertEquals("4e618f09a0c649dde3fdf829df443ce0b8831e65", artifact.clientSha1)
        assertEquals("3391216608325aaf428712b211476abf6d5ddffa", artifact.assetIndexSha1)
        assertEquals("38547c6fabdfd5adc0d2227c4dfc6cf54713fbfa", artifact.sourceSha1)
        assertEquals(2_414, classic.glyphs.size)
        assertEquals(114_432, uniform.glyphs.size)
        assertEquals("minecraft:uniform", classic.fallback)
        assertNull(uniform.fallback)

        assertMetric(classic.glyphs.getValue('i'.code), 2.0, 1.0, true, 0.0, 1.0, -7.0, 0.0)
        assertMetric(classic.glyphs.getValue('W'.code), 6.0, 1.0, true, 0.0, 5.0, -7.0, 0.0)
        assertMetric(classic.glyphs.getValue(' '.code), 4.0, 1.0, false, 0.0, 0.0, 0.0, 0.0)
        assertMetric(uniform.glyphs.getValue('中'.code), 9.0, 0.5, true, 1.0, 6.5, -7.0, 1.0)
        assertMetric(uniform.glyphs.getValue('i'.code), 3.0, 0.5, true, 0.0, 2.5, -5.5, 0.0)
        assertFalse(classic.glyphs.containsKey('中'.code), "default must reach unifont through provider-order fallback")
        assertFalse(uniform.glyphs.containsKey(0x10FFFF))
        assertMetric(uniform.fallbackGlyph, 6.0, 1.0, true, 0.0, 5.0, -7.0, 1.0)
    }

    @Test
    fun `missing artifact fails validation`() {
        val exception = assertThrows(StrictYamlException::class.java) {
            BuiltinFontMetricsLoader.loadBundled { null }
        }

        assertTrue(exception.message.orEmpty().contains("Missing bundled font metrics artifact"))
    }

    @Test
    fun `payload corruption fails integrity validation`() {
        val corrupted = resourceBytes()
        corrupted[corrupted.lastIndex] = (corrupted.last().toInt() xor 0x01).toByte()

        val exception = assertThrows(StrictYamlException::class.java) {
            BuiltinFontMetricsLoader.read(ByteArrayInputStream(corrupted))
        }

        assertTrue(exception.message.orEmpty().contains("payload integrity"))
    }

    @Test
    fun `client version mismatch fails before metrics are accepted`() {
        val mismatched = resourceBytes()
        val marker = "26.1.2".toByteArray()
        val offset = mismatched.indexOfSlice(marker)
        assertTrue(offset >= 0)
        mismatched[offset + marker.lastIndex] = '3'.code.toByte()

        val exception = assertThrows(StrictYamlException::class.java) {
            BuiltinFontMetricsLoader.read(ByteArrayInputStream(mismatched))
        }

        assertTrue(exception.message.orEmpty().contains("client version"))
    }

    @Test
    fun `source provenance mismatch fails before metrics are accepted`() {
        val mismatched = resourceBytes()
        val expected = "38547c6fabdfd5adc0d2227c4dfc6cf54713fbfa".chunked(2)
            .map { it.toInt(16).toByte() }
            .toByteArray()
        val offset = mismatched.indexOfSlice(expected)
        assertTrue(offset >= 0)
        mismatched[offset] = (mismatched[offset].toInt() xor 0x01).toByte()

        val exception = assertThrows(StrictYamlException::class.java) {
            BuiltinFontMetricsLoader.read(ByteArrayInputStream(mismatched))
        }

        assertTrue(exception.message.orEmpty().contains("source SHA-1"))
    }

    @Test
    fun `artifact read failure is reported as a configuration error`() {
        val failing = object : InputStream() {
            override fun read(): Int = throw IOException("simulated resource failure")
        }

        val exception = assertThrows(StrictYamlException::class.java) {
            BuiltinFontMetricsLoader.read(failing)
        }

        assertTrue(exception.message.orEmpty().contains("simulated resource failure"))
        assertTrue(exception.cause is IOException)
    }

    private fun resourceBytes(): ByteArray = checkNotNull(
        javaClass.classLoader.getResourceAsStream(BuiltinFontMetricsLoader.RESOURCE_PATH),
    ).use(InputStream::readAllBytes)

    private fun ByteArray.indexOfSlice(needle: ByteArray): Int {
        if (needle.isEmpty()) return 0
        for (index in 0..size - needle.size) {
            if (needle.indices.all { offset -> this[index + offset] == needle[offset] }) return index
        }
        return -1
    }

    private fun assertMetric(
        metric: com.iroselle.itemerness.core.presentation.GlyphMetricSource,
        advance: Double,
        bold: Double,
        hasInk: Boolean,
        left: Double,
        right: Double,
        top: Double,
        bottom: Double,
    ) {
        assertEquals(advance, metric.advancePixels)
        assertEquals(bold, metric.boldExtraAdvancePixels)
        assertEquals(hasInk, metric.hasInk)
        assertEquals(left, metric.visualBounds.left)
        assertEquals(right, metric.visualBounds.right)
        assertEquals(top, metric.visualBounds.top)
        assertEquals(bottom, metric.visualBounds.bottom)
    }
}

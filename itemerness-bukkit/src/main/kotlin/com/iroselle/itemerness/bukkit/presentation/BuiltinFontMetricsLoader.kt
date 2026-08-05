package com.iroselle.itemerness.bukkit.presentation

import com.iroselle.itemerness.bukkit.config.StrictYamlException
import com.iroselle.itemerness.core.presentation.GlyphMetricSource
import com.iroselle.itemerness.core.presentation.VisualBoundsSource
import java.io.InputStream
import java.security.MessageDigest
import java.util.Collections
import java.util.HexFormat
import java.util.LinkedHashMap

internal data class BuiltinFontMetricsTable(
    val fontId: String,
    val metricsRevision: String,
    val fallback: String?,
    val fallbackGlyph: GlyphMetricSource,
    val glyphs: Map<Int, GlyphMetricSource>,
)

internal class BuiltinFontMetricsArtifact internal constructor(
    val clientVersion: String,
    val clientSha1: String,
    val assetIndexSha1: String,
    val sourceSha1: String,
    tables: Collection<BuiltinFontMetricsTable>,
) {
    val tablesByRevision: Map<String, BuiltinFontMetricsTable> = Collections.unmodifiableMap(
        tables.associateByTo(LinkedHashMap(), BuiltinFontMetricsTable::metricsRevision),
    )
}

/** Reads the generated vanilla metrics artifact without loading Minecraft client classes. */
internal object BuiltinFontMetricsLoader {
    const val RESOURCE_PATH = "META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm"

    private val bundledArtifact: BuiltinFontMetricsArtifact by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        loadBundled { path -> BuiltinFontMetricsLoader::class.java.classLoader.getResourceAsStream(path) }
    }

    fun bundled(): BuiltinFontMetricsArtifact = bundledArtifact

    internal fun loadBundled(
        resource: (String) -> InputStream?,
    ): BuiltinFontMetricsArtifact {
        val input = resource(RESOURCE_PATH)
            ?: throw StrictYamlException("Missing bundled font metrics artifact $RESOURCE_PATH")
        return input.use(::read)
    }

    internal fun read(input: InputStream): BuiltinFontMetricsArtifact {
        return try {
            val bytes = input.readNBytes(MAX_ARTIFACT_BYTES + 1)
            if (bytes.size > MAX_ARTIFACT_BYTES) {
                throw StrictYamlException("Bundled font metrics artifact exceeds the size limit")
            }
            decode(bytes)
        } catch (exception: StrictYamlException) {
            throw exception
        } catch (exception: Exception) {
            throw StrictYamlException("Invalid bundled font metrics artifact: ${exception.message}", exception)
        }
    }

    private fun decode(bytes: ByteArray): BuiltinFontMetricsArtifact {
        val cursor = ByteCursor(bytes, "font metrics header")
        if (!cursor.bytes(MAGIC.size).contentEquals(MAGIC)) {
            invalid("magic does not match")
        }
        val schema = cursor.unsignedShort()
        if (schema != ARTIFACT_SCHEMA) invalid("unsupported schema $schema")
        val clientVersion = cursor.string()
        if (clientVersion != EXPECTED_CLIENT_VERSION) {
            invalid("client version $clientVersion does not match $EXPECTED_CLIENT_VERSION")
        }
        val clientSha1 = HexFormat.of().formatHex(cursor.bytes(SHA1_BYTES))
        if (clientSha1 != EXPECTED_CLIENT_SHA1) invalid("client SHA-1 does not match")
        val assetIndexSha1 = HexFormat.of().formatHex(cursor.bytes(SHA1_BYTES))
        if (assetIndexSha1 != EXPECTED_ASSET_INDEX_SHA1) invalid("asset index SHA-1 does not match")
        val sourceSha1 = HexFormat.of().formatHex(cursor.bytes(SHA1_BYTES))
        if (sourceSha1 != EXPECTED_SOURCE_SHA1) invalid("source SHA-1 does not match")
        val payloadLength = cursor.unsignedInt()
        if (payloadLength > MAX_PAYLOAD_BYTES || payloadLength != cursor.remaining - SHA256_BYTES) {
            invalid("payload length is invalid")
        }
        val expectedPayloadSha256 = cursor.bytes(SHA256_BYTES)
        val payload = cursor.bytes(payloadLength)
        cursor.requireExhausted()
        val actualPayloadSha256 = digest("SHA-256", payload)
        if (!MessageDigest.isEqual(expectedPayloadSha256, actualPayloadSha256)) {
            invalid("payload integrity check failed")
        }
        val artifactSha256 = HexFormat.of().formatHex(digest("SHA-256", bytes))
        if (artifactSha256 != EXPECTED_ARTIFACT_SHA256) {
            invalid("artifact integrity check failed")
        }

        val payloadCursor = ByteCursor(payload, "font metrics payload")
        val tableCount = payloadCursor.unsignedByte()
        if (tableCount != EXPECTED_TABLES.size) invalid("font table count is invalid")
        val tables = ArrayList<BuiltinFontMetricsTable>(tableCount)
        repeat(tableCount) {
            val fontId = payloadCursor.string()
            val revision = payloadCursor.string()
            val fallback = payloadCursor.optionalString()
            val fallbackGlyph = payloadCursor.metric()
            val glyphCount = payloadCursor.unsignedInt()
            if (glyphCount > MAX_GLYPHS_PER_TABLE) invalid("glyph count for $revision is invalid")
            val capacity = ((glyphCount / 0.75f).toInt() + 1).coerceAtLeast(16)
            val glyphs = LinkedHashMap<Int, GlyphMetricSource>(capacity)
            var previousCodePoint = -1
            repeat(glyphCount) {
                val delta = payloadCursor.positiveVarUInt()
                val codePoint = previousCodePoint.toLong() + delta
                if (codePoint > Character.MAX_CODE_POINT ||
                    codePoint in Character.MIN_SURROGATE.code.toLong()..Character.MAX_SURROGATE.code.toLong()
                ) {
                    invalid("invalid code point in $revision")
                }
                val scalar = codePoint.toInt()
                glyphs[scalar] = payloadCursor.metric()
                previousCodePoint = scalar
            }
            tables += BuiltinFontMetricsTable(
                fontId = fontId,
                metricsRevision = revision,
                fallback = fallback,
                fallbackGlyph = fallbackGlyph,
                glyphs = Collections.unmodifiableMap(glyphs),
            )
        }
        payloadCursor.requireExhausted()
        validateTables(tables)
        return BuiltinFontMetricsArtifact(clientVersion, clientSha1, assetIndexSha1, sourceSha1, tables)
    }

    private fun validateTables(tables: List<BuiltinFontMetricsTable>) {
        val actual = tables.associateBy(BuiltinFontMetricsTable::metricsRevision)
        if (actual.keys != EXPECTED_TABLES.keys) invalid("font metric revisions do not match")
        EXPECTED_TABLES.forEach { (revision, expectation) ->
            val table = requireNotNull(actual[revision])
            if (table.fontId != expectation.fontId || table.fallback != expectation.fallback) {
                invalid("font table topology for $revision does not match")
            }
            if (table.glyphs.isEmpty()) invalid("font table $revision is empty")
        }
    }

    private fun ByteCursor.metric(): GlyphMetricSource {
        val advance = unsignedByte() / HALF_PIXEL_SCALE
        val bold = unsignedByte() / HALF_PIXEL_SCALE
        val left = signedByte() / HALF_PIXEL_SCALE
        val right = signedByte() / HALF_PIXEL_SCALE
        val top = signedByte() / HALF_PIXEL_SCALE
        val bottom = signedByte() / HALF_PIXEL_SCALE
        val flags = unsignedByte()
        if (flags and HAS_INK_FLAG.inv() != 0) invalid("glyph flags are invalid")
        val hasInk = flags and HAS_INK_FLAG != 0
        if (hasInk) {
            if (right < left || bottom < top) invalid("glyph bounds are invalid")
        } else if (left != 0.0 || right != 0.0 || top != 0.0 || bottom != 0.0) {
            invalid("inkless glyph has non-empty bounds")
        }
        return GlyphMetricSource(
            advancePixels = advance,
            visualBounds = VisualBoundsSource(left, right, top, bottom),
            boldExtraAdvancePixels = bold,
            hasInk = hasInk,
        )
    }

    private fun invalid(detail: String): Nothing =
        throw StrictYamlException("Invalid bundled font metrics artifact: $detail")

    private fun digest(algorithm: String, bytes: ByteArray): ByteArray =
        MessageDigest.getInstance(algorithm).digest(bytes)

    private data class TableExpectation(
        val fontId: String,
        val fallback: String?,
    )

    private const val ARTIFACT_SCHEMA = 1
    private const val EXPECTED_CLIENT_VERSION = "26.1.2"
    private const val EXPECTED_CLIENT_SHA1 = "4e618f09a0c649dde3fdf829df443ce0b8831e65"
    private const val EXPECTED_ASSET_INDEX_SHA1 = "3391216608325aaf428712b211476abf6d5ddffa"
    private const val EXPECTED_SOURCE_SHA1 = "38547c6fabdfd5adc0d2227c4dfc6cf54713fbfa"
    private const val EXPECTED_ARTIFACT_SHA256 = "c978141c91f21f40083cc4420388de0a763cef303a058142db410d35a46b8604"
    private const val SHA1_BYTES = 20
    private const val SHA256_BYTES = 32
    private const val MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
    private const val MAX_PAYLOAD_BYTES = 3 * 1024 * 1024
    private const val MAX_GLYPHS_PER_TABLE = 1_200_000
    private const val HAS_INK_FLAG = 1
    private const val HALF_PIXEL_SCALE = 2.0
    private val MAGIC = byteArrayOf(0x49, 0x54, 0x4D, 0x46, 0x4F, 0x4E, 0x54, 0x00)
    private val EXPECTED_TABLES = linkedMapOf(
        "builtin:minecraft-default-26.1.2" to TableExpectation("minecraft:default", "minecraft:uniform"),
        "builtin:minecraft-uniform-26.1.2" to TableExpectation("minecraft:uniform", null),
    )
}

private class ByteCursor(
    private val source: ByteArray,
    private val label: String,
) {
    private var position = 0
    val remaining: Int get() = source.size - position

    fun unsignedByte(): Int {
        requireRemaining(1)
        return source[position++].toInt() and 0xFF
    }

    fun signedByte(): Int {
        requireRemaining(1)
        return source[position++].toInt()
    }

    fun unsignedShort(): Int = (unsignedByte() shl 8) or unsignedByte()

    fun unsignedInt(): Int {
        val value = (unsignedByte().toLong() shl 24) or
            (unsignedByte().toLong() shl 16) or
            (unsignedByte().toLong() shl 8) or
            unsignedByte().toLong()
        if (value > Int.MAX_VALUE) invalid("unsigned integer exceeds the supported range")
        return value.toInt()
    }

    fun positiveVarUInt(): Long {
        var value = 0L
        var shift = 0
        repeat(5) {
            val byte = unsignedByte()
            value = value or ((byte and 0x7F).toLong() shl shift)
            if (byte and 0x80 == 0) {
                if (value <= 0) invalid("code-point delta is not positive")
                return value
            }
            shift += 7
        }
        invalid("code-point delta is too long")
    }

    fun string(): String {
        val length = unsignedByte()
        if (length == 0) invalid("required string is empty")
        return decodeUtf8(bytes(length))
    }

    fun optionalString(): String? {
        val length = unsignedByte()
        return if (length == 0) null else decodeUtf8(bytes(length))
    }

    fun bytes(length: Int): ByteArray {
        if (length < 0) invalid("negative byte length")
        requireRemaining(length)
        val result = source.copyOfRange(position, position + length)
        position += length
        return result
    }

    fun requireExhausted() {
        if (remaining != 0) invalid("contains $remaining trailing bytes")
    }

    private fun decodeUtf8(bytes: ByteArray): String {
        val decoded = bytes.toString(Charsets.UTF_8)
        if (!decoded.toByteArray(Charsets.UTF_8).contentEquals(bytes)) invalid("contains invalid UTF-8")
        return decoded
    }

    private fun requireRemaining(length: Int) {
        if (remaining < length) invalid("is truncated")
    }

    private fun invalid(detail: String): Nothing =
        throw StrictYamlException("Invalid bundled font metrics artifact: $label $detail")
}

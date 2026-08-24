package com.iroselle.itemerness.bukkit.config

import com.iroselle.itemerness.api.ItemKey
import java.net.URI
import java.net.URISyntaxException
import java.nio.file.Path

internal data class EditorEndpoint(
    val url: String,
    /** Never logged, never written to an artifact, never returned by a diagnostic. */
    val token: String,
) {
    override fun toString(): String = "EditorEndpoint(url=$url, token=<redacted>)"
}

internal data class ItemernessSettings(
    val defaultNamespace: String,
    val pendingNameTemplate: String,
    val pendingNameColor: String,
    val defaultLocale: String,
    val defaultLayout: ItemKey,
    val defaultTheme: ItemKey,
    val editor: EditorEndpoint?,
) {
    val pendingNameColorRgb: Int
        get() = NAMED_COLORS.getValue(pendingNameColor)

    fun pendingName(itemKey: ItemKey): String =
        pendingNameTemplate.replace(ITEM_ID_TOKEN, itemKey.toString())

    companion object {
        private const val EXPECTED_CONFIG_VERSION = 3
        private const val ITEM_ID_TOKEN = "{item-id}"
        private val LOCALE_PATTERN = Regex("[a-z0-9]{2,16}(?:_[a-z0-9]{2,16})?")
        private val ENVIRONMENT_REFERENCE = Regex("\\$\\{([A-Z_][A-Z0-9_]*)}")
        private val NAMED_COLORS = mapOf(
            "black" to 0x000000,
            "dark_blue" to 0x0000AA,
            "dark_green" to 0x00AA00,
            "dark_aqua" to 0x00AAAA,
            "dark_red" to 0xAA0000,
            "dark_purple" to 0xAA00AA,
            "gold" to 0xFFAA00,
            "gray" to 0xAAAAAA,
            "dark_gray" to 0x555555,
            "blue" to 0x5555FF,
            "green" to 0x55FF55,
            "aqua" to 0x55FFFF,
            "red" to 0xFF5555,
            "light_purple" to 0xFF55FF,
            "yellow" to 0xFFFF55,
            "white" to 0xFFFFFF,
        )

        /**
         * Reads `${'$'}{ENV_NAME}` indirection so a token never has to sit in a file an operator might
         * commit or attach to a bug report.
         */
        private fun resolveSecret(value: String, key: String, source: String): String {
            val match = ENVIRONMENT_REFERENCE.matchEntire(value.trim()) ?: return value.trim()
            val name = match.groupValues[1]
            return System.getenv(name)
                ?: throw StrictYamlException("$key in $source references environment variable $name, which is not set")
        }

        fun load(path: Path): ItemernessSettings = from(StrictYaml.load(path), path.toString())

        fun from(
            document: Map<String, Any?>,
            source: String,
        ): ItemernessSettings {
            val root = YamlObject.root(document, source).rejectUnknown(
                "config-version",
                "catalog",
                "editor",
                "canonical-item",
                "locale",
                "presentation",
            )
            val version = root.requiredInt("config-version")
            if (version != EXPECTED_CONFIG_VERSION) {
                throw StrictYamlException(
                    "Unsupported config-version $version in $source; expected $EXPECTED_CONFIG_VERSION",
                )
            }

            val catalog = root.requiredObject("catalog").rejectUnknown("default-namespace")
            val namespace = catalog.requiredString("default-namespace")
            try {
                ItemKey(namespace, "validation")
            } catch (exception: IllegalArgumentException) {
                throw StrictYamlException("Invalid default namespace '$namespace' in $source", exception)
            }

            val editorNode = root.requiredObject("editor").rejectUnknown("url", "token")
            val editorUrl = resolveSecret(editorNode.requiredString("url"), "editor.url", source)
            val editorToken = resolveSecret(editorNode.requiredString("token"), "editor.token", source)
            // Half a pairing is a configuration mistake, not a quiet fallback to local mode: an
            // operator who filled in one field expected the editor to be connected.
            if (editorUrl.isEmpty() != editorToken.isEmpty()) {
                throw StrictYamlException(
                    "editor.url and editor.token in $source must both be set or both be empty",
                )
            }
            val editor = if (editorUrl.isEmpty()) {
                null
            } else {
                parseEditorEndpoint(editorUrl, editorToken, source)
            }

            val canonical = root.requiredObject("canonical-item").rejectUnknown("pending-name")
            val pending = canonical.requiredObject("pending-name").rejectUnknown("text", "color")
            val pendingTemplate = pending.requiredString("text")
            if (pendingTemplate.countToken(ITEM_ID_TOKEN) != 1) {
                throw StrictYamlException(
                    "canonical-item.pending-name.text in $source must contain $ITEM_ID_TOKEN exactly once",
                )
            }
            val pendingColor = pending.requiredString("color")
            if (pendingColor !in NAMED_COLORS) {
                throw StrictYamlException(
                    "canonical-item.pending-name.color in $source is not a supported named color: $pendingColor",
                )
            }

            val locale = root.requiredObject("locale").rejectUnknown("default")
            val defaultLocale = locale.requiredString("default")
            if (!LOCALE_PATTERN.matches(defaultLocale)) {
                throw StrictYamlException("Invalid default locale '$defaultLocale' in $source")
            }

            val presentation = root.requiredObject("presentation")
                .rejectUnknown("default-layout", "default-theme")
            val defaultLayout = parseItemKey(
                presentation.requiredString("default-layout"),
                "presentation.default-layout",
                source,
            )
            val defaultTheme = parseItemKey(
                presentation.requiredString("default-theme"),
                "presentation.default-theme",
                source,
            )

            return ItemernessSettings(
                defaultNamespace = namespace,
                pendingNameTemplate = pendingTemplate,
                pendingNameColor = pendingColor,
                defaultLocale = defaultLocale,
                defaultLayout = defaultLayout,
                defaultTheme = defaultTheme,
                editor = editor,
            )
        }

        private fun parseItemKey(
            value: String,
            path: String,
            source: String,
        ): ItemKey = try {
            ItemKey.parse(value)
        } catch (exception: IllegalArgumentException) {
            throw StrictYamlException("Invalid $path '$value' in $source", exception)
        }

        private fun parseEditorEndpoint(
            value: String,
            token: String,
            source: String,
        ): EditorEndpoint {
            val normalized = value.trimEnd('/')
            val uri = try {
                URI(normalized)
            } catch (exception: URISyntaxException) {
                throw StrictYamlException("Invalid editor.url in $source", exception)
            }
            val host = uri.host?.removeSurrounding("[", "]")
                ?: throw StrictYamlException("editor.url in $source must include a host")
            val loopbackHttp = uri.scheme.equals("http", ignoreCase = true) &&
                host.lowercase() in setOf("localhost", "127.0.0.1", "::1")
            if (!uri.scheme.equals("https", ignoreCase = true) && !loopbackHttp) {
                throw StrictYamlException(
                    "editor.url in $source must use https except for an explicit loopback host",
                )
            }
            if (uri.userInfo != null || uri.query != null || uri.fragment != null) {
                throw StrictYamlException(
                    "editor.url in $source must not contain user info, a query, or a fragment",
                )
            }
            return EditorEndpoint(normalized, token)
        }

        private fun String.countToken(token: String): Int {
            var count = 0
            var offset = 0
            while (true) {
                val index = indexOf(token, offset)
                if (index < 0) return count
                count += 1
                offset = index + token.length
            }
        }
    }
}

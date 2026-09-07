package com.iroselle.itemerness.bukkit.config

import com.iroselle.itemerness.api.ItemKey
import java.net.URI
import java.nio.file.Path

internal data class EditorEndpoint(
    val bindHost: String,
    val port: Int,
    /** Never logged, never written to an artifact, never returned by a diagnostic. */
    val token: String,
    val allowedOrigins: List<String> = emptyList(),
) {
    override fun toString(): String = "EditorEndpoint(bindHost=$bindHost, port=$port, token=<redacted>)"
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

            val editor = parseEditorEndpoint(root.requiredObject("editor"), source)

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
            node: YamlObject,
            source: String,
        ): EditorEndpoint? {
            // Existing local-only installations continue to boot, but an outbound pairing must
            // never silently turn into an inbound listener with different security semantics.
            if (node.contains("url")) {
                node.rejectUnknown("url", "token")
                if (node.requiredString("url").isBlank() && node.requiredString("token").isBlank()) return null
                throw StrictYamlException("editor.url is retired in $source; migrate to editor.enabled, bind-host, port, token and allowed-origins")
            }
            node.rejectUnknown("enabled", "bind-host", "port", "token", "allowed-origins")
            val enabled = node.requiredBoolean("enabled")
            val host = node.requiredString("bind-host")
            if (host.isBlank() || host.length > 253 || !Regex("[A-Za-z0-9.:-]+").matches(host)) {
                throw StrictYamlException("Invalid editor.bind-host in $source")
            }
            val port = node.requiredInt("port")
            if (port !in 1024..65535) throw StrictYamlException("editor.port in $source must be between 1024 and 65535")
            val tokenValue = node.requiredString("token")
            val token = if (enabled) resolveSecret(tokenValue, "editor.token", source) else ""
            if (enabled && token.isNotEmpty() && !Regex("[A-Za-z0-9_~+/.=-]{32,256}").matches(token)) {
                throw StrictYamlException("editor.token in $source must be empty or a random token of 32 to 256 ASCII token characters")
            }
            val origins = node.requiredList("allowed-origins").map { value ->
                val origin = value as? String ?: throw StrictYamlException("editor.allowed-origins in $source must contain strings")
                val uri = runCatching { URI(origin) }.getOrNull()
                if (uri == null || uri.host == null || uri.scheme !in setOf("http", "https") ||
                    !uri.rawPath.isNullOrEmpty() || uri.rawQuery != null || uri.rawFragment != null || uri.rawUserInfo != null
                ) throw StrictYamlException("editor.allowed-origins in $source must contain exact HTTP origins without paths")
                origin
            }
            if (origins.size > 16) throw StrictYamlException("Too many editor.allowed-origins in $source")
            return if (enabled) EditorEndpoint(host, port, token, java.util.List.copyOf(origins)) else null
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

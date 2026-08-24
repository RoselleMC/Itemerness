package com.iroselle.itemerness.editor.protocol

/**
 * The agent wire envelope.
 *
 * Every message carries the fields that make a reply attributable to a request and a request
 * attributable to a live connection: a request id, the connection generation it was issued under,
 * a monotonic sequence, and an optional deadline. Without the generation, a reply from a superseded
 * connection could still mutate state after a reconnect; without the deadline, a slow compile keeps
 * changing a preview nobody is looking at any more.
 */
data class AgentEnvelope(
    val protocolVersion: Int,
    val kind: Kind,
    val method: String,
    val requestId: String,
    val serverId: String,
    val connectionGeneration: Long,
    val sequence: Long,
    val deadline: String?,
    val traceId: String?,
    val contentHash: String?,
    val payload: JsonValue,
) {
    enum class Kind {
        REQUEST,
        RESPONSE,
        EVENT,
        ;

        val wire: String get() = name.lowercase()

        companion object {
            fun of(value: String): Kind =
                entries.firstOrNull { it.wire == value }
                    ?: throw JsonException("Unknown envelope kind \"$value\"")
        }
    }

    fun encode(): String =
        Json.canonicalize(
            JsonValue.Obj(
                linkedMapOf(
                    "protocolVersion" to JsonValue.Num(protocolVersion.toDouble()),
                    "kind" to JsonValue.Text(kind.wire),
                    "method" to JsonValue.Text(method),
                    "requestId" to JsonValue.Text(requestId),
                    "serverId" to JsonValue.Text(serverId),
                    "connectionGeneration" to JsonValue.Num(connectionGeneration.toDouble()),
                    "sequence" to JsonValue.Num(sequence.toDouble()),
                    "deadline" to (deadline?.let(JsonValue::Text) ?: JsonValue.Null),
                    "traceId" to (traceId?.let(JsonValue::Text) ?: JsonValue.Null),
                    "contentHash" to (contentHash?.let(JsonValue::Text) ?: JsonValue.Null),
                    "payload" to payload,
                ),
            ),
        )

    companion object {
        const val PROTOCOL_VERSION: Int = 1

        /** Control-plane requests this build accepts after the handshake. */
        val SUPPORTED_METHODS: Set<String> =
            setOf("preview.compile")

        /**
         * There is deliberately no method that runs a console command, invokes arbitrary Bukkit
         * API, or uploads code. A project editor who can preview an item must not thereby gain
         * arbitrary RPC against a Minecraft server.
         */
        fun decode(text: String): AgentEnvelope {
            val root = JsonObject.parse(text, "envelope").rejectUnknown(
                "protocolVersion", "kind", "method", "requestId", "serverId", "connectionGeneration",
                "sequence", "deadline", "traceId", "contentHash", "payload",
            )
            return AgentEnvelope(
                protocolVersion = root.requiredInt("protocolVersion"),
                kind = Kind.of(root.requiredString("kind")),
                method = root.requiredString("method"),
                requestId = root.requiredString("requestId"),
                serverId = root.optionalString("serverId") ?: "",
                connectionGeneration = root.optionalDouble("connectionGeneration")?.toLong() ?: 0L,
                sequence = root.optionalDouble("sequence")?.toLong() ?: 0L,
                deadline = root.optionalString("deadline"),
                traceId = root.optionalString("traceId"),
                contentHash = root.optionalString("contentHash"),
                payload = root.raw("payload") ?: JsonValue.Obj(emptyMap()),
            )
        }
    }
}

/** A structured refusal. Prose is never sent; the browser renders `messageKey` in its own language. */
data class AgentError(
    val code: String,
    val messageKey: String,
    val params: Map<String, String> = emptyMap(),
) {
    fun toJson(): JsonValue =
        JsonValue.Obj(
            linkedMapOf(
                "code" to JsonValue.Text(code),
                "messageKey" to JsonValue.Text(messageKey),
                "params" to JsonValue.Obj(params.mapValues { JsonValue.Text(it.value) as JsonValue }),
            ),
        )

    companion object {
        fun unsupportedMethod(method: String): AgentError =
            AgentError("PROTOCOL.UNSUPPORTED_METHOD", "diagnostics.agent.unsupported_method", mapOf("method" to method))

        fun unsupportedProtocol(version: Int): AgentError =
            AgentError(
                "PROTOCOL.UNSUPPORTED_VERSION",
                "diagnostics.agent.unsupported_version",
                mapOf("version" to version.toString()),
            )

        fun staleGeneration(): AgentError =
            AgentError("PROTOCOL.STALE_GENERATION", "diagnostics.agent.stale_generation")

        fun deadlineExceeded(): AgentError =
            AgentError("PROTOCOL.DEADLINE_EXCEEDED", "diagnostics.agent.deadline_exceeded")

        fun overloaded(): AgentError = AgentError("PROTOCOL.OVERLOADED", "diagnostics.agent.overloaded")

        fun internal(detail: String): AgentError =
            AgentError("PROTOCOL.INTERNAL", "diagnostics.agent.internal", mapOf("detail" to detail))
    }
}

/** Builds a response envelope for a request, carrying the request's correlation fields back. */
fun AgentEnvelope.respond(
    result: JsonValue?,
    error: AgentError? = null,
    sequence: Long,
): AgentEnvelope =
    AgentEnvelope(
        protocolVersion = AgentEnvelope.PROTOCOL_VERSION,
        kind = AgentEnvelope.Kind.RESPONSE,
        method = method,
        requestId = requestId,
        serverId = serverId,
        connectionGeneration = connectionGeneration,
        sequence = sequence,
        deadline = null,
        traceId = traceId,
        contentHash = null,
        payload = JsonValue.Obj(
            linkedMapOf(
                "ok" to JsonValue.Bool(error == null),
                "error" to (error?.toJson() ?: JsonValue.Null),
                "result" to (result ?: JsonValue.Null),
            ),
        ),
    )

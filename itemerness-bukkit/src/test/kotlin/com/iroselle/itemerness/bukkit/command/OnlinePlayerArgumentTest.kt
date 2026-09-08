package com.iroselle.itemerness.bukkit.command

import com.mojang.brigadier.CommandDispatcher
import com.mojang.brigadier.LiteralMessage
import com.mojang.brigadier.StringReader
import com.mojang.brigadier.arguments.ArgumentType
import com.mojang.brigadier.context.CommandContext
import com.mojang.brigadier.exceptions.CommandSyntaxException
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType
import com.mojang.brigadier.suggestion.Suggestions
import com.mojang.brigadier.suggestion.SuggestionsBuilder
import io.papermc.paper.command.brigadier.argument.resolvers.selector.PlayerSelectorArgumentResolver
import java.util.concurrent.CompletableFuture
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class OnlinePlayerArgumentTest {
    @Test
    fun `bare Unicode extends one token without changing input or following arguments`() {
        listOf("夏咕咕", "Élodie", "Name名字_2", "名字-Test.1+2").forEach { name ->
            val input = "give $name example:item 2"
            val reader = StringReader(input).also { it.cursor = 5 }
            val native = ReadingArgument()

            assertSame(RESOLVER, OnlinePlayerArgument(native).parse(reader))

            assertEquals(name, native.name)
            assertEquals(input, native.reader!!.string)
            assertNotSame(reader, native.reader)
            assertEquals(5 + name.length, reader.cursor)
            assertEquals(" example:item 2", reader.remaining)
        }
    }

    @Test
    fun `ASCII UUID selectors quotes and restricted ASCII keep the untouched native reader`() {
        val inputs = listOf(
            "Player_2 example:item",
            "123e4567-e89b-12d3-a456-426614174000 example:item",
            "@p example:item",
            "@a[name=\"夏咕咕\",limit=1] example:item",
            "\"夏\\\"咕\\\\咕\" example:item",
            "'夏咕咕' example:item",
            "名字/name example:item",
            "名字:name example:item",
            "名字@name example:item",
            "名字\"name example:item",
        )
        inputs.forEach { input ->
            val reader = StringReader(input)
            val native = ReadingArgument()
            OnlinePlayerArgument(native).parse(reader)
            assertSame(reader, native.reader, input)
        }
    }

    @Test
    fun `quoted escaping remains native and Unicode does not consume whitespace`() {
        val quoted = ReadingArgument()
        OnlinePlayerArgument(quoted).parse(StringReader("\"夏\\\"咕\\\\咕\" item"))
        assertEquals("夏\"咕\\咕", quoted.name)

        listOf(' ', '\t', '\n', '\u3000').forEach { separator ->
            val reader = StringReader("名字${separator}item")
            val native = ReadingArgument()
            OnlinePlayerArgument(native).parse(reader)
            assertEquals("名字", native.name)
            assertEquals("${separator}item", reader.remaining)
        }
    }

    @Test
    fun `source aware native parsing is preserved`() {
        val source = Any()
        val native = ReadingArgument()
        val reader = StringReader("夏咕咕 item")
        assertSame(RESOLVER, OnlinePlayerArgument(native).parse(reader, source))
        assertSame(source, native.source)
        assertEquals(0, native.contextFreeCalls)
        assertEquals(1, native.sourceCalls)
    }

    @Test
    fun `native validation errors preserve original input cursor and rewind`() {
        listOf("名字".repeat(9), "@p[bad=名字]", "123e4567-e89b-12d3-invalid!").forEach { name ->
            val input = "give $name item"
            val reader = StringReader(input).also { it.cursor = 5 }
            val failureType = SimpleCommandExceptionType(LiteralMessage("native failure"))
            val native = object : ArgumentType<PlayerSelectorArgumentResolver> {
                override fun parse(reader: StringReader): PlayerSelectorArgumentResolver {
                    reader.readString()
                    reader.cursor = 5
                    throw failureType.createWithContext(reader)
                }
            }

            val failure = assertThrows(CommandSyntaxException::class.java) {
                OnlinePlayerArgument(native).parse(reader)
            }

            assertSame(failureType, failure.type)
            assertEquals(input, failure.input)
            assertEquals(5, failure.cursor)
            assertEquals(5, reader.cursor)
        }
    }

    @Test
    fun `native client grammar and suggestion future are retained`() {
        val source = Any()
        val context = CommandDispatcher<Any>().parse("", source).context.build("")
        val builder = SuggestionsBuilder("give 名", 5)
        val suggestions = builder.suggest("名字").suggest("@p").buildFuture()
        val native = object : ArgumentType<PlayerSelectorArgumentResolver> {
            override fun parse(reader: StringReader) = RESOLVER

            override fun <S> listSuggestions(
                context: CommandContext<S>,
                builder: SuggestionsBuilder,
            ): CompletableFuture<Suggestions> {
                assertSame(source, context.source)
                assertEquals(5, builder.start)
                return suggestions
            }
        }
        val argument = OnlinePlayerArgument(native)

        assertSame(native, argument.getNativeType())
        assertSame(suggestions, argument.listSuggestions(context, builder))
        // A vanilla client still parses the advertised native grammar, not this server extension.
        assertEquals("", StringReader("名字").readString())
        assertEquals("名字", StringReader("\"名字\"").readString())
    }

    private class ReadingArgument : ArgumentType<PlayerSelectorArgumentResolver> {
        var reader: StringReader? = null
        var name: String? = null
        var source: Any? = null
        var contextFreeCalls = 0
        var sourceCalls = 0

        override fun parse(reader: StringReader): PlayerSelectorArgumentResolver {
            contextFreeCalls++
            return read(reader)
        }

        override fun <S> parse(reader: StringReader, source: S): PlayerSelectorArgumentResolver {
            sourceCalls++
            this.source = source
            return read(reader)
        }

        private fun read(reader: StringReader): PlayerSelectorArgumentResolver {
            this.reader = reader
            name = reader.readString()
            return RESOLVER
        }
    }

    private companion object {
        val RESOLVER = PlayerSelectorArgumentResolver { emptyList() }
    }
}

package com.iroselle.itemerness.bukkit.command

import com.mojang.brigadier.StringReader
import com.mojang.brigadier.arguments.ArgumentType
import com.mojang.brigadier.context.CommandContext
import com.mojang.brigadier.suggestion.Suggestions
import com.mojang.brigadier.suggestion.SuggestionsBuilder
import io.papermc.paper.command.brigadier.argument.CustomArgumentType
import io.papermc.paper.command.brigadier.argument.resolvers.selector.PlayerSelectorArgumentResolver
import java.util.concurrent.CompletableFuture

/**
 * Extends only the native player's unquoted name token. Native validation, selector permissions,
 * and online resolution remain authoritative; this argument never reads another player's state.
 * The client still receives the native grammar, so quoted Unicode names remain its portable form.
 */
internal class OnlinePlayerArgument(
    private val delegate: ArgumentType<PlayerSelectorArgumentResolver>,
) : CustomArgumentType<PlayerSelectorArgumentResolver, PlayerSelectorArgumentResolver> {
    override fun getNativeType(): ArgumentType<PlayerSelectorArgumentResolver> = delegate

    override fun parse(reader: StringReader): PlayerSelectorArgumentResolver =
        withNameReader(reader, delegate::parse)

    override fun <S : Any> parse(reader: StringReader, source: S): PlayerSelectorArgumentResolver =
        withNameReader(reader) { delegate.parse(it, source) }

    override fun <S : Any> listSuggestions(
        context: CommandContext<S>,
        builder: SuggestionsBuilder,
    ): CompletableFuture<Suggestions> = delegate.listSuggestions(context, builder)

    private inline fun withNameReader(
        reader: StringReader,
        parse: (StringReader) -> PlayerSelectorArgumentResolver,
    ): PlayerSelectorArgumentResolver {
        val start = reader.cursor
        var end = start
        var unicode = false
        while (end < reader.totalLength && !reader.string[end].isWhitespace()) {
            val character = reader.string[end]
            if (!StringReader.isAllowedInUnquotedString(character) && character.code <= 0x7f) {
                return parse(reader)
            }
            unicode = unicode || character.code > 0x7f
            end++
        }
        if (!unicode) return parse(reader)

        // Keep the original input and offsets, including native exceptions and cursor rewinds.
        val nameReader = object : StringReader(reader) {
            override fun readString(): String {
                if (cursor != start) return super.readString()
                cursor = end
                return string.substring(start, end)
            }
        }
        return try {
            parse(nameReader)
        } finally {
            reader.cursor = nameReader.cursor
        }
    }
}

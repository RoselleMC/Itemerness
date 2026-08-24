package com.iroselle.itemerness.nms.v26_1_1

import com.iroselle.itemerness.projection.RenderedText
import net.minecraft.network.chat.Component
import net.minecraft.network.chat.FontDescription
import net.minecraft.network.chat.Style
import net.minecraft.resources.Identifier

internal object NmsRenderedText {
    fun convert(source: RenderedText): Component {
        val result = Component.empty()
        source.runs.forEach { run ->
            var style = Style.EMPTY
                .withBold(run.decorations.bold)
                .withItalic(run.decorations.italic)
                .withUnderlined(run.decorations.underlined)
                .withStrikethrough(run.decorations.strikethrough)
                .withObfuscated(run.decorations.obfuscated)
            run.color?.let { color -> style = style.withColor(color.value) }
            run.font?.let { font ->
                style = style.withFont(
                    FontDescription.Resource(
                        Identifier.fromNamespaceAndPath(font.namespace, font.value),
                    ),
                )
            }
            result.append(Component.literal(run.text).setStyle(style))
        }
        return result
    }
}

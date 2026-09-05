package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import kotlin.math.ceil
import kotlin.math.max

/** Text-component geometry shared by the currently supported vanilla clients. */
internal object VanillaTooltipGeometry {
    const val TEXT_COMPONENT_HEIGHT_PIXELS = 10
    private const val SINGLE_COMPONENT_REDUCTION_PIXELS = 2
    private const val FIRST_COMPONENT_GAP_PIXELS = 2

    fun measuredHeight(componentCount: Int): Int {
        require(componentCount >= 0) { "Tooltip component count cannot be negative" }
        return when (componentCount) {
            0 -> 0
            1 -> TEXT_COMPONENT_HEIGHT_PIXELS - SINGLE_COMPONENT_REDUCTION_PIXELS
            else -> componentCount * TEXT_COMPONENT_HEIGHT_PIXELS
        }
    }

    fun componentY(index: Int): Int {
        require(index >= 0) { "Tooltip component index cannot be negative" }
        return index * TEXT_COMPONENT_HEIGHT_PIXELS + if (index == 0) 0 else FIRST_COMPONENT_GAP_PIXELS
    }
}

/** Pure renderer. It never retains Bukkit objects or invokes external callbacks. */
class PresentationEngine(private val catalog: PresentationCatalogSnapshot) {
    /** Formats one schema-approved value with the same locale and formatter rules as rendering. */
    fun formatValue(
        value: ItemDataValue,
        format: ItemKey?,
        locale: String,
    ): Result<String> = ValueFormatter(catalog, MessageResolver(catalog, locale)).format(value, format)

    /** Resolves a catalog-owned item name without invoking nested render callbacks. */
    fun itemDisplayName(
        itemKey: ItemKey,
        locale: String,
    ): Result<String> = runCatching {
        val item = requireNotNull(catalog.items[itemKey]) { "Unknown presentation item $itemKey" }
        requireNotNull(MessageResolver(catalog, locale).resolve(item.nameMessage)) {
            "Missing item name message ${item.nameMessage}"
        }
    }

    fun render(request: PresentationRenderRequest): PresentationRenderResult {
        val item = catalog.items[request.itemKey]
            ?: return rejected(PresentationRenderFailureCode.UNKNOWN_ITEM, "Unknown item presentation ${request.itemKey}")
        val messages = MessageResolver(catalog, request.viewer.locale)
        val formatter = ValueFormatter(catalog, messages)
        val semantic = try {
            resolveSemantic(item, request, messages, formatter)
        } catch (exception: RuntimePresentationException) {
            return rejected(exception.code, exception.message)
        }
        val requestedTheme = request.viewer.requestedTheme ?: item.theme
        if (requestedTheme !in catalog.themes) {
            return rejected(PresentationRenderFailureCode.NO_SAFE_THEME, "Unknown requested theme $requestedTheme")
        }
        val fallbacks = ArrayList<ThemeFallbackReason>()
        var theme: CompiledTheme? = catalog.themes[requestedTheme]
        val visited = HashSet<ItemKey>()
        while (theme != null && visited.add(theme.id)) {
            val current = theme
            val capabilityFailure = capabilityFailure(current, request.viewer)
            if (capabilityFailure != null) {
                fallbacks += capabilityFailure
                theme = current.fallback?.let(catalog.themes::get)
                continue
            }
            try {
                val display = ThemeRendererEngine(catalog, current, request.viewer).render(
                    item = item,
                    semantic = semantic,
                    requestedTheme = requestedTheme,
                    fallbackReasons = fallbacks,
                )
                return PresentationRenderResult.Rendered(display)
            } catch (exception: TextLayoutException) {
                fallbacks += ThemeFallbackReason(current.id, exception.fallbackCode, exception.message)
                theme = current.fallback?.let(catalog.themes::get)
            } catch (exception: RuntimeException) {
                fallbacks += ThemeFallbackReason(
                    current.id,
                    ThemeFallbackCode.RENDER_FAILURE,
                    exception.message ?: exception::class.simpleName.orEmpty(),
                )
                theme = current.fallback?.let(catalog.themes::get)
            }
        }
        return rejected(
            PresentationRenderFailureCode.NO_SAFE_THEME,
            "No safe theme could render ${request.itemKey}: ${fallbacks.joinToString { "${it.theme}:${it.code}" }}",
        )
    }

    private fun capabilityFailure(theme: CompiledTheme, viewer: PresentationViewer): ThemeFallbackReason? {
        if (theme.source.requiresResourcePack && !viewer.resourcePackLoaded) {
            return ThemeFallbackReason(theme.id, ThemeFallbackCode.RESOURCE_PACK_UNAVAILABLE, "The resource pack is not loaded")
        }
        val effectiveCapabilities = if (viewer.assetProfile == null) {
            viewer.capabilities
        } else {
            val profile = catalog.assetProfiles[viewer.assetProfile]
                ?: return ThemeFallbackReason(theme.id, ThemeFallbackCode.CAPABILITY_MISSING, "Unknown asset profile ${viewer.assetProfile}")
            viewer.capabilities.intersect(profile.capabilities)
        }
        val missing = theme.requiredCapabilities - effectiveCapabilities
        if (missing.isNotEmpty()) {
            return ThemeFallbackReason(theme.id, ThemeFallbackCode.CAPABILITY_MISSING, "Missing capabilities: ${missing.joinToString()}")
        }
        if (theme.source.requireExactFontMetrics) {
            val profile = viewer.assetProfile?.let(catalog.assetProfiles::get)
            if (profile?.metricsRevision == null || profile.metricsRevision != viewer.metricsRevision) {
                return ThemeFallbackReason(theme.id, ThemeFallbackCode.METRICS_MISMATCH, "The asset and font metrics revisions do not match")
            }
        }
        if (theme.source.vanillaTooltipLines == VanillaTooltipLinePolicy.REQUIRE_MANAGED && !viewer.managesVanillaTooltipLines) {
            return ThemeFallbackReason(theme.id, ThemeFallbackCode.UNMANAGED_TOOLTIP_LINES, "The item has unmanaged vanilla tooltip lines")
        }
        if (theme.source.renderer == ThemeRenderer.VANILLA_CHARACTER_FRAME &&
            viewer.direction != TextDirection.LEFT_TO_RIGHT &&
            theme.source.characterFrame?.fallbackBidirectionalText == true
        ) {
            return ThemeFallbackReason(theme.id, ThemeFallbackCode.UNSUPPORTED_DIRECTION, "Character frames require a left-to-right baseline")
        }
        return null
    }

    private fun resolveSemantic(
        item: CompiledItemPresentation,
        request: PresentationRenderRequest,
        messages: MessageResolver,
        formatter: ValueFormatter,
    ): ResolvedPresentation {
        val name = messages.resolve(item.nameMessage)
            ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${item.nameMessage}")
        val blocks = ArrayList<SemanticBlock>()
        resolveBlocks(item.blocks, request, messages, formatter, blocks, depth = 1)
        val codePoints = name.codePointCount(0, name.length) + blocks.sumOf { block ->
            block.runs.sumOf { run -> run.text.codePointCount(0, run.text.length) }
        }
        if (codePoints > catalog.budgets.maximumTextCodePoints) {
            throw RuntimePresentationException(
                PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED,
                "Resolved presentation exceeds ${catalog.budgets.maximumTextCodePoints} code points",
            )
        }
        return ResolvedPresentation(name, blocks)
    }

    private fun resolveBlocks(
        sources: List<CompiledPresentationBlock>,
        request: PresentationRenderRequest,
        messages: MessageResolver,
        formatter: ValueFormatter,
        output: MutableList<SemanticBlock>,
        depth: Int,
    ) {
        if (depth > catalog.budgets.maximumBlockDepth) {
            throw RuntimePresentationException(PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED, "Runtime block nesting exceeded")
        }
        sources.forEach { block ->
            if (output.size >= catalog.budgets.maximumBlocksPerItem) {
                throw RuntimePresentationException(PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED, "Runtime block count exceeded")
            }
            when (block) {
                is CompiledPresentationBlock.Text -> {
                    val value = request.data[block.data]
                    if (value == null) {
                        if (block.missingPolicy == MissingDataPolicy.OMIT) return@forEach
                        throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_DATA, "Missing data ${block.data}")
                    }
                    val text = formatter.format(value).getOrElse {
                        throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, it.message ?: "Formatting failed")
                    }
                    output += SemanticBlock(
                        listOf(SemanticRun(text, block.style ?: "value", unbreakable = block.unbreakable)),
                        block.anchor,
                        block.wrapping,
                        output.isNotEmpty(),
                        SemanticBlockKind.GENERIC,
                    )
                }

                is CompiledPresentationBlock.Field -> {
                    val value = request.data[block.data]
                    if (value == null) {
                        if (block.missingPolicy == MissingDataPolicy.OMIT) return@forEach
                        throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_DATA, "Missing data ${block.data}")
                    }
                    val label = messages.resolve(block.labelMessage)
                        ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${block.labelMessage}")
                    val formatted = formatter.format(value, block.format).getOrElse {
                        throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, it.message ?: "Formatting failed")
                    }
                    val role = block.style
                    val runs = buildList {
                        block.icon?.let { add(SemanticRun("", role ?: "value", PresentationRunKind.ICON, true, it)) }
                        add(SemanticRun(label, role ?: "label", unbreakable = true))
                        add(SemanticRun(": ", role ?: "label", unbreakable = true))
                        add(SemanticRun(formatted, role ?: "value", fieldValue = true))
                    }
                    output += SemanticBlock(
                        runs,
                        block.anchor,
                        block.wrapping,
                        output.isNotEmpty(),
                        SemanticBlockKind.FIELD,
                    )
                }

                is CompiledPresentationBlock.Description -> {
                    val text = messages.resolve(block.message)
                        ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${block.message}")
                    output += SemanticBlock(
                        listOf(SemanticRun(text, block.style ?: "description")),
                        block.anchor,
                        block.wrapping,
                        output.isNotEmpty(),
                        SemanticBlockKind.DESCRIPTION,
                    )
                }

                is CompiledPresentationBlock.Conditional -> {
                    val selected = if (evaluate(block.condition, request)) block.thenBlocks else block.otherwiseBlocks
                    resolveBlocks(selected, request, messages, formatter, output, depth + 1)
                }

                is CompiledPresentationBlock.Repeat -> {
                    val value = request.data[block.data]
                    if (value == null) {
                        if (block.missingPolicy == MissingDataPolicy.OMIT) return@forEach
                        throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_DATA, "Missing data ${block.data}")
                    }
                    val list = (value as? ListDataValue)?.values
                        ?: throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, "Repeat data ${block.data} is not a list")
                    if (list.size > block.maximumElements || list.size > catalog.budgets.maximumRepeatElements) {
                        throw RuntimePresentationException(PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED, "Repeat data ${block.data} exceeds its maximum")
                    }
                    list.forEach { value ->
                        val compound = value as? CompoundDataValue
                            ?: throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, "Repeat element is not a compound")
                        val nested = lookupCompound(compound, block.template.valuePath)
                        val formatted = if (nested == null) {
                            messages.resolve(block.template.missingMessage)
                                ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${block.template.missingMessage}")
                        } else {
                            formatter.format(nested, block.template.format).getOrElse {
                                throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, it.message ?: "Formatting failed")
                            }
                        }
                        val label = messages.resolve(block.template.labelMessage)
                            ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${block.template.labelMessage}")
                        output += SemanticBlock(
                            buildList {
                                block.template.icon?.let { add(SemanticRun("", block.style ?: "value", PresentationRunKind.ICON, true, it)) }
                                add(SemanticRun(label, block.style ?: "label", unbreakable = true))
                                add(SemanticRun(": ", block.style ?: "label", unbreakable = true))
                                add(SemanticRun(formatted, block.style ?: "value", fieldValue = true))
                            },
                            block.anchor,
                            null,
                            output.isNotEmpty(),
                            SemanticBlockKind.FIELD,
                        )
                    }
                }

                is CompiledPresentationBlock.NestedItemList -> {
                    if (request.nestedItems.size > catalog.budgets.maximumRepeatElements) {
                        throw RuntimePresentationException(
                            PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED,
                            "Nested item list exceeds ${catalog.budgets.maximumRepeatElements} elements",
                        )
                    }
                    request.nestedItems.forEach { nested ->
                        output += SemanticBlock(
                            listOf(
                                SemanticRun("• ", block.style ?: "label", unbreakable = true),
                                SemanticRun(nested.displayName, block.style ?: "value"),
                                SemanticRun(" ×${nested.amount}", block.style ?: "value", unbreakable = true),
                            ),
                            block.anchor,
                            null,
                            output.isNotEmpty(),
                            SemanticBlockKind.GENERIC,
                        )
                    }
                }
            }
        }
    }

    private fun evaluate(condition: CompiledCondition, request: PresentationRenderRequest): Boolean {
        val left = resolveReference(condition.left, request)
        if (condition.operator == ConditionOperator.EXISTS) return left != null
        val right = condition.right?.let { resolveReference(it, request) }
        return when (condition.operator) {
            ConditionOperator.EQUALS -> left == right
            ConditionOperator.NOT_EQUALS -> left != right
            ConditionOperator.LESS_THAN -> comparePresentationValues(left, right)?.let { it < 0 } ?: false
            ConditionOperator.LESS_THAN_OR_EQUAL -> comparePresentationValues(left, right)?.let { it <= 0 } ?: false
            ConditionOperator.GREATER_THAN -> comparePresentationValues(left, right)?.let { it > 0 } ?: false
            ConditionOperator.GREATER_THAN_OR_EQUAL -> comparePresentationValues(left, right)?.let { it >= 0 } ?: false
            ConditionOperator.EXISTS -> left != null
        }
    }

    private fun resolveReference(reference: CompiledValueReference, request: PresentationRenderRequest): ItemDataValue? = when (reference) {
        is CompiledValueReference.Data -> request.data[reference.key]
        is CompiledValueReference.Fact -> {
            val definition = requireNotNull(catalog.viewerFacts[reference.key]) { "Unknown viewer fact ${reference.key}" }
            val value = request.viewer.facts[reference.key] ?: definition.defaultValue
            if (value != null && !matchesFactType(definition.type, value)) {
                throw RuntimePresentationException(
                    PresentationRenderFailureCode.INVALID_RUNTIME_VALUE,
                    "Viewer fact ${reference.key} does not match ${definition.type}",
                )
            }
            value
        }
        is CompiledValueReference.Literal -> reference.value
    }

    private fun lookupCompound(value: CompoundDataValue, path: String): ItemDataValue? {
        var current: ItemDataValue = value
        path.split('.').forEach { part ->
            current = (current as? CompoundDataValue)?.entries?.get(part) ?: return null
        }
        return current
    }

    private fun matchesFactType(type: ViewerFactType, value: ItemDataValue): Boolean = when (type) {
        ViewerFactType.LOCALE, ViewerFactType.STRING -> value is StringDataValue
        ViewerFactType.BOOLEAN -> value is BooleanDataValue
        ViewerFactType.INTEGER -> value is IntegerDataValue
        ViewerFactType.LONG -> value is LongDataValue
        ViewerFactType.DECIMAL -> value is DecimalDataValue
        ViewerFactType.UUID -> value is UuidDataValue
        ViewerFactType.NAMESPACED_KEY -> value is NamespacedKeyDataValue
    }

    private fun rejected(code: PresentationRenderFailureCode, message: String): PresentationRenderResult.Rejected =
        PresentationRenderResult.Rejected(PresentationRenderFailure(code, message))
}

private data class ResolvedPresentation(
    val name: String,
    val blocks: List<SemanticBlock>,
)

private class RuntimePresentationException(
    val code: PresentationRenderFailureCode,
    override val message: String,
) : RuntimeException(message)

private class ThemeRendererEngine(
    private val catalog: PresentationCatalogSnapshot,
    private val theme: CompiledTheme,
    private val viewer: PresentationViewer,
) {
    private val measurer = PixelMeasurer(catalog)
    private val layouter = PixelTextLayouter(measurer)

    fun render(
        item: CompiledItemPresentation,
        semantic: ResolvedPresentation,
        requestedTheme: ItemKey,
        fallbackReasons: List<ThemeFallbackReason>,
    ): PresentationDisplay {
        val layout = requireNotNull(catalog.layouts[item.layout])
        val nameStyle = style("item-name", theme.fonts.getValue("text"))
        val maximumWidth = effectiveMaximumWidth(layout)
        var name = layouter.ellipsizeLine(
            listOf(PresentationTextRun(semantic.name, nameStyle, unbreakable = true)),
            maximumWidth,
        )
        val styledBlocks = semantic.blocks.map(::styleBlock)
        val lore = when (theme.source.renderer) {
            ThemeRenderer.PLAIN, ThemeRenderer.NATIVE_TOOLTIP_STYLE -> {
                val flow = renderFlow(layout, styledBlocks, maximumWidth)
                val anchored = anchorFlowWidth(name, flow.lines, flow.targetWidth, maximumWidth)
                name = anchored.name
                anchored.lines
            }
            ThemeRenderer.VANILLA_CHARACTER_FRAME -> renderCharacterFrame(layout, styledBlocks)
            ThemeRenderer.SEGMENTED_FRAME -> {
                val framed = renderSegmentedFrame(layout, styledBlocks, name)
                name = framed.name
                framed.lines
            }
            ThemeRenderer.BITMAP_CANVAS -> renderCanvas(layout, styledBlocks)
        }
        validateOutput(name, lore)
        return PresentationDisplay(
            displayName = name,
            lore = lore,
            // A segmented frame paints its own panel, so like a canvas it needs its tooltip style
            // honoured — that style is what blanks vanilla's background out from under it.
            tooltipStyle = if (
                theme.source.renderer in setOf(
                    ThemeRenderer.NATIVE_TOOLTIP_STYLE,
                    ThemeRenderer.SEGMENTED_FRAME,
                    ThemeRenderer.BITMAP_CANVAS,
                )
            ) theme.tooltipStyle else null,
            renderer = theme.source.renderer,
            selectedTheme = theme.id,
            requestedTheme = requestedTheme,
            catalogRevision = catalog.revision,
            fallbackReasons = fallbackReasons,
        )
    }

    private fun effectiveMaximumWidth(layout: CompiledLayout): Int {
        var maximum = when (layout) {
            is CompiledLayout.Flow -> layout.source.maximumWidthPixels
            is CompiledLayout.Canvas -> layout.source.maximumWidthPixels
        }
        theme.source.content?.let { maximum = minOf(maximum, it.maximumWidthPixels) }
        theme.source.characterFrame?.let { maximum = minOf(maximum, it.maximumWidthPixels) }
        theme.source.segmentedFrame?.let { maximum = minOf(maximum, it.maximumWidthPixels) }
        theme.source.canvas?.let { maximum = minOf(maximum, it.maximumWidthPixels) }
        return minOf(maximum, catalog.budgets.maximumWidthPixels)
    }

    private fun styleBlock(block: SemanticBlock): StyledBlock {
        val split = splitExplicitLines(block.runs)
        return StyledBlock(
            lines = split.map { runs -> StyledLine(runs.flatMap(::styleRuns)) },
            anchor = block.anchor,
            wrapping = block.wrapping,
            sectionBoundaryBefore = block.sectionBoundaryBefore,
            kind = block.kind,
        )
    }

    private fun styleRuns(run: SemanticRun): List<StyledRun> {
        if (run.assetId != null) {
            if (!viewer.resourcePackLoaded) return emptyList()
            val glyph = requireNotNull(catalog.glyphs[run.assetId]) { "Unknown glyph ${run.assetId}" }
            return listOf(
                StyledRun(
                    PresentationTextRun(
                        text = String(Character.toChars(glyph.codePoint)),
                        style = style(run.role, glyph.font).copy(bold = false, italic = false),
                        kind = run.kind,
                        unbreakable = true,
                    ),
                    role = run.role,
                    assetId = run.assetId,
                    fieldValue = run.fieldValue,
                ),
            )
        }
        val textStyle = style(run.role, theme.fonts.getValue("text"))
        return chunkForSerialization(run.text).map { chunk ->
            StyledRun(
                PresentationTextRun(chunk, textStyle, run.kind, run.unbreakable),
                role = run.role,
                fieldValue = run.fieldValue,
            )
        }
    }

    private fun style(role: String, font: ItemKey): PresentationTextStyle {
        val source = theme.source.styles[role]
        return PresentationTextStyle(
            color = parseColor(source?.color ?: defaultColor(role)),
            font = font,
            bold = source?.bold ?: false,
            italic = source?.italic ?: false,
            underlined = source?.underlined ?: false,
            strikethrough = source?.strikethrough ?: false,
        )
    }

    private fun renderFlow(layout: CompiledLayout, blocks: List<StyledBlock>, maximumWidth: Int): FlowResult {
        val flow = (layout as? CompiledLayout.Flow)?.source
        val content = theme.source.content
        val minimumWidth = max(
            flow?.minimumWidthPixels ?: 1,
            content?.minimumWidthPixels ?: 1,
        )
        val themeLeft = content?.leftPaddingPixels ?: 0
        val themeRight = content?.rightPaddingPixels ?: 0
        val targetWidth = blocks.maxOfOrNull { block ->
            val sectionLeft = when {
                flow == null -> 0
                block.lines.firstOrNull()?.runs?.any { it.kind == PresentationRunKind.ICON } == true -> flow.fieldLeftPaddingPixels
                block.kind == SemanticBlockKind.DESCRIPTION -> flow.descriptionLeftPaddingPixels
                else -> flow.fieldLeftPaddingPixels
            }
            val sectionRight = if (flow != null && block.kind == SemanticBlockKind.DESCRIPTION) {
                flow.descriptionRightPaddingPixels
            } else {
                0
            }
            block.lines.maxOfOrNull { line ->
                val withIconGap = addIconGap(line.values, flow)
                measurer.measure(withIconGap.map(StyledRun::run)).logicalWidthPixels +
                    themeLeft + themeRight + sectionLeft + sectionRight
            } ?: 0
        }?.coerceIn(minimumWidth, maximumWidth) ?: minimumWidth.coerceAtMost(maximumWidth)
        val rendered = ArrayList<PresentationLine>()
        val boundaries = LinkedHashSet<Int>()
        blocks.forEachIndexed { blockIndex, block ->
            if (block.sectionBoundaryBefore && rendered.isNotEmpty()) boundaries += rendered.size
            if (flow != null && block.kind == SemanticBlockKind.DESCRIPTION && rendered.isNotEmpty()) {
                appendVerticalGap(rendered, flow.descriptionGapBeforePixels)
            }
            val policy = wrappingPolicy(layout, block.wrapping)
            val sectionLeft = when {
                flow == null -> 0
                block.lines.firstOrNull()?.runs?.any { it.kind == PresentationRunKind.ICON } == true -> flow.fieldLeftPaddingPixels
                block.kind == SemanticBlockKind.DESCRIPTION -> flow.descriptionLeftPaddingPixels
                else -> flow.fieldLeftPaddingPixels
            }
            val sectionRight = if (flow != null && block.kind == SemanticBlockKind.DESCRIPTION) {
                flow.descriptionRightPaddingPixels
            } else {
                0
            }
            val left = themeLeft + sectionLeft
            val right = themeRight + sectionRight
            val available = minOf(policy.widthPixels ?: targetWidth, targetWidth) - left - right
            if (available <= 0) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Section padding consumes its width")
            val logicalLines = if (policy.preserveExplicitLines) block.lines else listOf(joinExplicitLines(block.lines))
            var emittedForBlock = 0
            logicalLines.forEach { explicitLine ->
                val withIconGap = addIconGap(explicitLine.values, flow)
                val aligned = if (flow?.fieldValueAlignment == FieldValueAlignment.RIGHT && block.kind == SemanticBlockKind.FIELD) {
                    alignFieldValue(withIconGap, available)
                } else {
                    withIconGap.map(StyledRun::run)
                }
                val remainingLines = policy.maximumLines - emittedForBlock
                if (remainingLines <= 0) {
                    throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Block exceeds ${policy.maximumLines} lines")
                }
                val wrapped = layouter.wrap(
                    aligned,
                    available,
                    remainingLines,
                    policy.overflow,
                    preserveExplicitLines = false,
                    continuationIndentPixels = policy.continuationIndentPixels,
                )
                rendered += wrapped.mapIndexed { index, line ->
                    val continuation = if (index > 0) policy.continuationIndentPixels else 0
                    appendRightPadding(indentLine(line, left + continuation), right)
                }
                emittedForBlock += wrapped.size
            }
            if (flow != null && blockIndex < blocks.lastIndex) {
                appendVerticalGap(rendered, flow.blockGapAfterPixels)
            }
        }
        if (rendered.size > catalog.budgets.maximumLines) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Lore exceeds ${catalog.budgets.maximumLines} lines")
        }
        val natural = rendered.maxOfOrNull(PresentationLine::logicalWidthPixels) ?: 0
        return FlowResult(rendered, boundaries, max(targetWidth, natural).coerceIn(minimumWidth, maximumWidth))
    }

    private fun anchorFlowWidth(
        name: PresentationLine,
        lines: List<PresentationLine>,
        targetWidth: Int,
        maximumWidth: Int,
    ): AnchoredFlow {
        val widestLineIndex = lines.indices.maxByOrNull { lines[it].logicalWidthPixels }
        val widestLore = widestLineIndex?.let(lines::get)
        val anchorName = widestLore == null || name.logicalWidthPixels >= widestLore.logicalWidthPixels
        val anchor = if (anchorName) name else requireNotNull(widestLore)
        if (anchor.logicalWidthPixels >= targetWidth) return AnchoredFlow(name, lines)

        val deficit = targetWidth - anchor.logicalWidthPixels
        val textStyle = (anchor.runs.lastOrNull()?.style ?: style("value", theme.fonts.getValue("text")))
            .copy(bold = false, italic = false, underlined = false, strikethrough = false)
        val widthAnchor = exactWidthAnchorRuns(deficit, textStyle)
        val measured = measurer.measure(anchor.runs + widthAnchor)
        if (measured.logicalWidthPixels != targetWidth || measured.logicalWidthPixels > maximumWidth) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Flow width anchor did not produce its target width")
        }
        if (anchorName) return AnchoredFlow(measured, lines)
        return AnchoredFlow(name, lines.toMutableList().also { it[requireNotNull(widestLineIndex)] = measured })
    }

    private fun exactWidthAnchorRuns(pixels: Int, textStyle: PresentationTextStyle): List<PresentationTextRun> {
        return exactInvisibleAdvanceRuns(pixels, textStyle, PresentationRunKind.WIDTH_ANCHOR)
    }

    private fun exactSpacingRuns(pixels: Int, textStyle: PresentationTextStyle): List<PresentationTextRun> {
        return exactInvisibleAdvanceRuns(pixels, textStyle, PresentationRunKind.SPACING)
    }

    private fun exactInvisibleAdvanceRuns(
        pixels: Int,
        textStyle: PresentationTextStyle,
        kind: PresentationRunKind,
    ): List<PresentationTextRun> {
        if (pixels <= 0) return emptyList()
        if (viewer.resourcePackLoaded && catalog.spacing != null) {
            return spacingRuns(pixels, kind)
        }
        val fallbackKind = if (kind == PresentationRunKind.SPACING) PresentationRunKind.TEXT else kind

        // The supported clients give bold U+200C an exact one-pixel advance while the
        // glyph remains inkless. This lets resource-pack-free layouts enforce exact
        // gaps and widths without visible filler characters.
        val unit = PresentationTextRun(
            text = ZERO_WIDTH_NON_JOINER,
            style = textStyle.copy(
                bold = true,
                italic = false,
                underlined = false,
                strikethrough = false,
            ),
            kind = fallbackKind,
            unbreakable = true,
        )
        val measuredUnit = measurer.measure(listOf(unit))
        if (measuredUnit.logicalWidthPixels != 1 || measuredUnit.visualBounds.bottom > measuredUnit.visualBounds.top) {
            throw TextLayoutException(ThemeFallbackCode.MISSING_GLYPH, "The vanilla one-pixel invisible advance metric is unavailable")
        }
        return listOf(unit.copy(text = ZERO_WIDTH_NON_JOINER.repeat(pixels)))
    }

    private fun addIconGap(values: List<StyledRun>, flow: LayoutSource.Flow?): List<StyledRun> {
        if (flow == null || values.firstOrNull()?.run?.kind != PresentationRunKind.ICON) return values
        val first = values.first()
        val textStyle = first.run.style.copy(font = theme.fonts.getValue("text"))
        val gap = exactSpacingRuns(flow.fieldIconGapPixels, textStyle).map { run ->
            StyledRun(run, first.role)
        }
        return listOf(first) + gap + values.drop(1)
    }

    private fun joinExplicitLines(lines: List<StyledLine>): StyledLine {
        if (lines.size <= 1) return lines.firstOrNull() ?: StyledLine(emptyList())
        val output = ArrayList<StyledRun>()
        lines.forEachIndexed { index, line ->
            if (index > 0) {
                val style = output.lastOrNull()?.run?.style ?: line.values.firstOrNull()?.run?.style ?: PresentationTextStyle()
                output += StyledRun(PresentationTextRun(" ", style), role = "description")
            }
            output += line.values
        }
        return StyledLine(output)
    }

    private fun alignFieldValue(values: List<StyledRun>, widthPixels: Int): List<PresentationTextRun> {
        val valueIndex = values.indexOfFirst(StyledRun::fieldValue)
        val runs = values.map(StyledRun::run)
        if (valueIndex <= 0 || valueIndex >= runs.size) return runs
        val measured = measurer.measure(runs).logicalWidthPixels
        if (measured >= widthPixels) return runs
        val style = runs[valueIndex].style.copy(bold = false, italic = false)
        return runs.take(valueIndex) + boundedPaddingRuns(widthPixels - measured, style) + runs.drop(valueIndex)
    }

    private fun appendVerticalGap(output: MutableList<PresentationLine>, pixels: Int) {
        repeat(pixels / TOOLTIP_LINE_HEIGHT_PIXELS) { output += measurer.measure(emptyList()) }
    }

    private fun appendRightPadding(line: PresentationLine, pixels: Int): PresentationLine {
        if (pixels <= 0) return line
        val textStyle = line.runs.lastOrNull()?.style ?: style("value", theme.fonts.getValue("text"))
        return measurer.measure(line.runs + paddingRuns(pixels, textStyle))
    }

    private fun boundedPaddingRuns(pixels: Int, textStyle: PresentationTextStyle): List<PresentationTextRun> {
        if (pixels <= 0) return emptyList()
        if (viewer.resourcePackLoaded && catalog.spacing != null) {
            return spacingRuns(pixels, PresentationRunKind.SPACING)
        }
        val space = PresentationTextRun(" ", textStyle.copy(bold = false, italic = false), unbreakable = true)
        val width = measurer.measure(listOf(space)).logicalWidthPixels.coerceAtLeast(1)
        val count = pixels / width
        return if (count == 0) emptyList() else listOf(space.copy(text = " ".repeat(count)))
    }

    private fun renderCharacterFrame(layout: CompiledLayout, blocks: List<StyledBlock>): List<PresentationLine> {
        val frame = requireNotNull(theme.source.characterFrame)
        val contentMaximum = frame.maximumWidthPixels - frame.leftPaddingPixels - frame.rightPaddingPixels - 8
        val flow = renderFlow(layout, blocks, contentMaximum)
        if (flow.lines.size > frame.maximumLines) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Character frame line count exceeded")
        val chars = FrameCharacters.forPreset(frame.preset)
        val frameFont = theme.fonts["frame"] ?: theme.fonts.getValue("text")
        val frameStyle = style("frame", frameFont).copy(bold = false, italic = false)
        if (frame.preset == CharacterFramePreset.SEPARATOR_ONLY) {
            val separator = characterHorizontal(chars.horizontal, flow.targetWidth, frameStyle)
            return buildList {
                add(separator)
                addAll(flow.lines)
                add(separator)
            }
        }
        val target = max(frame.minimumWidthPixels, flow.targetWidth + frame.leftPaddingPixels + frame.rightPaddingPixels + 4)
        val top = characterBorder(chars.topLeft, chars.horizontal, chars.topRight, target, frameStyle)
        val bottom = characterBorder(chars.bottomLeft, chars.horizontal, chars.bottomRight, top.logicalWidthPixels, frameStyle)
        val body = ArrayList<PresentationLine>()
        flow.lines.forEachIndexed { index, line ->
            if (index in flow.sectionBoundaries) body += characterBorder(chars.teeLeft, chars.horizontal, chars.teeRight, top.logicalWidthPixels, frameStyle)
            body += characterBody(chars.vertical, line, top.logicalWidthPixels, frame, frameStyle)
        }
        return listOf(top) + body + bottom
    }

    private fun characterHorizontal(character: String, target: Int, style: PresentationTextStyle): PresentationLine {
        val unit = PresentationTextRun(character, style, PresentationRunKind.FRAME, true)
        val width = measurer.measure(listOf(unit)).logicalWidthPixels.coerceAtLeast(1)
        val count = ceil(target.toDouble() / width).toInt().coerceAtLeast(1)
        return measurer.measure(listOf(unit.copy(text = character.repeat(count))))
    }

    private fun characterBorder(left: String, fill: String, right: String, target: Int, style: PresentationTextStyle): PresentationLine {
        val leftRun = PresentationTextRun(left, style, PresentationRunKind.FRAME, true)
        val rightRun = PresentationTextRun(right, style, PresentationRunKind.FRAME, true)
        val fillRun = PresentationTextRun(fill, style, PresentationRunKind.FRAME, true)
        val fixed = measurer.measure(listOf(leftRun, rightRun)).logicalWidthPixels
        val fillWidth = measurer.measure(listOf(fillRun)).logicalWidthPixels.coerceAtLeast(1)
        val count = ceil((target - fixed).coerceAtLeast(0).toDouble() / fillWidth).toInt().coerceAtLeast(1)
        return measurer.measure(listOf(leftRun, fillRun.copy(text = fill.repeat(count)), rightRun))
    }

    private fun characterBody(
        vertical: String,
        content: PresentationLine,
        target: Int,
        frame: CharacterFrameSource,
        frameStyle: PresentationTextStyle,
    ): PresentationLine {
        val edge = PresentationTextRun(vertical, frameStyle, PresentationRunKind.FRAME, true)
        val paddingStyle = style("value", theme.fonts.getValue("text"))
        val base = listOf(edge) + exactSpacingRuns(frame.leftPaddingPixels, paddingStyle) + content.runs
        val withoutRight = measurer.measure(base + edge).logicalWidthPixels
        val rightNeed = target - withoutRight
        if (rightNeed < frame.rightPaddingPixels) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Character frame has insufficient right padding")
        }
        val result = measurer.measure(base + exactSpacingRuns(rightNeed, paddingStyle) + edge)
        if (result.logicalWidthPixels != target) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Character frame cannot meet its exact target width")
        }
        return result
    }

    /**
     * Renders a segmented frame around the item, name included.
     *
     * The name shares the top row rather than sitting above it. That is how Epic's own font is meant
     * to be used — its instructions put the top glyph at the start of the *name* line — and it is
     * what keeps the name inside the frame. Leaving it out would strand it above the border with
     * nothing behind it, because a theme that paints its own panel also blanks vanilla's background.
     */
    private fun renderSegmentedFrame(
        layout: CompiledLayout,
        blocks: List<StyledBlock>,
        name: PresentationLine,
    ): AnchoredFlow {
        val frame = requireNotNull(theme.source.segmentedFrame)
        val contentMaximum = frame.maximumWidthPixels - frame.leftPaddingPixels - frame.rightPaddingPixels - 8
        val flow = renderFlow(layout, blocks, contentMaximum)
        // The name is budgeted like any other row: it was ellipsized against the theme's own
        // maximum, which does not account for the frame's caps and padding.
        val fittedName = layouter.ellipsizeLine(name.runs, contentMaximum)
        val content = max(flow.targetWidth, fittedName.logicalWidthPixels)
        val target = max(frame.minimumWidthPixels, content + frame.leftPaddingPixels + frame.rightPaddingPixels + 8)
        if (target > frame.maximumWidthPixels) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Segmented frame width exceeded")
        val framedName = segmentedBody(frame.top, fittedName, target, frame.leftPaddingPixels, frame.rightPaddingPixels)
        val output = ArrayList<PresentationLine>()
        flow.lines.forEachIndexed { index, line ->
            if (index in flow.sectionBoundaries && frame.connector != null) output += segmentedBorder(frame.connector, target)
            output += segmentedBody(frame.body, line, target, frame.leftPaddingPixels, frame.rightPaddingPixels)
        }
        output += segmentedBorder(frame.bottom, target)
        return AnchoredFlow(framedName, output)
    }

    /**
     * One frame piece with its kern appended.
     *
     * A Minecraft bitmap glyph advances one pixel past its ink, so butting pieces together leaves a
     * gap at every seam. The kern cancels that pixel. It has to live in the same font as the piece
     * so the two share a style and a whole frame row stays one run.
     */
    private fun framePiece(id: String, kern: PresentationTextRun?): PresentationTextRun {
        val run = assetRun(id, PresentationRunKind.FRAME)
        if (kern == null) return run
        if (run.style != kern.style) {
            throw TextLayoutException(
                ThemeFallbackCode.LAYOUT_OVERFLOW,
                "Frame piece $id and its kern must share a font",
            )
        }
        return run.copy(text = run.text + kern.text)
    }

    private fun kernRun(row: FrameRowSource): PresentationTextRun? =
        row.kern?.let { assetRun(it, PresentationRunKind.FRAME) }

    /**
     * The background of one frame row: the two caps with the fill tiled between them, split around
     * a centre ornament when the row has one.
     *
     * Border rows and body rows share this so a row's artwork cannot drift depending on whether it
     * carries text. [exact] is the difference: a body row has to have its interior covered to the
     * pixel, because the text is then drawn back over that interior.
     */
    private fun frameStrip(row: FrameRowSource, target: Int, exact: Boolean): FrameStrip {
        val kern = kernRun(row)
        val left = framePiece(row.left, kern)
        val fill = framePiece(row.fill, kern)
        val right = framePiece(row.right, kern)
        val center = row.center?.let { framePiece(it, kern) }
        val leftWidth = measurer.measure(listOf(left)).logicalWidthPixels
        val rightWidth = measurer.measure(listOf(right)).logicalWidthPixels
        val centerWidth = center?.let { measurer.measure(listOf(it)).logicalWidthPixels } ?: 0
        val unit = measurer.measure(listOf(fill)).logicalWidthPixels.coerceAtLeast(1)
        val span = target - leftWidth - rightWidth - centerWidth
        if (span < 0) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Segmented row caps do not fit the target width")
        }
        val count = if (exact) {
            if (span % unit != 0) {
                throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Segmented fill cannot exactly cover its interior")
            }
            span / unit
        } else {
            ceil(span.toDouble() / unit).toInt()
        }
        // With an ornament the fill splits around it, biasing the odd pixel to the left so the
        // ornament sits where a reader expects the centre of the frame.
        val leading = if (center == null) count else (count + 1) / 2
        val runs = if (center == null) {
            listOf(left, fill.copy(text = fill.text.repeat(count)), right)
        } else {
            listOf(
                left,
                fill.copy(text = fill.text.repeat(leading)),
                center,
                fill.copy(text = fill.text.repeat(count - leading)),
                right,
            )
        }
        return FrameStrip(runs, target - leftWidth - rightWidth)
    }

    private fun segmentedBorder(row: FrameRowSource, target: Int): PresentationLine {
        val line = measurer.measure(frameStrip(row, target, exact = false).runs)
        if (line.logicalWidthPixels > theme.source.segmentedFrame!!.maximumWidthPixels) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Segmented border cannot fit the target width")
        }
        return line
    }

    private fun segmentedBody(
        row: FrameRowSource,
        content: PresentationLine,
        target: Int,
        leftPadding: Int,
        rightPadding: Int,
    ): PresentationLine {
        val strip = frameStrip(row, target, exact = true)
        val interiorWidth = strip.interiorWidth
        val remaining = interiorWidth - leftPadding - content.logicalWidthPixels
        if (remaining < rightPadding) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Segmented content exceeds its frame")
        // The strip is drawn first, then the cursor rewinds across the whole interior so the text
        // lands on top of it. An ornament rides in the strip and stays clear of the text vertically.
        val runs = ArrayList<PresentationTextRun>()
        runs += strip.runs.dropLast(1)
        runs += spacingRuns(-interiorWidth, PresentationRunKind.SPACING)
        runs += spacingRuns(leftPadding, PresentationRunKind.SPACING)
        runs += content.runs
        runs += spacingRuns(remaining, PresentationRunKind.WIDTH_ANCHOR)
        runs += strip.runs.last()
        val measured = measurer.measure(runs)
        if (measured.logicalWidthPixels != target) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Segmented body did not preserve its target width")
        }
        return measured
    }

    private fun renderCanvas(layout: CompiledLayout, blocks: List<StyledBlock>): List<PresentationLine> {
        val canvasLayout = layout as? CompiledLayout.Canvas
            ?: throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Bitmap canvas theme requires a canvas layout")
        val canvas = requireNotNull(theme.source.canvas)
        if (canvasLayout.source.widthPixels != canvas.widthPixels || canvasLayout.source.heightPixels != canvas.heightPixels ||
            canvasLayout.source.reserveTooltipLines != canvas.reserveTooltipLines
        ) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas layout and theme dimensions differ")
        }
        val elements = Array(canvas.reserveTooltipLines) { ArrayList<CanvasElement>() }
        val layerBounds = canvas.layers.map { layer ->
            if (layer.baselineLine !in elements.indices) {
                throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas layer baseline is outside its reserved lines")
            }
            val glyph = requireNotNull(catalog.glyphs[layer.asset])
            val bitmap = requireNotNull(glyph.bitmap?.let(catalog.bitmaps::get))
            val x = when (layer.anchor) {
                CanvasLayerAnchor.TOP_LEFT -> layer.xPixels
                CanvasLayerAnchor.TOP_RIGHT -> canvas.widthPixels + layer.xPixels - bitmap.renderWidthPixels
            }
            val runs = listOf(assetRun(layer.asset, PresentationRunKind.BITMAP))
            val measured = measurer.measure(runs)
            elements[layer.baselineLine] += CanvasElement(x, layer.drawOrder, runs)
            CanvasPlacedBounds(
                left = x + measured.visualBounds.left,
                right = x + measured.visualBounds.right,
                top = layer.baselineLine * TOOLTIP_LINE_HEIGHT_PIXELS + measured.visualBounds.top,
                bottom = layer.baselineLine * TOOLTIP_LINE_HEIGHT_PIXELS + measured.visualBounds.bottom,
            )
        }
        val visualOriginY = if (canvas.normalizeVisualOrigin) {
            layerBounds.minOfOrNull(CanvasPlacedBounds::top) ?: 0.0
        } else {
            0.0
        }
        if (canvas.rejectOutOfBoundsLayer) {
            layerBounds.forEach { bounds -> validateCanvasBounds(bounds, visualOriginY, canvas) }
        }
        val usedAnchorLines = HashMap<String, Int>()
        var contentDrawOrder = 10_000
        blocks.forEach { block ->
            val anchorName = block.anchor
                ?: throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Every canvas block must name an anchor")
            val anchor = requireNotNull(canvasLayout.source.anchors[anchorName])
            val policy = wrappingPolicy(layout, block.wrapping)
            val consumed = usedAnchorLines[anchorName] ?: 0
            val anchorCapacity = ((anchor.height + policy.lineHeightPixels - 1) / policy.lineHeightPixels)
                .coerceAtMost(policy.maximumLines)
            val remainingCapacity = anchorCapacity - consumed
            if (remainingCapacity <= 0) {
                throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas anchor $anchorName has no remaining line capacity")
            }
            val logicalLines = if (policy.preserveExplicitLines) block.lines else listOf(joinExplicitLines(block.lines))
            val lines = ArrayList<PresentationLine>()
            logicalLines.forEach { line ->
                val availableLines = remainingCapacity - lines.size
                if (availableLines <= 0) {
                    throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas anchor $anchorName exceeded its line capacity")
                }
                lines += layouter.wrap(
                    line.runs,
                    minOf(anchor.width, policy.widthPixels ?: anchor.width),
                    availableLines,
                    anchor.overflow,
                    preserveExplicitLines = false,
                    continuationIndentPixels = policy.continuationIndentPixels,
                )
            }
            lines.forEachIndexed { index, line ->
                val anchorLine = consumed + index
                val continuation = if (index > 0) policy.continuationIndentPixels else 0
                val positioned = if (continuation > 0) indentLine(line, continuation) else line
                val desiredTop = anchor.y + anchorLine * policy.lineHeightPixels
                val idealRawBaseline = visualOriginY + desiredTop - positioned.visualBounds.top
                val baseline = ceil(idealRawBaseline / TOOLTIP_LINE_HEIGHT_PIXELS).toInt()
                if (baseline !in elements.indices) {
                    throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas content exceeds reserved tooltip lines")
                }
                val contentX = anchor.x + max(0, ceil(-positioned.visualBounds.left).toInt())
                val placed = CanvasPlacedBounds(
                    left = contentX + positioned.visualBounds.left,
                    right = contentX + positioned.visualBounds.right,
                    top = baseline * TOOLTIP_LINE_HEIGHT_PIXELS + positioned.visualBounds.top,
                    bottom = baseline * TOOLTIP_LINE_HEIGHT_PIXELS + positioned.visualBounds.bottom,
                )
                val relativeTop = placed.top - visualOriginY
                val relativeBottom = placed.bottom - visualOriginY
                if (placed.left < anchor.x || placed.right > anchor.x + anchor.width ||
                    relativeTop < anchor.y || relativeBottom > anchor.y + anchor.height
                ) {
                    throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas content exceeds anchor $anchorName")
                }
                elements[baseline] += CanvasElement(contentX, contentDrawOrder++, positioned.runs)
            }
            usedAnchorLines[anchorName] = consumed + lines.size
        }
        var glyphCount = 0
        var componentCount = 0
        var minimumVisualY = Double.POSITIVE_INFINITY
        var maximumVisualY = Double.NEGATIVE_INFINITY
        val output = elements.mapIndexed { lineIndex, lineElements ->
            val runs = ArrayList<PresentationTextRun>()
            var cursor = 0
            lineElements.sortedWith(compareBy(CanvasElement::drawOrder, CanvasElement::x)).forEach { element ->
                runs += spacingRuns(element.x - cursor, PresentationRunKind.SPACING)
                cursor = element.x
                runs += element.runs
                cursor += measurer.measure(element.runs).logicalWidthPixels
            }
            val finalAdvance = canvas.finalTooltipWidthPixels - cursor
            if (canvas.rejectNegativeFinalAdvance && finalAdvance < 0) {
                throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas has negative final advance")
            }
            runs += spacingRuns(finalAdvance, PresentationRunKind.WIDTH_ANCHOR)
            glyphCount += runs.sumOf { it.text.codePointCount(0, it.text.length) }
            if (glyphCount > catalog.budgets.maximumEmittedGlyphs) {
                throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Canvas emitted too many glyphs")
            }
            componentCount += runs.size
            if (componentCount > canvas.maximumEmittedComponents) {
                throw TextLayoutException(
                    ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED,
                    "Canvas emitted more than ${canvas.maximumEmittedComponents} components",
                )
            }
            val measured = measurer.measure(runs)
            if (measured.logicalWidthPixels != canvas.finalTooltipWidthPixels ||
                measured.logicalWidthPixels != canvas.measuredAdvancePixels
            ) {
                throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas width anchor did not produce the declared width")
            }
            if (canvas.rejectOutOfBoundsLayer &&
                (measured.visualBounds.left < 0.0 || measured.visualBounds.right > canvas.widthPixels.toDouble())
            ) {
                throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas ink exceeds its horizontal bounds")
            }
            if (measured.visualBounds.bottom > measured.visualBounds.top) {
                val baselineY = lineIndex * TOOLTIP_LINE_HEIGHT_PIXELS
                minimumVisualY = minOf(minimumVisualY, baselineY + measured.visualBounds.top - visualOriginY)
                maximumVisualY = maxOf(maximumVisualY, baselineY + measured.visualBounds.bottom - visualOriginY)
            }
            measured
        }
        if (minimumVisualY.isFinite() &&
            (minimumVisualY < 0.0 || maximumVisualY > canvas.heightPixels ||
                maximumVisualY - minimumVisualY > canvas.maximumHeightPixels)
        ) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas ink exceeds its vertical bounds")
        }
        return output
    }

    private fun validateCanvasBounds(
        bounds: CanvasPlacedBounds,
        visualOriginY: Double,
        canvas: CanvasThemeSource,
    ) {
        if (bounds.left < 0.0 || bounds.right > canvas.widthPixels ||
            bounds.top - visualOriginY < 0.0 || bounds.bottom - visualOriginY > canvas.heightPixels
        ) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Canvas layer exceeds its absolute bounds")
        }
    }

    private fun wrappingPolicy(layout: CompiledLayout, id: String?): WrappingSource {
        val policies = when (layout) {
            is CompiledLayout.Flow -> layout.source.wrapping
            is CompiledLayout.Canvas -> layout.source.wrapping
        }
        return id?.let(policies::get) ?: policies["body"] ?: policies.values.firstOrNull() ?: WrappingSource()
    }

    private fun assetRun(id: String, kind: PresentationRunKind): PresentationTextRun {
        val glyph = requireNotNull(catalog.glyphs[id]) { "Unknown glyph $id" }
        return PresentationTextRun(
            String(Character.toChars(glyph.codePoint)),
            style("frame", glyph.font).copy(bold = false, italic = false),
            kind,
            unbreakable = true,
        )
    }

    private fun spacingRuns(advance: Int, kind: PresentationRunKind): List<PresentationTextRun> {
        if (advance == 0) return emptyList()
        val spacing = requireNotNull(catalog.spacing) { "Signed spacing is unavailable" }
        val output = ArrayList<PresentationTextRun>()
        var remaining = advance
        while (remaining != 0) {
            val part = if (remaining > 0) {
                minOf(remaining, spacing.positive.maximumAdvancePixels)
            } else {
                maxOf(remaining, spacing.negative.minimumAdvancePixels)
            }
            val codePoint = requireNotNull(spacing.codePointFor(part)) { "Spacing advance $part is not representable" }
            output += PresentationTextRun(
                String(Character.toChars(codePoint)),
                PresentationTextStyle(font = spacing.font),
                kind,
                unbreakable = true,
            )
            remaining -= part
        }
        return output
    }

    private fun paddingRuns(pixels: Int, textStyle: PresentationTextStyle): List<PresentationTextRun> {
        if (pixels <= 0) return emptyList()
        if (viewer.resourcePackLoaded && catalog.spacing != null) {
            return spacingRuns(pixels, PresentationRunKind.SPACING)
        }
        val space = PresentationTextRun(" ", textStyle.copy(bold = false, italic = false), unbreakable = true)
        val width = measurer.measure(listOf(space)).logicalWidthPixels.coerceAtLeast(1)
        return listOf(space.copy(text = " ".repeat(ceil(pixels.toDouble() / width).toInt())))
    }

    private fun indentLine(line: PresentationLine, pixels: Int): PresentationLine {
        if (pixels <= 0) return line
        val textFont = theme.fonts.getValue("text")
        val textStyle = (line.runs.firstOrNull()?.style ?: style("value", textFont)).copy(font = textFont)
        return measurer.measure(paddingRuns(pixels, textStyle) + line.runs)
    }

    private fun validateOutput(name: PresentationLine, lore: List<PresentationLine>) {
        if (lore.size > catalog.budgets.maximumLines) throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Lore line budget exceeded")
        val all = listOf(name) + lore
        if (all.any { it.logicalWidthPixels > catalog.budgets.maximumWidthPixels }) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Line width budget exceeded")
        }
        // Segmented frames are self-drawn and visualBounds carries less meaning: the frame pieces
        // sit inside their bounds and the actual rendering is controlled by the decorator, not by
        // the text renderer. Relax the visualBounds check for them.
        val visualBudget = if (theme.source.renderer == ThemeRenderer.SEGMENTED_FRAME) {
            (catalog.budgets.maximumWidthPixels * 1.1).toInt()
        } else {
            catalog.budgets.maximumWidthPixels
        }
        if (all.any { line ->
                line.visualBounds.right - line.visualBounds.left > visualBudget
            }
        ) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Visual ink width exceeds the horizontal budget")
        }
        if (all.any { line -> line.runs.size > MAX_SERIALIZED_RUNS_PER_LINE }) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Serialized line run budget exceeded")
        }
        if (all.any { line -> line.runs.sumOf { it.text.length } > MAX_PRESENTATION_LINE_UTF16 }) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Serialized line text budget exceeded")
        }
        val runs = all.sumOf { it.runs.size }
        if (runs > minOf(catalog.budgets.maximumRuns, MAX_SERIALIZED_TOTAL_RUNS)) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Run budget exceeded")
        }
        val codePoints = all.sumOf { line -> line.runs.sumOf { it.text.codePointCount(0, it.text.length) } }
        if (codePoints > catalog.budgets.maximumTextCodePoints) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Text budget exceeded")
        }
        if (all.sumOf { line -> line.runs.sumOf { it.text.length } } > MAX_SERIALIZED_TOTAL_UTF16) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Serialized display text budget exceeded")
        }
        val structuralHeight = VanillaTooltipGeometry.measuredHeight(all.size)
        var minimumY = Double.POSITIVE_INFINITY
        var maximumY = Double.NEGATIVE_INFINITY
        all.forEachIndexed { index, line ->
            if (line.visualBounds.bottom > line.visualBounds.top) {
                val baseline = VanillaTooltipGeometry.componentY(index)
                minimumY = minOf(minimumY, baseline + line.visualBounds.top)
                maximumY = maxOf(maximumY, baseline + line.visualBounds.bottom)
            }
        }
        val visualHeight = if (minimumY.isFinite()) ceil(maximumY - minimumY).toInt() else 0
        if (max(structuralHeight, visualHeight) > catalog.budgets.maximumHeightPixels) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Display height budget exceeded")
        }
    }

    private data class StyledBlock(
        val lines: List<StyledLine>,
        val anchor: String?,
        val wrapping: String?,
        val sectionBoundaryBefore: Boolean,
        val kind: SemanticBlockKind,
    )

    private data class StyledLine(val values: List<StyledRun>) {
        val runs: List<PresentationTextRun> get() = values.map(StyledRun::run)
    }

    private data class FlowResult(
        val lines: List<PresentationLine>,
        val sectionBoundaries: Set<Int>,
        val targetWidth: Int,
    )

    private data class AnchoredFlow(
        val name: PresentationLine,
        val lines: List<PresentationLine>,
    )

    /** A frame row's background runs, plus the interior width the text is drawn back over. */
    private data class FrameStrip(
        val runs: List<PresentationTextRun>,
        val interiorWidth: Int,
    )

    private data class CanvasElement(
        val x: Int,
        val drawOrder: Int,
        val runs: List<PresentationTextRun>,
    )

    private data class CanvasPlacedBounds(
        val left: Double,
        val right: Double,
        val top: Double,
        val bottom: Double,
    )

    private data class FrameCharacters(
        val topLeft: String,
        val horizontal: String,
        val topRight: String,
        val vertical: String,
        val bottomLeft: String,
        val bottomRight: String,
        val teeLeft: String,
        val teeRight: String,
    ) {
        companion object {
            fun forPreset(preset: CharacterFramePreset): FrameCharacters = when (preset) {
                CharacterFramePreset.UNICODE_SINGLE -> FrameCharacters("┌", "─", "┐", "│", "└", "┘", "├", "┤")
                CharacterFramePreset.UNICODE_DOUBLE -> FrameCharacters("╔", "═", "╗", "║", "╚", "╝", "╠", "╣")
                CharacterFramePreset.ASCII_SAFE -> FrameCharacters("+", "-", "+", "|", "+", "+", "+", "+")
                CharacterFramePreset.BRACKETED_SECTION -> FrameCharacters("[", "-", "]", "[", "[", "]", "[", "]")
                CharacterFramePreset.SEPARATOR_ONLY -> FrameCharacters("", "─", "", "", "", "", "", "")
            }
        }
    }

    private companion object {
        const val TOOLTIP_LINE_HEIGHT_PIXELS = VanillaTooltipGeometry.TEXT_COMPONENT_HEIGHT_PIXELS
        const val MAX_SERIALIZED_RUNS_PER_LINE = 256
        const val MAX_SERIALIZED_TOTAL_RUNS = 4_096
        const val MAX_SERIALIZED_TOTAL_UTF16 = 131_072
        const val ZERO_WIDTH_NON_JOINER = "\u200C"
        val NAMED_COLORS = mapOf(
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

        fun defaultColor(role: String): String = when (role) {
            "label" -> "gray"
            "description" -> "dark_gray"
            "requirement-met" -> "green"
            "requirement-unmet" -> "red"
            else -> "white"
        }

        fun parseColor(value: String): Int =
            if (value.startsWith('#')) value.drop(1).toInt(16) else requireNotNull(NAMED_COLORS[value])

        fun splitExplicitLines(runs: List<SemanticRun>): List<List<SemanticRun>> {
            val output = arrayListOf<ArrayList<SemanticRun>>(ArrayList())
            runs.forEach { run ->
                val parts = run.text.split('\n')
                parts.forEachIndexed { index, part ->
                    if (part.isNotEmpty() || run.assetId != null) output.last() += run.copy(text = part)
                    if (index != parts.lastIndex) output.add(ArrayList())
                }
            }
            return output
        }

        fun chunkForSerialization(text: String): List<String> {
            if (text.length <= MAX_PRESENTATION_LINE_UTF16) return listOf(text)
            val output = ArrayList<String>()
            var start = 0
            while (start < text.length) {
                var end = minOf(start + MAX_PRESENTATION_LINE_UTF16, text.length)
                if (end < text.length && Character.isHighSurrogate(text[end - 1]) && Character.isLowSurrogate(text[end])) {
                    end--
                }
                output += text.substring(start, end)
                start = end
            }
            return output
        }
    }
}

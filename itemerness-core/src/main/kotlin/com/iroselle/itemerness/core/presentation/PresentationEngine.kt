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
    private companion object {
        /** Each hiding step re-resolves and re-renders, so the search stays bounded. */
        const val MAXIMUM_HIDING_STEPS = 64
    }

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
            resolveSemantic(item, request, messages, formatter, emptySet())
        } catch (exception: RuntimePresentationException) {
            return rejected(exception.code, exception.message)
        }
        // A viewer-level override (for example an accessibility preference) outranks the item's
        // binding. Either may name a selector, which picks the concrete theme from the same data
        // and viewer facts that conditional blocks read; the fallback chain then applies unchanged.
        val requestedTheme = try {
            resolveRequestedTheme(request.viewer.requestedTheme ?: item.theme, request)
        } catch (exception: RuntimePresentationException) {
            return rejected(exception.code, exception.message)
        }
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
            val engine = ThemeRendererEngine(catalog, current)
            try {
                val display = try {
                    engine.render(item, semantic, requestedTheme, fallbacks)
                } catch (exception: TextLayoutException) {
                    if (!exception.capacity || item.overflow != OverflowStrategy.HIDE) throw exception
                    renderHiding(engine, item, request, messages, formatter, semantic, requestedTheme, fallbacks, exception)
                }
                return PresentationRenderResult.Rendered(display)
            } catch (exception: RuntimePresentationException) {
                return rejected(exception.code, exception.message)
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
            // Each theme's detail names the authored blocks behind a layout failure.
            "No safe theme could render ${request.itemKey}: ${fallbacks.joinToString { "${it.theme}:${it.code} (${it.detail})" }}",
        )
    }

    /**
     * Hides rows one at a time in the item's fixed hiding order until the content fits this theme.
     *
     * The order depends only on the complete presentation, never on what a summary slot shows, so
     * the search always ends and every viewer with the same data gets the same result. Each step
     * re-resolves the presentation, because hiding a row changes its siblings' connectors and the
     * contents of summary slots.
     */
    private fun renderHiding(
        engine: ThemeRendererEngine,
        item: CompiledItemPresentation,
        request: PresentationRenderRequest,
        messages: MessageResolver,
        formatter: ValueFormatter,
        complete: ResolvedPresentation,
        requestedTheme: ItemKey,
        fallbacks: List<ThemeFallbackReason>,
        overflow: TextLayoutException,
    ): PresentationDisplay {
        val order = complete.rows.withIndex()
            .filter { it.value.weight != HidingWeight.Never }
            .sortedWith(
                compareBy<IndexedValue<RowRecord>>(
                    { it.value.hostsSlot },
                    { if (it.value.weight == null) 1 else 0 },
                    { (it.value.weight as? HidingWeight.Ranked)?.value ?: 0 },
                ).thenByDescending { it.index },
            )
            .map { it.value.id }
        var last = overflow
        val steps = minOf(order.size, MAXIMUM_HIDING_STEPS)
        for (count in 1..steps) {
            val hidden = order.subList(0, count)
            val excluded = hidden.toHashSet()
            val semantic = resolveSemantic(item, request, messages, formatter, excluded)
            try {
                return engine.render(item, semantic, requestedTheme, fallbacks, hidden)
            } catch (exception: TextLayoutException) {
                if (!exception.capacity) throw exception
                last = exception
            }
        }
        val reason = if (order.size > MAXIMUM_HIDING_STEPS) {
            "hiding stopped after $MAXIMUM_HIDING_STEPS rows"
        } else {
            "hiding all ${order.size} hideable rows did not fit"
        }
        throw TextLayoutException(last.fallbackCode, "${last.message}; $reason", capacity = true)
    }

    private fun resolveRequestedTheme(id: ItemKey, request: PresentationRenderRequest): ItemKey {
        val selector = catalog.themeSelectors[id] ?: return id
        return selector.cases.firstOrNull { case -> evaluate(case.condition, request) }?.theme ?: selector.defaultTheme
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

    /**
     * Resolves data, messages and conditions into rows. [excluded] lists the rows hidden to fit
     * the budgets; their summaries fill the slots they name. Summary pieces are static, so one
     * collecting pass followed by the real pass is always enough.
     */
    private fun resolveSemantic(
        item: CompiledItemPresentation,
        request: PresentationRenderRequest,
        messages: MessageResolver,
        formatter: ValueFormatter,
        excluded: Set<String>,
    ): ResolvedPresentation {
        val summaries = if (excluded.isNotEmpty() && item.hasSummaries) {
            resolvePass(item, request, messages, formatter, excluded, emptyMap()).summaries
                .groupBy(SummaryRecord::slot)
                .mapValues { (_, records) -> records.sortedBy(SummaryRecord::order).map(SummaryRecord::runs) }
        } else {
            emptyMap()
        }
        return resolvePass(item, request, messages, formatter, excluded, summaries)
    }

    private fun resolvePass(
        item: CompiledItemPresentation,
        request: PresentationRenderRequest,
        messages: MessageResolver,
        formatter: ValueFormatter,
        excluded: Set<String>,
        slotEntries: Map<String, List<List<SemanticRun>>>,
    ): ResolvedPresentation {
        val base = messages.resolve(item.nameMessage)
            ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${item.nameMessage}")
        val layoutSource = catalog.layouts[item.layout]?.source as? LayoutSource.Flow
        val resolution = Resolution(
            request,
            messages,
            formatter,
            layoutSource?.fieldSeparator,
            catalog.budgets.maximumBlocksPerItem,
            excluded,
            slotEntries,
        )
        val name = resolveFragments(item.nameBefore, "item-name", resolution) +
            SemanticRun(base, "item-name", unbreakable = true) +
            resolveFragments(item.nameAfter, "item-name", resolution)
        val blocks = resolveContainer(item.blocks, item.marker, item.dividers, resolution, depth = 1, path = "blocks", inherited = null)
        val codePoints = name.sumOf { run -> run.text.codePointCount(0, run.text.length) } + blocks.sumOf { block ->
            block.runs.sumOf { run -> run.text.codePointCount(0, run.text.length) }
        }
        if (codePoints > catalog.budgets.maximumTextCodePoints) {
            throw RuntimePresentationException(
                PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED,
                "Resolved presentation exceeds ${catalog.budgets.maximumTextCodePoints} code points",
            )
        }
        return ResolvedPresentation(name, blocks, resolution.rows, resolution.summaries)
    }

    /**
     * Resolves one container (the item root or a group) into decorated rows.
     *
     * Every child unit is resolved before any is decorated, because a tree connector depends on
     * whether a later sibling actually renders: omitted rows, unselected branches, hidden groups
     * and empty repeats never consume a connector.
     */
    private fun resolveContainer(
        sources: List<CompiledPresentationBlock>,
        marker: GroupMarker,
        dividers: GroupDividers,
        resolution: Resolution,
        depth: Int,
        path: String,
        inherited: HidingWeight?,
    ): List<SemanticBlock> {
        val units = ArrayList<ResolvedUnit>()
        collectUnits(sources, marker, resolution, depth, units, path, inherited)
        return decorate(units, marker, dividers)
    }

    private fun collectUnits(
        sources: List<CompiledPresentationBlock>,
        containerMarker: GroupMarker,
        resolution: Resolution,
        depth: Int,
        units: MutableList<ResolvedUnit>,
        path: String,
        inherited: HidingWeight?,
    ) {
        if (depth > catalog.budgets.maximumBlockDepth) {
            throw RuntimePresentationException(PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED, "Runtime block nesting exceeded")
        }
        val request = resolution.request
        val messages = resolution.messages
        val formatter = resolution.formatter
        sources.forEachIndexed { index, block ->
            resolution.requireRowCapacity()
            val blockPath = "$path[$index]"
            val weight = block.weight ?: inherited
            when (block) {
                is CompiledPresentationBlock.Text,
                is CompiledPresentationBlock.Field,
                is CompiledPresentationBlock.Description,
                is CompiledPresentationBlock.Row,
                is CompiledPresentationBlock.Rule,
                -> resolveRow(block, blockPath, weight, resolution)?.let { units += ResolvedUnit(listOf(it)) }

                // Conditionals are transparent: the selected branch's blocks are units of this container.
                is CompiledPresentationBlock.Conditional -> {
                    val (selected, branch) = if (evaluate(block.condition, request)) block.thenBlocks to "then" else block.otherwiseBlocks to "otherwise"
                    collectUnits(selected, containerMarker, resolution, depth + 1, units, "$blockPath.$branch", weight)
                }

                is CompiledPresentationBlock.Repeat -> {
                    val value = request.data[block.data]
                    if (value == null) {
                        if (block.missingPolicy == MissingDataPolicy.OMIT) return@forEachIndexed
                        throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_DATA, "Missing data ${block.data}")
                    }
                    val list = (value as? ListDataValue)?.values
                        ?: throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, "Repeat data ${block.data} is not a list")
                    if (list.size > block.maximumElements || list.size > catalog.budgets.maximumRepeatElements) {
                        throw RuntimePresentationException(PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED, "Repeat data ${block.data} exceeds its maximum")
                    }
                    list.forEachIndexed { elementIndex, value ->
                        val compound = value as? CompoundDataValue
                            ?: throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, "Repeat element is not a compound")
                        val elementPath = "$blockPath[#$elementIndex]"
                        if (resolution.hide(elementPath, block.summary) { summary -> repeatSummaryRuns(summary, compound, resolution) }) {
                            return@forEachIndexed
                        }
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
                        resolution.record(elementPath, weight, hostsSlot = false)
                        units += ResolvedUnit(
                            listOf(
                                resolution.row(
                                    SemanticBlock(
                                        fieldRuns(
                                            block.template.icon,
                                            label,
                                            block.template.separator,
                                            formatted,
                                            block.style,
                                            block.template.partStyles,
                                            resolution,
                                        ),
                                        block.anchor,
                                        null,
                                        kind = SemanticBlockKind.FIELD,
                                        source = elementPath,
                                    ),
                                ),
                            ),
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
                    request.nestedItems.forEachIndexed { elementIndex, nested ->
                        val elementPath = "$blockPath[#$elementIndex]"
                        if (resolution.hide(elementPath, block.summary) { summary -> staticSummaryRuns(summary, resolution) }) {
                            return@forEachIndexed
                        }
                        resolution.record(elementPath, weight, hostsSlot = false)
                        units += ResolvedUnit(
                            listOf(
                                resolution.row(
                                    SemanticBlock(
                                        buildList {
                                            // A decorated container's marker replaces the built-in bullet.
                                            if (containerMarker == GroupMarker.NONE) {
                                                add(SemanticRun("• ", block.style ?: "label", unbreakable = true))
                                            }
                                            add(SemanticRun(nested.displayName, block.style ?: "value"))
                                            add(SemanticRun(" ×${nested.amount}", block.style ?: "value", unbreakable = true))
                                        },
                                        block.anchor,
                                        null,
                                        source = elementPath,
                                    ),
                                ),
                            ),
                        )
                    }
                }

                is CompiledPresentationBlock.Group -> resolveGroup(block, resolution, depth + 1, blockPath, weight)?.let { rows ->
                    units += ResolvedUnit(rows, block.gapBeforeLines)
                }
            }
        }
    }

    private fun resolveGroup(
        group: CompiledPresentationBlock.Group,
        resolution: Resolution,
        depth: Int,
        path: String,
        weight: HidingWeight?,
    ): List<SemanticBlock>? {
        val header = group.header?.let { source ->
            resolution.requireRowCapacity()
            resolveRow(source, "$path.header", source.weight ?: weight, resolution)
        }
        if (group.header != null && header == null && group.whenHeaderMissing == GroupHeaderMissingPolicy.HIDE) return null
        val children = resolveContainer(group.children, group.marker, group.dividers, resolution, depth, "$path.children", weight)
        if (children.isNotEmpty()) return listOfNotNull(header) + children
        if (header == null || group.whenEmpty == GroupEmptyPolicy.HIDE) {
            if (header != null) resolution.discardRow()
            return null
        }
        return listOf(header)
    }

    /** Resolves a single-row block unless it is hidden, recording it as a hiding candidate. */
    private fun resolveRow(
        block: CompiledPresentationBlock,
        path: String,
        weight: HidingWeight?,
        resolution: Resolution,
    ): SemanticBlock? {
        if (resolution.hide(path, block.summary) { summary -> staticSummaryRuns(summary, resolution) }) return null
        val row = resolveLeaf(block, resolution)?.copy(source = path) ?: return null
        resolution.record(path, weight, hostsSlot = row.runs.any(SemanticRun::fromSlot) || block.hostsSlot())
        return row
    }

    private fun CompiledPresentationBlock.hostsSlot(): Boolean = when (this) {
        is CompiledPresentationBlock.Row -> (left + right).any { it is CompiledFragment.Slot }
        is CompiledPresentationBlock.Rule -> title.any { it is CompiledFragment.Slot }
        else -> false
    }

    /** Resolves a single-row block, or null when its data is absent and the block may be omitted. */
    private fun resolveLeaf(block: CompiledPresentationBlock, resolution: Resolution): SemanticBlock? {
        val request = resolution.request
        val messages = resolution.messages
        val formatter = resolution.formatter
        return when (block) {
            is CompiledPresentationBlock.Text -> {
                val value = request.data[block.data]
                if (value == null) {
                    if (block.missingPolicy == MissingDataPolicy.OMIT) return null
                    throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_DATA, "Missing data ${block.data}")
                }
                val text = formatter.format(value).getOrElse {
                    throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, it.message ?: "Formatting failed")
                }
                resolution.row(
                    SemanticBlock(
                        listOf(SemanticRun(text, block.style ?: "value", unbreakable = block.unbreakable)),
                        block.anchor,
                        block.wrapping,
                        kind = SemanticBlockKind.GENERIC,
                    ),
                )
            }

            is CompiledPresentationBlock.Field -> {
                val value = request.data[block.data]
                if (value == null) {
                    if (block.missingPolicy == MissingDataPolicy.OMIT) return null
                    throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_DATA, "Missing data ${block.data}")
                }
                val label = messages.resolve(block.labelMessage)
                    ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${block.labelMessage}")
                val formatted = formatter.format(value, block.format).getOrElse {
                    throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, it.message ?: "Formatting failed")
                }
                resolution.row(
                    SemanticBlock(
                        fieldRuns(block.icon, label, block.separator, formatted, block.style, block.partStyles, resolution),
                        block.anchor,
                        block.wrapping,
                        kind = SemanticBlockKind.FIELD,
                    ),
                )
            }

            is CompiledPresentationBlock.Description -> {
                val text = messages.resolve(block.message)
                    ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${block.message}")
                resolution.row(
                    SemanticBlock(
                        listOf(SemanticRun(text, block.style ?: "description")),
                        block.anchor,
                        block.wrapping,
                        kind = SemanticBlockKind.DESCRIPTION,
                    ),
                )
            }

            is CompiledPresentationBlock.Row -> {
                val left = resolveFragments(block.left, block.style, resolution).let { runs ->
                    // A leading glyph is the row's icon: it takes the layout's icon slot and gap like a field icon.
                    val first = runs.firstOrNull()
                    if (first?.assetId != null) listOf(first.copy(kind = PresentationRunKind.ICON)) + runs.drop(1) else runs
                }
                val right = resolveFragments(block.right, block.style, resolution).map { it.copy(rightRegion = true) }
                if (left.isEmpty() && right.isEmpty()) return null
                resolution.row(SemanticBlock(left + right, block.anchor, block.wrapping, kind = SemanticBlockKind.ROW))
            }

            is CompiledPresentationBlock.Rule -> resolution.row(
                SemanticBlock(resolveFragments(block.title, block.style, resolution), block.anchor, null, kind = SemanticBlockKind.RULE),
            )

            else -> error("Block ${block::class.simpleName} is not a single row")
        }
    }

    /**
     * Resolves inline fragments in order. A fragment whose condition is false or whose data is
     * absent is omitted; [role] is the enclosing block's style, used when a fragment has none.
     */
    private fun resolveFragments(fragments: List<CompiledFragment>, role: String?, resolution: Resolution): List<SemanticRun> {
        val output = ArrayList<SemanticRun>()
        fragments.forEach { fragment ->
            if (fragment.condition?.let { evaluate(it, resolution.request) } == false) return@forEach
            when (fragment) {
                is CompiledFragment.Message -> output += SemanticRun(
                    resolution.messages.resolve(fragment.message)
                        ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${fragment.message}"),
                    fragment.style ?: role ?: "label",
                )
                is CompiledFragment.Data -> {
                    val value = resolution.request.data[fragment.data] ?: return@forEach
                    output += SemanticRun(
                        resolution.formatter.format(value, fragment.format).getOrElse {
                            throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, it.message ?: "Formatting failed")
                        },
                        fragment.style ?: role ?: "value",
                    )
                }
                is CompiledFragment.Glyph -> output += SemanticRun("", fragment.style ?: role ?: "value", unbreakable = true, assetId = fragment.glyph)
                is CompiledFragment.Literal -> output += SemanticRun(fragment.text, fragment.style ?: role ?: "label", unbreakable = true)
                is CompiledFragment.Slot -> output += slotRuns(fragment, role, resolution)
            }
        }
        return output
    }

    /** A slot's entries with its decorations, or nothing when no hidden block named it. */
    private fun slotRuns(slot: CompiledFragment.Slot, role: String?, resolution: Resolution): List<SemanticRun> {
        val entries = resolution.slotEntries[slot.id].orEmpty()
        if (entries.isEmpty()) return emptyList()
        val slotRole = slot.style ?: role ?: "label"
        fun decoration(piece: CompiledFragment?): List<SemanticRun> =
            piece?.let { resolveFragments(listOf(it), slotRole, resolution) }.orEmpty()
        val shown = slot.maximumEntries?.let { entries.take(it) } ?: entries
        val remaining = entries.size - shown.size
        val separator = decoration(slot.separator)
        val runs = buildList {
            addAll(decoration(slot.prefix))
            shown.forEachIndexed { index, entry ->
                if (index > 0) addAll(separator)
                addAll(entry)
            }
            if (remaining > 0 && slot.overflowCountMessage != null) {
                if (shown.isNotEmpty()) addAll(separator)
                val text = resolution.messages.resolve(slot.overflowCountMessage, mapOf("count" to remaining.toString()))
                    ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${slot.overflowCountMessage}")
                add(SemanticRun(text, slotRole, unbreakable = true))
            }
            addAll(decoration(slot.suffix))
        }
        return runs.map { it.copy(fromSlot = true) }
    }

    private fun staticSummaryRuns(summary: CompiledSummary, resolution: Resolution): List<SemanticRun> =
        resolveFragments(listOfNotNull(summary.piece), summary.style, resolution)

    private fun repeatSummaryRuns(summary: CompiledSummary, element: CompoundDataValue, resolution: Resolution): List<SemanticRun> {
        val path = summary.valuePath ?: return staticSummaryRuns(summary, resolution)
        val value = lookupCompound(element, path) ?: return emptyList()
        val text = resolution.formatter.format(value, summary.format).getOrElse {
            throw RuntimePresentationException(PresentationRenderFailureCode.INVALID_RUNTIME_VALUE, it.message ?: "Formatting failed")
        }
        return listOf(SemanticRun(text, summary.style ?: "label", unbreakable = true))
    }

    /** Label, separator and value runs shared by fields and repeat templates. */
    private fun fieldRuns(
        icon: String?,
        label: String,
        separator: FieldSeparatorSource?,
        formatted: String,
        role: String?,
        parts: FieldPartStyles?,
        resolution: Resolution,
    ): List<SemanticRun> {
        // Precedence: the block's own separator, the layout default, then the original colon.
        val separatorText = when (val effective = separator ?: resolution.layoutSeparator) {
            null -> ": "
            FieldSeparatorSource.None -> null
            is FieldSeparatorSource.Message -> resolution.messages.resolve(effective.message)
                ?: throw RuntimePresentationException(PresentationRenderFailureCode.MISSING_MESSAGE, "Missing message ${effective.message}")
        }
        return buildList {
            icon?.let { add(SemanticRun("", parts?.icon ?: role ?: "value", PresentationRunKind.ICON, true, it)) }
            add(SemanticRun(label, parts?.label ?: role ?: "label", unbreakable = true))
            separatorText?.let { add(SemanticRun(it, parts?.separator ?: role ?: "label", unbreakable = true)) }
            add(SemanticRun(formatted, parts?.value ?: role ?: "value", fieldValue = true))
        }
    }

    /**
     * Applies a container's dividers and marker to its child units. A unit is one leaf row, one
     * repeat element, one nested item, or a whole child group; prefixes compose outermost first.
     */
    private fun decorate(units: List<ResolvedUnit>, marker: GroupMarker, dividers: GroupDividers): List<SemanticBlock> {
        val output = ArrayList<SemanticBlock>()
        units.forEachIndexed { unitIndex, unit ->
            val last = unitIndex == units.lastIndex
            val lead = when (marker) {
                GroupMarker.NONE -> null
                GroupMarker.BULLET -> MarkerPiece.BULLET
                GroupMarker.TREE -> if (last) MarkerPiece.TREE_LAST else MarkerPiece.TREE_BRANCH
            }
            val continuation = when (marker) {
                GroupMarker.NONE -> null
                GroupMarker.BULLET -> MarkerPiece.BULLET_BLANK
                GroupMarker.TREE -> if (last) MarkerPiece.TREE_BLANK else MarkerPiece.TREE_VERTICAL
            }
            // An empty line above a unit continues the connector from the previous sibling.
            val above = when (marker) {
                GroupMarker.NONE -> null
                GroupMarker.BULLET -> MarkerPiece.BULLET_BLANK
                GroupMarker.TREE -> if (unitIndex == 0) MarkerPiece.TREE_BLANK else MarkerPiece.TREE_VERTICAL
            }
            unit.rows.forEachIndexed { rowIndex, row ->
                val first = rowIndex == 0
                output += if (first) {
                    row.copy(
                        sectionBoundaryBefore = unitIndex > 0 && dividers == GroupDividers.BETWEEN_CHILDREN,
                        gapBeforeLines = row.gapBeforeLines + if (unitIndex > 0) unit.gapBeforeLines else 0,
                        firstPrefix = listOfNotNull(lead) + row.firstPrefix,
                        continuationPrefix = listOfNotNull(continuation) + row.continuationPrefix,
                        gapPrefix = listOfNotNull(above) + row.gapPrefix,
                    )
                } else if (marker == GroupMarker.NONE) {
                    row
                } else {
                    row.copy(
                        firstPrefix = listOfNotNull(continuation) + row.firstPrefix,
                        continuationPrefix = listOfNotNull(continuation) + row.continuationPrefix,
                        gapPrefix = listOfNotNull(continuation) + row.gapPrefix,
                    )
                }
            }
        }
        return output
    }

    private fun evaluate(condition: CompiledCondition, request: PresentationRenderRequest): Boolean {
        val left = resolveReference(condition.left, request)
        if (condition.operator == ConditionOperator.EXISTS) return left != null
        val right = condition.right?.let { resolveReference(it, request) }
        return when (condition.operator) {
            ConditionOperator.EQUALS -> presentationValuesEqual(left, right)
            ConditionOperator.NOT_EQUALS -> !presentationValuesEqual(left, right)
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
    val name: List<SemanticRun>,
    val blocks: List<SemanticBlock>,
    /** Every rendered row in document order: the candidates for hiding. */
    val rows: List<RowRecord>,
    val summaries: List<SummaryRecord>,
)

/** A rendered row that hiding may remove; [hostsSlot] rows go last so their slots stay visible. */
private data class RowRecord(
    val id: String,
    val weight: HidingWeight?,
    val hostsSlot: Boolean,
)

/** What a hidden row left for [slot]; [order] is its document position. */
private data class SummaryRecord(
    val slot: String,
    val order: Int,
    val runs: List<SemanticRun>,
)

/** One child unit of a container: a leaf row, a repeat element, a nested item or a whole group. */
private class ResolvedUnit(
    val rows: List<SemanticBlock>,
    val gapBeforeLines: Int = 0,
)

/** Per-render resolution state; [count] tracks every emitted row against the block budget. */
private class Resolution(
    val request: PresentationRenderRequest,
    val messages: MessageResolver,
    val formatter: ValueFormatter,
    val layoutSeparator: FieldSeparatorSource?,
    private val maximumRows: Int,
    private val excluded: Set<String> = emptySet(),
    val slotEntries: Map<String, List<List<SemanticRun>>> = emptyMap(),
) {
    private var count = 0
    private var order = 0
    val rows = ArrayList<RowRecord>()
    val summaries = ArrayList<SummaryRecord>()

    fun record(id: String, weight: HidingWeight?, hostsSlot: Boolean) {
        rows += RowRecord(id, weight, hostsSlot)
    }

    /**
     * Whether the row at [id] is hidden. A hidden row leaves its summary, positioned by document
     * order among every row met in this pass.
     */
    fun hide(id: String, summary: CompiledSummary?, runs: (CompiledSummary) -> List<SemanticRun>): Boolean {
        val position = order++
        if (id !in excluded) return false
        summary?.let { declared ->
            val pieces = runs(declared)
            if (pieces.isNotEmpty()) summaries += SummaryRecord(declared.slot, position, pieces)
        }
        return true
    }

    fun requireRowCapacity() {
        if (count >= maximumRows) {
            throw RuntimePresentationException(PresentationRenderFailureCode.OUTPUT_BUDGET_EXCEEDED, "Runtime block count exceeded")
        }
    }

    fun row(block: SemanticBlock): SemanticBlock {
        count++
        return block
    }

    fun discardRow() {
        count--
    }
}

private class RuntimePresentationException(
    val code: PresentationRenderFailureCode,
    override val message: String,
) : RuntimeException(message)

private class ThemeRendererEngine(
    private val catalog: PresentationCatalogSnapshot,
    private val theme: CompiledTheme,
) {
    private val measurer = PixelMeasurer(catalog)
    private val layouter = PixelTextLayouter(measurer)

    fun render(
        item: CompiledItemPresentation,
        semantic: ResolvedPresentation,
        requestedTheme: ItemKey,
        fallbackReasons: List<ThemeFallbackReason>,
        hidden: List<String> = emptyList(),
    ): PresentationDisplay {
        val layout = requireNotNull(catalog.layouts[item.layout])
        val nameStyle = style("item-name", theme.fonts.getValue("text"))
        val maximumWidth = effectiveMaximumWidth(layout)
        lineContributors = emptyList()
        val inset = theme.source.nameInsetPixels
        if (maximumWidth - 2 * inset <= 0) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "The name inset consumes the maximum width")
        }
        var name = layouter.ellipsizeLine(semantic.name.flatMap(::styleRuns).map(StyledRun::run), maximumWidth - 2 * inset)
        if (inset > 0) {
            name = measurer.measure(exactPadding(inset, nameStyle) + name.runs + exactPadding(inset, nameStyle))
        }
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
            tooltipStyle = if (theme.source.renderer in setOf(ThemeRenderer.NATIVE_TOOLTIP_STYLE, ThemeRenderer.SEGMENTED_FRAME, ThemeRenderer.BITMAP_CANVAS)) theme.tooltipStyle else null,
            renderer = theme.source.renderer,
            selectedTheme = theme.id,
            requestedTheme = requestedTheme,
            catalogRevision = catalog.revision,
            fallbackReasons = fallbackReasons,
            hiddenElements = hidden,
        )
    }

    /** Lines per authored block in the last flow, largest first, named by capacity diagnostics. */
    private var lineContributors: List<Pair<String, Int>> = emptyList()

    private fun contributorSuffix(): String {
        if (lineContributors.isEmpty()) return ""
        return "; largest: " + lineContributors.take(3).joinToString { (source, lines) ->
            "$source (${lines} line${if (lines == 1) "" else "s"})"
        }
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
            firstPrefix = block.firstPrefix,
            continuationPrefix = block.continuationPrefix,
            gapPrefix = block.gapPrefix,
            gapBeforeLines = block.gapBeforeLines,
            source = block.source,
        )
    }

    private fun styleRuns(run: SemanticRun): List<StyledRun> {
        if (run.assetId != null) {
            if (!theme.source.requiresResourcePack) return emptyList()
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
                    rightRegion = run.rightRegion,
                ),
            )
        }
        val textStyle = style(run.role, theme.fonts.getValue("text"))
        return chunkForSerialization(run.text).map { chunk ->
            StyledRun(
                PresentationTextRun(chunk, textStyle, run.kind, run.unbreakable),
                role = run.role,
                fieldValue = run.fieldValue,
                rightRegion = run.rightRegion,
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
            val (sectionLeft, sectionRight) = sectionPadding(flow, block)
            val prefix = prefixWidth(block)
            val natural = when (block.kind) {
                SemanticBlockKind.ROW -> rowWidth(block, flow)
                SemanticBlockKind.RULE -> ruleWidth(block)
                else -> block.lines.maxOfOrNull { line ->
                    measurer.measure(addIconGap(line.values, flow).map(StyledRun::run)).logicalWidthPixels
                }
            } ?: return@maxOfOrNull 0
            val contribution = natural + themeLeft + themeRight + sectionLeft + sectionRight + prefix
            // A wrapping width bounds the block's own lines, so it must not widen the tooltip past it.
            wrappingPolicy(layout, block.wrapping).widthPixels?.let { minOf(contribution, it) } ?: contribution
        }?.coerceIn(minimumWidth, maximumWidth) ?: minimumWidth.coerceAtMost(maximumWidth)
        val rendered = ArrayList<PresentationLine>()
        val boundaries = LinkedHashSet<Int>()
        val contributors = LinkedHashMap<String, Int>()
        blocks.forEachIndexed { blockIndex, block ->
            if (block.sectionBoundaryBefore && rendered.isNotEmpty()) boundaries += rendered.size
            repeat(block.gapBeforeLines) { rendered += gapLine(block.gapPrefix) }
            if (flow != null && block.kind == SemanticBlockKind.DESCRIPTION && rendered.isNotEmpty()) {
                appendVerticalGap(rendered, flow.descriptionGapBeforePixels, block.gapPrefix)
            }
            val policy = wrappingPolicy(layout, block.wrapping)
            val (sectionLeft, sectionRight) = sectionPadding(flow, block)
            val left = themeLeft + sectionLeft
            val right = themeRight + sectionRight
            val name = block.source?.let { "Block $it" } ?: "Block"
            // Marker prefixes are measured runs, so the text beside them wraps in what remains.
            val available = minOf(policy.widthPixels ?: targetWidth, targetWidth) - left - right - prefixWidth(block)
            if (available <= 0) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "${block.source?.let { "$it: " }.orEmpty()}Section padding consumes its width")
            var emittedForBlock = 0
            fun emit(lines: List<PresentationLine>, continuationIndent: Int) {
                rendered += lines.mapIndexed { index, line ->
                    val continuation = if (index > 0) continuationIndent else 0
                    val prefix = if (emittedForBlock == 0 && index == 0) block.firstPrefix else block.continuationPrefix
                    if (prefix.isEmpty()) {
                        appendRightPadding(indentLine(line, left + continuation), right)
                    } else {
                        appendRightPadding(decorateLine(line, themeLeft, prefix, sectionLeft + continuation), right)
                    }
                }
                emittedForBlock += lines.size
            }
            fun wrap(runs: List<PresentationTextRun>): List<PresentationLine> {
                val remainingLines = policy.maximumLines - emittedForBlock
                if (remainingLines <= 0) {
                    throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "$name exceeds ${policy.maximumLines} lines")
                }
                return try {
                    layouter.wrap(
                        runs,
                        available,
                        remainingLines,
                        policy.overflow,
                        preserveExplicitLines = false,
                        continuationIndentPixels = policy.continuationIndentPixels,
                    )
                } catch (exception: TextLayoutException) {
                    val source = block.source ?: throw exception
                    throw TextLayoutException(exception.fallbackCode, "$source: ${exception.message}", exception.capacity)
                }
            }
            when (block.kind) {
                SemanticBlockKind.RULE -> emit(listOf(renderRule(block, available)), 0)
                SemanticBlockKind.ROW -> renderRow(block, available, policy, flow, ::wrap, ::emit)
                else -> {
                    val logicalLines = if (policy.preserveExplicitLines) block.lines else listOf(joinExplicitLines(block.lines))
                    logicalLines.forEach { explicitLine ->
                        val withIconGap = addIconGap(explicitLine.values, flow)
                        val aligned = if (flow?.fieldValueAlignment == FieldValueAlignment.RIGHT && block.kind == SemanticBlockKind.FIELD) {
                            alignFieldValue(withIconGap, available)
                        } else {
                            withIconGap.map(StyledRun::run)
                        }
                        emit(wrap(aligned), policy.continuationIndentPixels)
                    }
                }
            }
            block.source?.let { contributors.merge(it, emittedForBlock + block.gapBeforeLines, Int::plus) }
            if (flow != null && blockIndex < blocks.lastIndex) {
                appendVerticalGap(rendered, flow.blockGapAfterPixels, blocks[blockIndex + 1].gapPrefix)
            }
        }
        lineContributors = contributors.entries.sortedByDescending { it.value }.map { it.key to it.value }
        if (rendered.size > catalog.budgets.maximumLines) {
            throw TextLayoutException(
                ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED,
                "Lore exceeds ${catalog.budgets.maximumLines} lines${contributorSuffix()}",
                capacity = true,
            )
        }
        val natural = rendered.maxOfOrNull(PresentationLine::logicalWidthPixels) ?: 0
        return FlowResult(rendered, boundaries, max(targetWidth, natural).coerceIn(minimumWidth, maximumWidth))
    }

    /** Section padding: rules span the whole content width, descriptions use their own padding. */
    private fun sectionPadding(flow: LayoutSource.Flow?, block: StyledBlock): Pair<Int, Int> = when {
        flow == null || block.kind == SemanticBlockKind.RULE -> 0 to 0
        block.lines.firstOrNull()?.runs?.any { it.kind == PresentationRunKind.ICON } == true -> flow.fieldLeftPaddingPixels to 0
        block.kind == SemanticBlockKind.DESCRIPTION -> flow.descriptionLeftPaddingPixels to flow.descriptionRightPaddingPixels
        else -> flow.fieldLeftPaddingPixels to 0
    }

    private fun rowRegions(block: StyledBlock): Pair<List<StyledLine>, List<StyledRun>> {
        val left = block.lines.map { line -> StyledLine(line.values.filterNot(StyledRun::rightRegion)) }
            .filter { it.values.isNotEmpty() }
        return left to block.lines.flatMap { line -> line.values.filter(StyledRun::rightRegion) }
    }

    /** Both regions on one line with the minimum gap, or the wider region when they cannot share one. */
    private fun rowWidth(block: StyledBlock, flow: LayoutSource.Flow?): Int? {
        val (left, right) = rowRegions(block)
        if (left.isEmpty() && right.isEmpty()) return null
        val leftWidth = left.maxOfOrNull { measurer.measure(addIconGap(it.values, flow).map(StyledRun::run)).logicalWidthPixels } ?: 0
        if (right.isEmpty()) return leftWidth
        val rightRuns = right.map(StyledRun::run)
        val rightWidth = measurer.measure(rightRuns).logicalWidthPixels
        if (left.isEmpty()) return rightWidth
        return leftWidth + rowGap(rightRuns) + rightWidth
    }

    private fun rowGap(right: List<PresentationTextRun>): Int {
        val style = right.first().style.copy(bold = false, italic = false)
        return measurer.measure(listOf(PresentationTextRun(" ", style, unbreakable = true))).logicalWidthPixels
    }

    /**
     * A row's right region ends exactly at the content edge. When both regions cannot share one
     * line, the left region wraps and the right region takes its own line, still right-aligned.
     */
    private fun renderRow(
        block: StyledBlock,
        available: Int,
        policy: WrappingSource,
        flow: LayoutSource.Flow?,
        wrap: (List<PresentationTextRun>) -> List<PresentationLine>,
        emit: (List<PresentationLine>, Int) -> Unit,
    ) {
        val (leftLines, right) = rowRegions(block)
        val logical = if (policy.preserveExplicitLines) leftLines else listOfNotNull(leftLines.takeIf { it.isNotEmpty() }?.let(::joinExplicitLines))
        val leftRuns = logical.map { addIconGap(it.values, flow).map(StyledRun::run) }
        val rightRuns = right.map(StyledRun::run)
        val rightWidth = measurer.measure(rightRuns).logicalWidthPixels
        val single = leftRuns.singleOrNull()
        if (logical.size <= 1) {
            val leftWidth = single?.let { measurer.measure(it).logicalWidthPixels } ?: 0
            val gap = if (single != null && rightRuns.isNotEmpty()) rowGap(rightRuns) else 0
            if (leftWidth + gap + rightWidth <= available) {
                val runs = single.orEmpty() + if (rightRuns.isEmpty()) {
                    emptyList()
                } else {
                    exactPadding(available - leftWidth - rightWidth, rightRuns.first().style) + rightRuns
                }
                emit(wrap(runs), 0)
                return
            }
        }
        leftRuns.forEach { runs -> emit(wrap(runs), policy.continuationIndentPixels) }
        if (rightRuns.isEmpty()) return
        val aligned = if (rightWidth <= available) exactPadding(available - rightWidth, rightRuns.first().style) + rightRuns else rightRuns
        emit(wrap(aligned), policy.continuationIndentPixels)
    }

    private val ruleRole: String = theme.source.rules?.style ?: "rule"

    private fun ruleFill(): List<PresentationTextRun> = pieceRuns(theme.source.rules?.fill ?: DEFAULT_RULE_FILL, ruleRole)

    private fun ruleCaps(): List<PresentationTextRun> =
        listOfNotNull(theme.source.rules?.left, theme.source.rules?.right).flatMap { pieceRuns(it, ruleRole) }

    /** A titled rule needs room for its title and one fill unit on each side; a bare rule stretches. */
    private fun ruleWidth(block: StyledBlock): Int? {
        val title = block.lines.flatMap(StyledLine::runs)
        if (title.isEmpty()) return null
        val gap = theme.source.rules?.titleGapPixels ?: DEFAULT_RULE_TITLE_GAP_PIXELS
        return measurer.measure(ruleCaps()).logicalWidthPixels + measurer.measure(title).logicalWidthPixels +
            2 * gap + 2 * measurer.measure(ruleFill()).logicalWidthPixels
    }

    /**
     * A horizontal rule across [available] pixels. Fill units repeat whole; the remainder becomes
     * exact padding beside the title, or at the end of an untitled rule, so the line ends exactly
     * at the content edge without stretching any glyph.
     */
    private fun renderRule(block: StyledBlock, available: Int): PresentationLine {
        val rules = theme.source.rules
        val fill = ruleFill().single()
        val fillWidth = measurer.measure(listOf(fill)).logicalWidthPixels
        val subject = block.source?.let { "Rule $it" } ?: "Rule"
        if (fillWidth <= 0) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "$subject fill must have a positive advance")
        val leftCap = rules?.left?.let { pieceRuns(it, ruleRole) }.orEmpty()
        val rightCap = rules?.right?.let { pieceRuns(it, ruleRole) }.orEmpty()
        val caps = measurer.measure(leftCap + rightCap).logicalWidthPixels
        val paddingStyle = style(ruleRole, theme.fonts.getValue("text"))
        fun fillRuns(count: Int) = if (count <= 0) emptyList() else listOf(fill.copy(text = fill.text.repeat(count)))
        val title = block.lines.flatMap(StyledLine::runs)
        if (title.isEmpty()) {
            val space = available - caps
            if (space < fillWidth) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "$subject has no room for its fill")
            val count = space / fillWidth
            return measurer.measure(leftCap + fillRuns(count) + rightCap + exactPadding(space - count * fillWidth, paddingStyle))
        }
        val gap = rules?.titleGapPixels ?: DEFAULT_RULE_TITLE_GAP_PIXELS
        val titleRoom = available - caps - 2 * gap - 2 * fillWidth
        if (titleRoom <= 0) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "$subject has no room for its title")
        val fitted = layouter.ellipsizeLine(title, titleRoom)
        val space = available - caps - 2 * gap - fitted.logicalWidthPixels
        val leading = (space / 2) / fillWidth
        val trailing = (space - leading * fillWidth) / fillWidth
        val remainder = space - (leading + trailing) * fillWidth
        val before = remainder / 2
        return measurer.measure(
            leftCap + fillRuns(leading) + exactPadding(gap + before, paddingStyle) + fitted.runs +
                exactPadding(gap + remainder - before, paddingStyle) + fillRuns(trailing) + rightCap,
        )
    }

    /** One authored text or glyph piece in [role]'s style. */
    private fun pieceRuns(source: MarkerPieceSource, role: String): List<PresentationTextRun> = when (source) {
        is MarkerPieceSource.Text -> listOf(PresentationTextRun(source.text, style(role, theme.fonts.getValue("text")), PresentationRunKind.TEXT, unbreakable = true))
        is MarkerPieceSource.Glyph -> {
            val glyph = requireNotNull(catalog.glyphs[source.glyph]) { "Unknown glyph ${source.glyph}" }
            listOf(
                PresentationTextRun(
                    String(Character.toChars(glyph.codePoint)),
                    style(role, glyph.font).copy(bold = false, italic = false),
                    PresentationRunKind.TEXT,
                    unbreakable = true,
                ),
            )
        }
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
        if (pixels <= 0) return emptyList()
        if (theme.source.requiresResourcePack && catalog.spacing != null) {
            return spacingRuns(pixels, PresentationRunKind.WIDTH_ANCHOR)
        }

        // The supported clients give bold U+200C an exact one-pixel advance while the
        // glyph remains inkless. This lets the resource-pack-free renderer enforce
        // an exact tooltip minimum width without visible filler characters.
        val unit = PresentationTextRun(
            text = ZERO_WIDTH_NON_JOINER,
            style = textStyle.copy(bold = true),
            kind = PresentationRunKind.WIDTH_ANCHOR,
            unbreakable = true,
        )
        val measuredUnit = measurer.measure(listOf(unit))
        if (measuredUnit.logicalWidthPixels != 1 || measuredUnit.visualBounds.bottom > measuredUnit.visualBounds.top) {
            throw TextLayoutException(ThemeFallbackCode.MISSING_GLYPH, "The vanilla one-pixel width anchor metric is unavailable")
        }
        return listOf(unit.copy(text = ZERO_WIDTH_NON_JOINER.repeat(pixels)))
    }

    private fun addIconGap(values: List<StyledRun>, flow: LayoutSource.Flow?): List<StyledRun> {
        if (flow == null || values.firstOrNull()?.run?.kind != PresentationRunKind.ICON) return values
        val first = values.first()
        // A fixed icon slot pads narrower icons so every label starts in the same column.
        val slot = flow.fieldIconSlotPixels?.let { slot ->
            exactPadding(slot - measurer.measure(listOf(first.run)).logicalWidthPixels, style(first.role, theme.fonts.getValue("text")))
        }.orEmpty()
        val gap = (slot + paddingRuns(flow.fieldIconGapPixels, first.run.style)).map { run ->
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

    private fun appendVerticalGap(output: MutableList<PresentationLine>, pixels: Int, prefix: List<MarkerPiece>) {
        repeat(pixels / TOOLTIP_LINE_HEIGHT_PIXELS) { output += gapLine(prefix) }
    }

    /** An empty line that keeps the connectors of its decorated ancestors continuous. */
    private fun gapLine(prefix: List<MarkerPiece>): PresentationLine {
        val visible = prefix.dropLastWhile(MarkerPiece::blank)
        if (visible.isEmpty()) return measurer.measure(emptyList())
        return measurer.measure(paddingRuns(theme.source.content?.leftPaddingPixels ?: 0, markerStyle) + prefixRuns(visible))
    }

    /** Places marker runs after the theme's content inset and before section padding and text. */
    private fun decorateLine(line: PresentationLine, themeLeft: Int, prefix: List<MarkerPiece>, innerPixels: Int): PresentationLine {
        val style = line.runs.firstOrNull()?.style ?: style("value", theme.fonts.getValue("text"))
        return measurer.measure(paddingRuns(themeLeft, style) + prefixRuns(prefix) + paddingRuns(innerPixels, style) + line.runs)
    }

    private fun prefixWidth(block: StyledBlock): Int {
        if (block.firstPrefix.isEmpty() && block.continuationPrefix.isEmpty()) return 0
        return max(
            measurer.measure(prefixRuns(block.firstPrefix)).logicalWidthPixels,
            measurer.measure(prefixRuns(block.continuationPrefix)).logicalWidthPixels,
        )
    }

    private fun prefixRuns(prefix: List<MarkerPiece>): List<PresentationTextRun> = prefix.flatMap(::markerRuns)

    private val markerRole: String = theme.source.markers?.style ?: "label"
    private val markerStyle: PresentationTextStyle by lazy(LazyThreadSafetyMode.NONE) { style(markerRole, theme.fonts.getValue("text")) }
    private val markerPieces = java.util.EnumMap<MarkerPiece, List<PresentationTextRun>>(MarkerPiece::class.java)

    /**
     * One piece padded to its kind's slot width, so siblings align whatever the glyph widths are.
     * Blank pieces are pure padding of that width.
     */
    private fun markerRuns(piece: MarkerPiece): List<PresentationTextRun> = markerPieces.getOrPut(piece) {
        val art = markerArt(piece)
        art + markerPadding(slotWidth(piece) - measurer.measure(art).logicalWidthPixels)
    }

    private fun slotWidth(piece: MarkerPiece): Int = (theme.source.markers?.gapPixels ?: 0) + when (piece) {
        MarkerPiece.BULLET, MarkerPiece.BULLET_BLANK -> measurer.measure(markerArt(MarkerPiece.BULLET)).logicalWidthPixels
        MarkerPiece.TREE_BRANCH, MarkerPiece.TREE_LAST, MarkerPiece.TREE_VERTICAL, MarkerPiece.TREE_BLANK ->
            listOf(MarkerPiece.TREE_BRANCH, MarkerPiece.TREE_LAST, MarkerPiece.TREE_VERTICAL)
                .maxOf { measurer.measure(markerArt(it)).logicalWidthPixels }
    }

    private fun markerArt(piece: MarkerPiece): List<PresentationTextRun> {
        val markers = theme.source.markers
        val source = when (piece) {
            MarkerPiece.BULLET -> markers?.bullet ?: DEFAULT_BULLET
            MarkerPiece.TREE_BRANCH -> markers?.tree?.branch ?: DEFAULT_TREE_BRANCH
            MarkerPiece.TREE_LAST -> markers?.tree?.last ?: DEFAULT_TREE_LAST
            MarkerPiece.TREE_VERTICAL -> markers?.tree?.vertical ?: DEFAULT_TREE_VERTICAL
            MarkerPiece.BULLET_BLANK, MarkerPiece.TREE_BLANK -> return emptyList()
        }
        return when (source) {
            is MarkerPieceSource.Text -> listOf(PresentationTextRun(source.text, markerStyle, PresentationRunKind.TEXT, unbreakable = true))
            is MarkerPieceSource.Glyph -> {
                val glyph = requireNotNull(catalog.glyphs[source.glyph]) { "Unknown glyph ${source.glyph}" }
                listOf(
                    PresentationTextRun(
                        String(Character.toChars(glyph.codePoint)),
                        style(markerRole, glyph.font).copy(bold = false, italic = false),
                        PresentationRunKind.TEXT,
                        unbreakable = true,
                    ),
                )
            }
        }
    }

    /**
     * Exact-width marker padding. Resource-pack themes use signed spacing; otherwise whole spaces
     * are completed with the one-pixel width anchor so continuation lines align to the pixel.
     */
    private fun markerPadding(pixels: Int): List<PresentationTextRun> = exactPadding(pixels, markerStyle)

    /**
     * Exact-width padding. Resource-pack themes use signed spacing; otherwise whole spaces are
     * completed with the one-pixel width anchor.
     */
    private fun exactPadding(pixels: Int, textStyle: PresentationTextStyle): List<PresentationTextRun> {
        if (pixels <= 0) return emptyList()
        if (theme.source.requiresResourcePack && catalog.spacing != null) {
            return spacingRuns(pixels, PresentationRunKind.SPACING)
        }
        val plain = textStyle.copy(bold = false, italic = false, underlined = false, strikethrough = false)
        val spaces = boundedPaddingRuns(pixels, plain)
        return spaces + exactWidthAnchorRuns(pixels - measurer.measure(spaces).logicalWidthPixels, plain)
    }

    private fun appendRightPadding(line: PresentationLine, pixels: Int): PresentationLine {
        if (pixels <= 0) return line
        val textStyle = line.runs.lastOrNull()?.style ?: style("value", theme.fonts.getValue("text"))
        return measurer.measure(line.runs + paddingRuns(pixels, textStyle))
    }

    private fun boundedPaddingRuns(pixels: Int, textStyle: PresentationTextStyle): List<PresentationTextRun> {
        if (pixels <= 0) return emptyList()
        if (theme.source.requiresResourcePack && catalog.spacing != null) {
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
        if (flow.lines.size > frame.maximumLines) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Character frame line count exceeded${contributorSuffix()}", capacity = true)
        }
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
        val textFont = content.runs.firstOrNull()?.style?.font ?: theme.fonts.getValue("text")
        val paddingStyle = style("value", textFont).copy(bold = false, italic = false)
        val space = PresentationTextRun(" ", paddingStyle, PresentationRunKind.TEXT, true)
        val spaceWidth = measurer.measure(listOf(space)).logicalWidthPixels.coerceAtLeast(1)
        val leftCount = ceil(frame.leftPaddingPixels.toDouble() / spaceWidth).toInt()
        val base = listOf(edge, space.copy(text = " ".repeat(leftCount))) + content.runs
        val withoutRight = measurer.measure(base + edge).logicalWidthPixels
        val rightNeed = max(frame.rightPaddingPixels, target - withoutRight)
        val rightCount = ceil(rightNeed.toDouble() / spaceWidth).toInt()
        val result = measurer.measure(base + space.copy(text = " ".repeat(rightCount)) + edge)
        if (kotlin.math.abs(result.logicalWidthPixels - target) > frame.alignmentTolerancePixels) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Character frame cannot meet its alignment tolerance")
        }
        return result
    }

    private fun renderSegmentedFrame(layout: CompiledLayout, blocks: List<StyledBlock>, name: PresentationLine): AnchoredFlow {
        val frame = requireNotNull(theme.source.segmentedFrame)
        if (frame.includeName || listOfNotNull(frame.top, frame.body, frame.connector, frame.bottom).any { it.center != null || it.kern != null }) {
            return renderDecoratedFrame(layout, blocks, name, frame)
        }
        val contentMaximum = frame.maximumWidthPixels - frame.leftPaddingPixels - frame.rightPaddingPixels - 8
        val flow = renderFlow(layout, blocks, contentMaximum)
        val target = max(frame.minimumWidthPixels, flow.targetWidth + frame.leftPaddingPixels + frame.rightPaddingPixels + 8)
        if (target > frame.maximumWidthPixels) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Segmented frame width exceeded")
        val output = ArrayList<PresentationLine>()
        output += segmentedBorder(frame.top, target)
        flow.lines.forEachIndexed { index, line ->
            if (index in flow.sectionBoundaries && frame.connector != null) output += segmentedBorder(frame.connector, target)
            output += segmentedBody(frame.body, line, target, frame.leftPaddingPixels, frame.rightPaddingPixels)
        }
        output += segmentedBorder(frame.bottom, target)
        return AnchoredFlow(name, output)
    }

    private data class FrameStrip(
        val left: PresentationTextRun,
        val fill: PresentationTextRun,
        val right: PresentationTextRun,
        val center: PresentationTextRun?,
        val leftWidth: Int,
        val rightWidth: Int,
        val centerWidth: Int,
        val fillWidth: Int,
    ) {
        val fixed: Int get() = leftWidth + rightWidth + centerWidth
        fun fits(width: Int): Boolean = width >= fixed && (width - fixed) % fillWidth == 0
    }

    private fun frameStrip(row: FrameRowSource): FrameStrip {
        val kern = row.kern?.let { assetRun(it, PresentationRunKind.FRAME) }
        fun piece(id: String): PresentationTextRun {
            val run = assetRun(id, PresentationRunKind.FRAME)
            if (kern == null) return run
            if (run.style != kern.style) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Frame pieces and kern must share a font and style")
            return run.copy(text = run.text + kern.text)
        }
        val left = piece(row.left)
        val fill = piece(row.fill)
        val right = piece(row.right)
        val center = row.center?.let(::piece)
        fun width(run: PresentationTextRun): Int = measurer.measure(listOf(run)).logicalWidthPixels.also {
            if (it <= 0) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Frame pieces must have positive net advance")
        }
        return FrameStrip(left, fill, right, center, width(left), width(right), center?.let(::width) ?: 0, width(fill))
    }

    private fun stripRuns(strip: FrameStrip, target: Int): List<PresentationTextRun> {
        if (!strip.fits(target)) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Frame pieces cannot exactly cover the target width")
        val count = (target - strip.fixed) / strip.fillWidth
        if (count.toLong() * strip.fill.text.codePointCount(0, strip.fill.text.length) > catalog.budgets.maximumTextCodePoints ||
            count.toLong() * strip.fill.text.length > MAX_PRESENTATION_LINE_UTF16
        ) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Frame fill exceeds the text budget")
        }
        val leading = if (strip.center == null) count else ((target - strip.centerWidth) / 2.0 - strip.leftWidth)
            .div(strip.fillWidth).let { kotlin.math.floor(it + 0.5).toInt().coerceIn(0, count) }
        return buildList {
            add(strip.left)
            if (leading > 0) add(strip.fill.copy(text = strip.fill.text.repeat(leading)))
            strip.center?.let(::add)
            if (count > leading) add(strip.fill.copy(text = strip.fill.text.repeat(count - leading)))
            add(strip.right)
        }
    }

    private fun decoratedRow(strip: FrameStrip, target: Int, content: PresentationLine?, frame: SegmentedFrameSource, contentStrip: FrameStrip = strip): PresentationLine {
        val background = stripRuns(strip, target)
        val runs = if (content == null) background else {
            val interior = target - contentStrip.leftWidth - contentStrip.rightWidth
            val remaining = interior - frame.leftPaddingPixels - content.logicalWidthPixels
            if (remaining < frame.rightPaddingPixels) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Segmented content exceeds its frame")
            background + spacingRuns(contentStrip.leftWidth + frame.leftPaddingPixels - target, PresentationRunKind.SPACING) +
                content.runs + spacingRuns(remaining + contentStrip.rightWidth, PresentationRunKind.WIDTH_ANCHOR)
        }
        return measurer.measure(runs).also {
            if (it.logicalWidthPixels != target) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Frame did not preserve its exact target width")
        }
    }

    private fun renderDecoratedFrame(layout: CompiledLayout, blocks: List<StyledBlock>, name: PresentationLine, frame: SegmentedFrameSource): AnchoredFlow {
        val top = frameStrip(frame.top)
        val body = frameStrip(frame.body)
        val connector = frame.connector?.let(::frameStrip)
        val bottom = frameStrip(frame.bottom)
        val strips = listOfNotNull(top, body, connector, bottom)
        val maximum = minOf(frame.maximumWidthPixels, catalog.budgets.maximumWidthPixels)
        val maximumTarget = (maximum downTo frame.minimumWidthPixels).firstOrNull { target -> strips.all { it.fits(target) } }
            ?: throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Frame rows have no common exact width within their bounds")
        val padding = frame.leftPaddingPixels.toLong() + frame.rightPaddingPixels
        fun available(strip: FrameStrip): Int = (maximumTarget.toLong() - strip.leftWidth - strip.rightWidth - padding).let {
            if (it < 1) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Frame has no space for text")
            it.toInt()
        }
        val bodyAvailable = available(body)
        val contentMinimum = maxOf((layout as? CompiledLayout.Flow)?.source?.minimumWidthPixels ?: 1, theme.source.content?.minimumWidthPixels ?: 1)
        if (contentMinimum > bodyAvailable) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Layout minimum width exceeds the frame content area")
        val flow = renderFlow(layout, blocks, bodyAvailable)
        val fittedName = if (frame.includeName) layouter.ellipsizeLine(name.runs, available(body)) else name
        val needed = maxOf(frame.minimumWidthPixels.toLong(), flow.targetWidth.toLong() + body.leftWidth + body.rightWidth + padding,
            if (frame.includeName) fittedName.logicalWidthPixels.toLong() + body.leftWidth + body.rightWidth + padding else 0L)
        if (needed > maximumTarget) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Frame content cannot fit its maximum width")
        val target = (needed.toInt()..maximumTarget).firstOrNull { width -> strips.all { it.fits(width) } }
            ?: throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Frame rows have no common exact width")
        val framedName = if (frame.includeName) decoratedRow(top, target, fittedName, frame, body) else name
        val output = buildList {
            if (!frame.includeName) add(decoratedRow(top, target, null, frame))
            flow.lines.forEachIndexed { index, line ->
                if (index in flow.sectionBoundaries && connector != null) add(decoratedRow(connector, target, null, frame))
                add(decoratedRow(body, target, line, frame))
            }
            add(decoratedRow(bottom, target, null, frame))
        }
        return AnchoredFlow(framedName, output)
    }

    private fun segmentedBorder(row: FrameRowSource, target: Int): PresentationLine {
        val left = assetRun(row.left, PresentationRunKind.FRAME)
        val fill = assetRun(row.fill, PresentationRunKind.FRAME)
        val right = assetRun(row.right, PresentationRunKind.FRAME)
        val fixed = measurer.measure(listOf(left, right)).logicalWidthPixels
        val unit = measurer.measure(listOf(fill)).logicalWidthPixels.coerceAtLeast(1)
        val count = ceil((target - fixed).coerceAtLeast(0).toDouble() / unit).toInt()
        val runs = listOf(left, fill.copy(text = fill.text.repeat(count)), right)
        val line = measurer.measure(runs)
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
        val left = assetRun(row.left, PresentationRunKind.FRAME)
        val fill = assetRun(row.fill, PresentationRunKind.FRAME)
        val right = assetRun(row.right, PresentationRunKind.FRAME)
        val leftWidth = measurer.measure(listOf(left)).logicalWidthPixels
        val rightWidth = measurer.measure(listOf(right)).logicalWidthPixels
        val interiorWidth = target - leftWidth - rightWidth
        val fillUnit = measurer.measure(listOf(fill)).logicalWidthPixels.coerceAtLeast(1)
        if (interiorWidth < 0 || interiorWidth % fillUnit != 0) {
            throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Segmented body fill cannot exactly cover its interior")
        }
        val fillRun = fill.copy(text = fill.text.repeat(interiorWidth / fillUnit))
        val contentWidth = content.logicalWidthPixels
        val remaining = interiorWidth - leftPadding - contentWidth
        if (remaining < rightPadding) throw TextLayoutException(ThemeFallbackCode.LAYOUT_OVERFLOW, "Segmented content exceeds its frame")
        val runs = ArrayList<PresentationTextRun>()
        runs += left
        runs += fillRun
        runs += spacingRuns(-interiorWidth, PresentationRunKind.SPACING)
        runs += spacingRuns(leftPadding, PresentationRunKind.SPACING)
        runs += content.runs
        runs += spacingRuns(remaining, PresentationRunKind.WIDTH_ANCHOR)
        runs += right
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
        if (theme.source.requiresResourcePack && catalog.spacing != null) {
            return spacingRuns(pixels, PresentationRunKind.SPACING)
        }
        val space = PresentationTextRun(" ", textStyle.copy(bold = false, italic = false), unbreakable = true)
        val width = measurer.measure(listOf(space)).logicalWidthPixels.coerceAtLeast(1)
        return listOf(space.copy(text = " ".repeat(ceil(pixels.toDouble() / width).toInt())))
    }

    private fun indentLine(line: PresentationLine, pixels: Int): PresentationLine {
        if (pixels <= 0) return line
        val style = line.runs.firstOrNull()?.style ?: style("value", theme.fonts.getValue("text"))
        return measurer.measure(paddingRuns(pixels, style) + line.runs)
    }

    private fun validateOutput(name: PresentationLine, lore: List<PresentationLine>) {
        if (lore.size > catalog.budgets.maximumLines) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Lore line budget exceeded${contributorSuffix()}", capacity = true)
        }
        val all = listOf(name) + lore
        if (all.any { it.logicalWidthPixels > catalog.budgets.maximumWidthPixels }) {
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Line width budget exceeded")
        }
        if (all.any { line ->
                line.visualBounds.right - line.visualBounds.left > catalog.budgets.maximumWidthPixels
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
            throw TextLayoutException(ThemeFallbackCode.OUTPUT_BUDGET_EXCEEDED, "Display height budget exceeded${contributorSuffix()}", capacity = true)
        }
    }

    private data class StyledBlock(
        val lines: List<StyledLine>,
        val anchor: String?,
        val wrapping: String?,
        val sectionBoundaryBefore: Boolean,
        val kind: SemanticBlockKind,
        val firstPrefix: List<MarkerPiece>,
        val continuationPrefix: List<MarkerPiece>,
        val gapPrefix: List<MarkerPiece>,
        val gapBeforeLines: Int,
        val source: String?,
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
        val DEFAULT_BULLET = MarkerPieceSource.Text("• ")
        val DEFAULT_TREE_BRANCH = MarkerPieceSource.Text("├─ ")
        val DEFAULT_TREE_LAST = MarkerPieceSource.Text("└─ ")
        val DEFAULT_TREE_VERTICAL = MarkerPieceSource.Text("│  ")
        val DEFAULT_RULE_FILL = MarkerPieceSource.Text("─")
        const val DEFAULT_RULE_TITLE_GAP_PIXELS = 4
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
            "rule" -> "dark_gray"
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

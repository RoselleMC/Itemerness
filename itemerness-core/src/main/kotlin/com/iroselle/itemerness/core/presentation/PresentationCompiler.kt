package com.iroselle.itemerness.core.presentation

import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import java.util.TreeMap
import java.util.UUID

/** Upper bound on cases in one theme selector; selectors are evaluated for every render. */
const val MAXIMUM_THEME_SELECTOR_CASES: Int = 64

/** Upper bound on a group's gap-before-lines; each line is a full tooltip row. */
const val MAXIMUM_GROUP_GAP_LINES: Int = 16

/** Upper bound on the code points of one theme marker piece. */
const val MAXIMUM_MARKER_PIECE_CODE_POINTS: Int = 32

/** Upper bound on the fragments of one row region, rule title or name affix. */
const val MAXIMUM_FRAGMENTS_PER_REGION: Int = 32

/** Upper bound on the code points of one literal fragment; literals are punctuation, not prose. */
const val MAXIMUM_LITERAL_CODE_POINTS: Int = 64

/** Upper bound on name insets, marker gaps, rule title gaps and icon slots. */
const val MAXIMUM_DECORATION_PIXELS: Int = 64

/** Upper bound on a ranked hiding weight. */
const val MAXIMUM_HIDING_WEIGHT: Int = 1_000_000

/** Upper bound on the entries a summary slot lists before counting the rest. */
const val MAXIMUM_SLOT_ENTRIES: Int = 64

class PresentationCompiler(
    private val defaultLocale: String = "en_us",
    private val budgets: PresentationBudgets = PresentationBudgets(),
) {
    fun compile(source: PresentationSource, revision: Long = 0): PresentationCompilation {
        require(revision >= 0) { "Presentation catalog revision must not be negative" }
        val diagnostics = Diagnostics()
        val formats = collectByKey(source.formats, { it.id }, "formats", diagnostics)
        val locales = compileLocales(source.locales, diagnostics)
        val fonts = compileFonts(source.fonts, diagnostics)
        val glyphs = compileGlyphs(source.glyphs, fonts, source.bitmaps, diagnostics)
        val bitmaps = compileBitmaps(source.bitmaps, diagnostics)
        val profiles = compileAssetProfiles(source.assetProfiles, diagnostics)
        val viewerFacts = compileViewerFacts(source.viewerFacts, locales, diagnostics)
        val resourcePackBindings = compileResourcePackBindings(source.resourcePackBindings, profiles, diagnostics)
        val layouts = compileLayouts(source.layouts, diagnostics)
        val tooltipStyles = compileKeySet(source.tooltipStyles, "tooltip-styles", diagnostics)
        val spacing = compileSpacing(source.spacing, fonts, diagnostics)
        val themes = compileThemes(
            sources = source.themes,
            fonts = fonts,
            glyphs = glyphs,
            bitmaps = bitmaps,
            tooltipStyles = tooltipStyles,
            spacing = spacing,
            diagnostics = diagnostics,
        )
        val themeSelectors = compileThemeSelectors(source.themeSelectors, themes, diagnostics)
        val items = compileItems(source.items, formats, layouts, themes, themeSelectors, glyphs, diagnostics)

        validateFallbackGraph("locales", locales, { it.fallback }, diagnostics)
        validateFallbackGraph("fonts", fonts, { it.fallback }, diagnostics)
        validateFallbackGraph("asset-profiles", profiles, { it.fallback }, diagnostics)
        validateFallbackGraph("themes", themes, { it.fallback }, diagnostics)
        validateFormatGraph(formats, diagnostics)
        validateThemes(themes, diagnostics)
        validateItemLayoutContracts(items, layouts, themes, themeSelectors, diagnostics)
        validateItemFactReferences(items, viewerFacts, diagnostics)
        validateThemeSelectorFactReferences(themeSelectors, viewerFacts, diagnostics)
        validateMessages(items, formats, layouts, locales, diagnostics)

        if (defaultLocale !in locales) {
            diagnostics.add(
                PresentationDiagnosticCode.MISSING_REFERENCE,
                "locales",
                "Default locale $defaultLocale is not defined",
            )
        }

        val result = diagnostics.snapshot()
        if (result.isNotEmpty()) return PresentationCompilation(null, result)
        return PresentationCompilation(
            PresentationCatalogSnapshot(
                revision = revision,
                defaultLocale = defaultLocale,
                budgets = budgets,
                formats = formats,
                locales = locales,
                fonts = fonts,
                glyphs = glyphs,
                bitmaps = bitmaps,
                assetProfiles = profiles,
                viewerFacts = viewerFacts,
                resourcePackBindings = resourcePackBindings,
                layouts = layouts,
                themes = themes,
                items = items.filterValues(CompiledItemPresentation::enabled),
                validationItems = items,
                spacing = spacing,
                tooltipStyles = tooltipStyles,
                themeSelectors = themeSelectors,
            ),
            result,
        )
    }

    private fun compileLocales(
        sources: List<LocaleSource>,
        diagnostics: Diagnostics,
    ): Map<String, LocaleSource> {
        val result = TreeMap<String, LocaleSource>()
        sources.forEachIndexed { index, source ->
            val path = "locales[$index]"
            if (!LOCALE_PATTERN.matches(source.locale)) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_ID, "$path.locale", "Invalid locale ${source.locale}")
                return@forEachIndexed
            }
            if (result.putIfAbsent(source.locale, source) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Duplicate locale ${source.locale}")
            }
            source.messages.forEach { (key, value) ->
                if (!MESSAGE_PATTERN.matches(key)) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_ID, "$path.messages.$key", "Invalid message key $key")
                }
                validateText(value, "$path.messages.$key", diagnostics)
            }
        }
        sources.forEachIndexed { index, source ->
            if (source.fallback != null && source.fallback !in result) {
                diagnostics.add(
                    PresentationDiagnosticCode.MISSING_REFERENCE,
                    "locales[$index].fallback",
                    "Unknown locale ${source.fallback}",
                )
            }
        }
        return result
    }

    private fun compileFonts(
        sources: List<FontSource>,
        diagnostics: Diagnostics,
    ): Map<ItemKey, CompiledFont> {
        val result = TreeMap<ItemKey, CompiledFont>()
        sources.forEachIndexed { index, source ->
            val path = "fonts[$index]"
            val id = parseKey(source.id, "$path.id", diagnostics) ?: return@forEachIndexed
            val revision = parseKey(source.metricsRevision, "$path.metrics-revision", diagnostics) ?: return@forEachIndexed
            val fallback = source.fallback?.let { parseKey(it, "$path.fallback", diagnostics) }
            if (source.fallbackAdvancePixels != null && !validAdvance(source.fallbackAdvancePixels)) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.fallback-advance", "Invalid fallback advance")
            }
            if (!validAdvance(source.boldExtraAdvancePixels) || source.boldExtraAdvancePixels < 0) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.bold-extra-advance", "Invalid bold advance")
            }
            source.fallbackGlyph?.let { validateMetric(it, "$path.fallback-glyph", diagnostics) }
            source.glyphs.forEach { (codePoint, metric) ->
                if (!Character.isValidCodePoint(codePoint) || codePoint in 0xD800..0xDFFF) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.glyphs.$codePoint", "Invalid Unicode code point")
                }
                validateMetric(metric, "$path.glyphs.$codePoint", diagnostics)
            }
            if (result.putIfAbsent(
                    id,
                    CompiledFont(
                        id,
                        revision,
                        java.util.Map.copyOf(source.glyphs),
                        fallback,
                        source.fallbackAdvancePixels,
                        source.boldExtraAdvancePixels,
                        source.fallbackGlyph,
                    ),
                ) != null
            ) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Duplicate font $id")
            }
        }
        result.values.forEach { font ->
            if (font.fallback != null && font.fallback !in result) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "fonts.${font.id}.fallback", "Unknown font ${font.fallback}")
            }
        }
        return result
    }

    private fun compileGlyphs(
        sources: List<GlyphSource>,
        fonts: Map<ItemKey, CompiledFont>,
        bitmapSources: List<BitmapSource>,
        diagnostics: Diagnostics,
    ): Map<String, CompiledGlyph> {
        val bitmaps = bitmapSources.mapTo(HashSet()) { it.id }
        val result = TreeMap<String, CompiledGlyph>()
        sources.forEachIndexed { index, source ->
            val path = "glyphs[$index]"
            if (!SEMANTIC_PATTERN.matches(source.id)) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_ID, "$path.id", "Invalid semantic glyph id ${source.id}")
                return@forEachIndexed
            }
            val font = parseKey(source.font, "$path.font", diagnostics) ?: return@forEachIndexed
            if (font !in fonts) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.font", "Unknown font $font")
            }
            if (!Character.isValidCodePoint(source.codePoint) || source.codePoint in 0xD800..0xDFFF) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.codepoint", "Invalid Unicode code point")
            }
            if (!validAdvance(source.advancePixels)) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.advance", "Invalid glyph advance")
            }
            validateBounds(source.visualBounds, "$path.visual-bounds", diagnostics)
            if (source.bitmap != null && source.bitmap !in bitmaps) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.bitmap", "Unknown bitmap ${source.bitmap}")
            }
            val compiled = CompiledGlyph(
                source.id,
                font,
                source.codePoint,
                source.advancePixels,
                source.visualBounds,
                source.bitmap,
            )
            if (result.putIfAbsent(source.id, compiled) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Duplicate glyph ${source.id}")
            }
        }
        return result
    }

    private fun compileBitmaps(
        sources: List<BitmapSource>,
        diagnostics: Diagnostics,
    ): Map<String, BitmapSource> {
        val result = collectSemantic(sources, { it.id }, "bitmaps", diagnostics)
        sources.forEachIndexed { index, bitmap ->
            val path = "bitmaps[$index]"
            if (bitmap.renderWidthPixels !in 1..budgets.maximumWidthPixels) {
                diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$path.render-width", "Bitmap width exceeds hard limits")
            }
            if (bitmap.renderHeightPixels !in 1..budgets.maximumHeightPixels) {
                diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$path.render-height", "Bitmap height exceeds hard limits")
            }
            if (bitmap.ascentPixels !in 0..bitmap.renderHeightPixels) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.ascent", "Bitmap ascent is outside its rendered cell")
            }
            validateBounds(bitmap.visualBounds, "$path.visual-bounds", diagnostics)
            if (bitmap.visualBounds.right - bitmap.visualBounds.left > budgets.maximumWidthPixels ||
                bitmap.visualBounds.bottom - bitmap.visualBounds.top > budgets.maximumHeightPixels
            ) {
                diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$path.visual-bounds", "Bitmap visual bounds exceed hard limits")
            }
        }
        return result
    }

    private fun compileAssetProfiles(
        sources: List<AssetProfileSource>,
        diagnostics: Diagnostics,
    ): Map<ItemKey, CompiledAssetProfile> {
        val result = TreeMap<ItemKey, CompiledAssetProfile>()
        sources.forEachIndexed { index, source ->
            val path = "asset-profiles[$index]"
            val id = parseKey(source.id, "$path.id", diagnostics) ?: return@forEachIndexed
            val capabilities = source.capabilities.mapNotNullTo(sortedSetOf()) {
                parseKey(it, "$path.capabilities", diagnostics)
            }
            val revision = source.metricsRevision?.let { parseKey(it, "$path.metrics-revision", diagnostics) }
            val fallback = source.fallback?.let { parseKey(it, "$path.fallback", diagnostics) }
            if (result.putIfAbsent(id, CompiledAssetProfile(id, capabilities, revision, fallback)) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Duplicate asset profile $id")
            }
        }
        result.values.forEach { profile ->
            if (profile.fallback != null && profile.fallback !in result) {
                diagnostics.add(
                    PresentationDiagnosticCode.MISSING_REFERENCE,
                    "asset-profiles.${profile.id}.fallback",
                    "Unknown asset profile ${profile.fallback}",
                )
            }
        }
        return result
    }

    private fun compileViewerFacts(
        sources: List<ViewerFactSource>,
        locales: Map<String, LocaleSource>,
        diagnostics: Diagnostics,
    ): Map<ItemKey, ViewerFactDefinition> {
        val result = TreeMap<ItemKey, ViewerFactDefinition>()
        sources.forEachIndexed { index, source ->
            val path = "viewer-facts[$index]"
            val id = parseKey(source.id, "$path.id", diagnostics) ?: return@forEachIndexed
            if (source.providers.isEmpty()) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.providers", "Viewer facts require at least one provider")
            }
            val seenProviders = HashSet<String>()
            source.providers.forEachIndexed { providerIndex, provider ->
                if (!SEMANTIC_PATTERN.matches(provider)) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_ID, "$path.providers[$providerIndex]", "Invalid fact provider $provider")
                }
                if (!seenProviders.add(provider)) {
                    diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, "$path.providers[$providerIndex]", "Duplicate fact provider $provider")
                }
            }
            if (source.defaultValue == null && !source.nullable) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.default", "Non-nullable viewer facts require a default")
            }
            source.defaultValue?.let { value ->
                if (!matchesFactType(source.type, value)) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.default", "Default does not match ${source.type}")
                }
                if (source.type == ViewerFactType.LOCALE) {
                    val locale = (value as? StringDataValue)?.value
                    if (locale != null && locale !in locales) {
                        diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.default", "Unknown default locale $locale")
                    }
                }
                if (value is StringDataValue && value.value.codePointCount(0, value.value.length) > budgets.maximumTextCodePoints) {
                    diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$path.default", "Fact default string exceeds hard limits")
                }
                if (value is StringDataValue && value.value.length > MAX_VIEWER_FACT_STRING_LENGTH) {
                    diagnostics.add(
                        PresentationDiagnosticCode.BUDGET_EXCEEDED,
                        "$path.default",
                        "Fact default string exceeds $MAX_VIEWER_FACT_STRING_LENGTH characters",
                    )
                }
            }
            val definition = ViewerFactDefinition(
                id,
                source.type,
                source.providers,
                source.defaultValue,
                source.nullable,
                source.cacheKey,
            )
            if (result.putIfAbsent(id, definition) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Duplicate viewer fact $id")
            }
        }
        if (result.size > MAX_VIEWER_FACTS) {
            diagnostics.add(
                PresentationDiagnosticCode.BUDGET_EXCEEDED,
                "viewer-facts",
                "Viewer facts exceed the hard limit of $MAX_VIEWER_FACTS",
            )
        }
        return result
    }

    private fun compileResourcePackBindings(
        sources: List<ResourcePackBindingSource>,
        profiles: Map<ItemKey, CompiledAssetProfile>,
        diagnostics: Diagnostics,
    ): Map<ItemKey, ResourcePackBinding> {
        val result = TreeMap<ItemKey, ResourcePackBinding>()
        val enabledPackIds = HashSet<UUID>()
        var assumedBinding: ItemKey? = null
        sources.forEachIndexed { index, source ->
            val path = "resource-pack-bindings[$index]"
            val id = parseKey(source.id, "$path.id", diagnostics) ?: return@forEachIndexed
            val profile = parseKey(source.assetProfile, "$path.asset-profile", diagnostics) ?: return@forEachIndexed
            if (profile !in profiles) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.asset-profile", "Unknown asset profile $profile")
            }
            if (source.enabled) {
                // Assumed delivery needs no client report, so its pack identity is optional; when present it is still
                // the identity used to recognise contrary evidence and must therefore be a real value.
                val identityRequired = source.delivery == ResourcePackDelivery.VERIFIED
                if (source.packId == null) {
                    if (identityRequired) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.pack-id", "Enabled bindings require a non-placeholder UUID")
                    }
                } else if (source.packId == ZERO_UUID) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.pack-id", "Enabled bindings require a non-placeholder UUID")
                } else if (!enabledPackIds.add(source.packId)) {
                    diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, "$path.pack-id", "Duplicate enabled resource-pack UUID ${source.packId}")
                }
                if (source.sha1 == null) {
                    if (identityRequired) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.sha1", "Enabled bindings require a non-placeholder 40-character SHA-1")
                    }
                } else if (!SHA1_PATTERN.matches(source.sha1) || source.sha1.all { it == '0' }) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.sha1", "Enabled bindings require a non-placeholder 40-character SHA-1")
                }
                if (source.delivery == ResourcePackDelivery.ASSUMED) {
                    val previous = assumedBinding
                    if (previous != null) {
                        // Two assumed packs would make the viewer's asset profile ambiguous.
                        diagnostics.add(
                            PresentationDiagnosticCode.INVALID_VALUE,
                            "$path.delivery",
                            "Only one enabled resource-pack binding may use assumed delivery; $previous already does",
                        )
                    } else {
                        assumedBinding = id
                    }
                }
            }
            val binding = ResourcePackBinding(id, source.enabled, source.packId, source.sha1?.lowercase(), profile, source.delivery)
            if (result.putIfAbsent(id, binding) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Duplicate resource-pack binding $id")
            }
        }
        return result
    }

    private fun compileLayouts(
        sources: List<LayoutSource>,
        diagnostics: Diagnostics,
    ): Map<ItemKey, CompiledLayout> {
        val result = TreeMap<ItemKey, CompiledLayout>()
        sources.forEachIndexed { index, source ->
            val path = "layouts[$index]"
            val id = parseKey(source.id, "$path.id", diagnostics) ?: return@forEachIndexed
            val compiled = when (source) {
                is LayoutSource.Flow -> {
                    validateWidth(source.minimumWidthPixels, source.maximumWidthPixels, "$path.content-width", diagnostics)
                    listOf(
                        source.blockGapAfterPixels,
                        source.fieldLeftPaddingPixels,
                        source.fieldIconGapPixels,
                        source.descriptionLeftPaddingPixels,
                        source.descriptionRightPaddingPixels,
                        source.descriptionGapBeforePixels,
                    ).forEachIndexed { paddingIndex, value ->
                        validateNonNegative(value, "$path.padding[$paddingIndex]", diagnostics)
                    }
                    listOf(
                        "block-gap-after" to source.blockGapAfterPixels,
                        "description-gap-before" to source.descriptionGapBeforePixels,
                    ).forEach { (name, value) ->
                        if (value % TOOLTIP_LINE_HEIGHT_PIXELS != 0) {
                            diagnostics.add(
                                PresentationDiagnosticCode.INVALID_VALUE,
                                "$path.$name",
                                "Vertical gaps must be exact multiples of $TOOLTIP_LINE_HEIGHT_PIXELS pixels",
                            )
                        }
                    }
                    if (source.fieldLeftPaddingPixels >= source.maximumWidthPixels) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.field-left-padding", "Field padding consumes the layout width")
                    }
                    if (source.descriptionLeftPaddingPixels + source.descriptionRightPaddingPixels >= source.maximumWidthPixels) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.description-padding", "Description padding consumes the layout width")
                    }
                    validateSeparator(source.fieldSeparator, "$path.sections.field.separator", diagnostics)
                    source.fieldIconSlotPixels?.let {
                        if (it !in 1..MAXIMUM_DECORATION_PIXELS) {
                            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.sections.field.icon-slot-pixels", "Icon slot must be within 1..$MAXIMUM_DECORATION_PIXELS pixels")
                        }
                    }
                    validateWrapping(source.wrapping, "$path.wrapping", diagnostics)
                    CompiledLayout.Flow(id, source)
                }

                is LayoutSource.Canvas -> {
                    validateWidth(source.widthPixels, source.maximumWidthPixels, "$path.canvas.width", diagnostics)
                    validateHeight(source.heightPixels, source.maximumHeightPixels, "$path.canvas.height", diagnostics)
                    validateLimit(source.reserveTooltipLines, budgets.maximumLines, "$path.reserve-tooltip-lines", diagnostics)
                    source.anchors.forEach { (name, anchor) ->
                        if (!SEMANTIC_PATTERN.matches(name)) {
                            diagnostics.add(PresentationDiagnosticCode.INVALID_ID, "$path.anchors.$name", "Invalid anchor id")
                        }
                        if (anchor.width <= 0 || anchor.height <= 0 || anchor.x < 0 || anchor.y < 0 ||
                            anchor.x + anchor.width > source.widthPixels || anchor.y + anchor.height > source.heightPixels
                        ) {
                            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.anchors.$name", "Anchor is outside the canvas")
                        }
                    }
                    validateWrapping(source.wrapping, "$path.wrapping", diagnostics)
                    CompiledLayout.Canvas(id, source)
                }
            }
            if (result.putIfAbsent(id, compiled) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Duplicate layout $id")
            }
        }
        return result
    }

    private fun compileSpacing(
        source: SpacingSource?,
        fonts: Map<ItemKey, CompiledFont>,
        diagnostics: Diagnostics,
    ): CompiledSpacing? {
        source ?: return null
        val font = parseKey(source.font, "spacing.font", diagnostics) ?: return null
        if (font !in fonts) {
            diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "spacing.font", "Unknown font $font")
        }
        validateSpacingRange(source.negative, true, "spacing.negative", diagnostics)
        validateSpacingRange(source.positive, false, "spacing.positive", diagnostics)
        return CompiledSpacing(font, source.negative, source.positive)
    }

    private fun compileThemes(
        sources: List<ThemeSource>,
        fonts: Map<ItemKey, CompiledFont>,
        glyphs: Map<String, CompiledGlyph>,
        bitmaps: Map<String, BitmapSource>,
        tooltipStyles: Set<ItemKey>,
        spacing: CompiledSpacing?,
        diagnostics: Diagnostics,
    ): Map<ItemKey, CompiledTheme> {
        val result = TreeMap<ItemKey, CompiledTheme>()
        sources.forEachIndexed { index, source ->
            val path = "themes[$index]"
            val id = parseKey(source.id, "$path.id", diagnostics) ?: return@forEachIndexed
            val fallback = source.fallback?.let { parseKey(it, "$path.fallback", diagnostics) }
            val capabilities = source.requiredCapabilities.mapNotNullTo(sortedSetOf()) {
                parseKey(it, "$path.required-capabilities", diagnostics)
            }
            val themeFonts = TreeMap<String, ItemKey>()
            source.fonts.forEach { (role, rawFont) ->
                if (!SEMANTIC_PATTERN.matches(role)) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_ID, "$path.fonts.$role", "Invalid font role")
                }
                parseKey(rawFont, "$path.fonts.$role", diagnostics)?.let { font ->
                    themeFonts[role] = font
                    if (font !in fonts) {
                        diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.fonts.$role", "Unknown font $font")
                    }
                }
            }
            if ("text" !in themeFonts) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.fonts", "Theme must define the text font role")
            }
            val tooltipStyle = source.tooltipStyle?.let { parseKey(it, "$path.tooltip-style", diagnostics) }
            if (tooltipStyle != null && tooltipStyle !in tooltipStyles) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.tooltip-style", "Unknown tooltip style $tooltipStyle")
            }
            source.styles.forEach { (role, style) ->
                if (!SEMANTIC_PATTERN.matches(role)) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_ID, "$path.styles.$role", "Invalid style role")
                }
                if (style.color != null && !validColor(style.color)) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.styles.$role.color", "Invalid color ${style.color}")
                }
            }
            when (source.renderer) {
                ThemeRenderer.PLAIN -> {
                    if (source.requiresResourcePack) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Plain themes cannot require a resource pack")
                    }
                    if (source.tooltipStyle != null) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.tooltip-style", "Plain themes cannot set a tooltip style")
                    }
                }

                ThemeRenderer.VANILLA_CHARACTER_FRAME -> validateCharacterFrame(source, path, diagnostics)
                ThemeRenderer.NATIVE_TOOLTIP_STYLE -> {
                    if (!source.requiresResourcePack || tooltipStyle == null) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Native tooltip themes require a resource pack and tooltip style")
                    }
                    source.content?.let {
                        validateWidth(it.minimumWidthPixels, it.maximumWidthPixels, "$path.content", diagnostics)
                        validateNonNegative(it.leftPaddingPixels, "$path.content.left-padding", diagnostics)
                        validateNonNegative(it.rightPaddingPixels, "$path.content.right-padding", diagnostics)
                        if (it.leftPaddingPixels + it.rightPaddingPixels >= it.maximumWidthPixels) {
                            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.content.padding", "Content padding consumes the available width")
                        }
                    }
                }

                ThemeRenderer.SEGMENTED_FRAME -> validateSegmentedFrame(source, path, glyphs, spacing, diagnostics)
                ThemeRenderer.BITMAP_CANVAS -> validateCanvasTheme(source, path, glyphs, bitmaps, spacing, diagnostics)
            }
            source.markers?.let { validateMarkers(it, source.requiresResourcePack, "$path.markers", glyphs, diagnostics) }
            source.rules?.let { validateRules(it, source.requiresResourcePack, "$path.rules", glyphs, diagnostics) }
            if (source.nameInsetPixels !in 0..MAXIMUM_DECORATION_PIXELS) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.name-inset-pixels", "Name inset must be within 0..$MAXIMUM_DECORATION_PIXELS pixels")
            }
            if (source.renderer in setOf(ThemeRenderer.SEGMENTED_FRAME, ThemeRenderer.BITMAP_CANVAS) &&
                source.vanillaTooltipLines != VanillaTooltipLinePolicy.REQUIRE_MANAGED
            ) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.vanilla-tooltip-lines", "Fixed geometry requires managed tooltip lines")
            }
            if (source.renderer !in setOf(ThemeRenderer.PLAIN, ThemeRenderer.VANILLA_CHARACTER_FRAME) && !source.requiresResourcePack) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "This renderer requires a resource pack")
            }
            if (result.putIfAbsent(id, CompiledTheme(id, source, fallback, capabilities, themeFonts, tooltipStyle)) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Duplicate theme $id")
            }
        }
        result.values.forEach { theme ->
            if (theme.fallback != null && theme.fallback !in result) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "themes.${theme.id}.fallback", "Unknown theme ${theme.fallback}")
            }
        }
        return result
    }

    private fun validateMarkers(
        markers: MarkerThemeSource,
        requiresResourcePack: Boolean,
        path: String,
        glyphs: Map<String, CompiledGlyph>,
        diagnostics: Diagnostics,
    ) {
        markers.style?.let { validateSemantic(it, "$path.style", diagnostics) }
        if (markers.gapPixels !in 0..MAXIMUM_DECORATION_PIXELS) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.gap-pixels", "Marker gap must be within 0..$MAXIMUM_DECORATION_PIXELS pixels")
        }
        listOf(
            "bullet" to markers.bullet,
            "tree.branch" to markers.tree?.branch,
            "tree.last" to markers.tree?.last,
            "tree.vertical" to markers.tree?.vertical,
        ).forEach { (name, piece) -> piece?.let { validatePiece(it, requiresResourcePack, "$path.$name", "Marker", glyphs, diagnostics) } }
    }

    private fun validateRules(
        rules: RuleThemeSource,
        requiresResourcePack: Boolean,
        path: String,
        glyphs: Map<String, CompiledGlyph>,
        diagnostics: Diagnostics,
    ) {
        rules.style?.let { validateSemantic(it, "$path.style", diagnostics) }
        if (rules.titleGapPixels !in 0..MAXIMUM_DECORATION_PIXELS) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.title-gap-pixels", "Rule title gap must be within 0..$MAXIMUM_DECORATION_PIXELS pixels")
        }
        listOf("fill" to rules.fill, "left" to rules.left, "right" to rules.right).forEach { (name, piece) ->
            piece?.let { validatePiece(it, requiresResourcePack, "$path.$name", "Rule", glyphs, diagnostics) }
        }
    }

    /** Marker and rule pieces share the field icon rules: glyphs need the resource pack that defines them. */
    private fun validatePiece(
        piece: MarkerPieceSource,
        requiresResourcePack: Boolean,
        piecePath: String,
        label: String,
        glyphs: Map<String, CompiledGlyph>,
        diagnostics: Diagnostics,
    ) {
        when (piece) {
            is MarkerPieceSource.Text -> {
                val length = piece.text.codePointCount(0, piece.text.length)
                if (length !in 1..MAXIMUM_MARKER_PIECE_CODE_POINTS) {
                    diagnostics.add(
                        PresentationDiagnosticCode.INVALID_VALUE,
                        piecePath,
                        "$label text must contain 1..$MAXIMUM_MARKER_PIECE_CODE_POINTS code points",
                    )
                }
                if (piece.text.codePoints().anyMatch(Character::isISOControl)) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, piecePath, "$label text contains a control character")
                }
            }
            is MarkerPieceSource.Glyph -> {
                if (!requiresResourcePack) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, piecePath, "Glyph ${if (label == "Marker") "markers" else "${label.lowercase()} pieces"} require requires-resource-pack: true")
                }
                if (piece.glyph !in glyphs) {
                    diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, piecePath, "Unknown glyph ${piece.glyph}")
                }
            }
        }
    }

    private fun compileThemeSelectors(
        sources: List<ThemeSelectorSource>,
        themes: Map<ItemKey, CompiledTheme>,
        diagnostics: Diagnostics,
    ): Map<ItemKey, CompiledThemeSelector> {
        val selectorIds = sources.mapNotNullTo(HashSet()) { runCatching { ItemKey.parse(it.id) }.getOrNull() }
        fun concreteTheme(raw: String, path: String): ItemKey? {
            val theme = parseKey(raw, path, diagnostics) ?: return null
            when {
                theme in themes -> Unit
                theme in selectorIds -> diagnostics.add(
                    PresentationDiagnosticCode.INVALID_VALUE,
                    path,
                    "Theme selector $theme cannot be chosen by another selector; reference a concrete theme",
                )
                else -> diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, path, "Unknown theme $theme")
            }
            return theme
        }
        val result = TreeMap<ItemKey, CompiledThemeSelector>()
        sources.forEachIndexed { index, source ->
            val path = "theme-selectors[$index]"
            val id = parseKey(source.id, "$path.id", diagnostics) ?: return@forEachIndexed
            if (id in themes) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Theme selector $id collides with a theme of the same id")
            }
            if (source.cases.size > MAXIMUM_THEME_SELECTOR_CASES) {
                diagnostics.add(
                    PresentationDiagnosticCode.BUDGET_EXCEEDED,
                    "$path.cases",
                    "Theme selector has ${source.cases.size} cases; maximum is $MAXIMUM_THEME_SELECTOR_CASES",
                )
            }
            val cases = source.cases.mapIndexedNotNull { caseIndex, case ->
                val casePath = "$path.cases[$caseIndex]"
                val condition = compileCondition(case.condition, "$casePath.when", diagnostics)
                val theme = concreteTheme(case.theme, "$casePath.theme")
                if (condition == null || theme == null) null else CompiledThemeSelectorCase(condition, theme)
            }
            val defaultTheme = concreteTheme(source.defaultTheme, "$path.default") ?: return@forEachIndexed
            if (result.putIfAbsent(id, CompiledThemeSelector(id, cases, defaultTheme)) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Duplicate theme selector $id")
            }
        }
        return result
    }

    private fun compileItems(
        sources: List<ItemPresentationSource>,
        formats: Map<ItemKey, FormatSource>,
        layouts: Map<ItemKey, CompiledLayout>,
        themes: Map<ItemKey, CompiledTheme>,
        themeSelectors: Map<ItemKey, CompiledThemeSelector>,
        glyphs: Map<String, CompiledGlyph>,
        diagnostics: Diagnostics,
    ): Map<ItemKey, CompiledItemPresentation> {
        val result = TreeMap<ItemKey, CompiledItemPresentation>()
        sources.forEachIndexed { index, source ->
            val path = "items[$index]"
            val key = parseKey(source.id, "$path.id", diagnostics) ?: return@forEachIndexed
            val layout = parseKey(source.layout, "$path.layout", diagnostics) ?: return@forEachIndexed
            val theme = parseKey(source.theme, "$path.theme", diagnostics) ?: return@forEachIndexed
            if (layout !in layouts) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.layout", "Unknown layout $layout")
            if (theme !in themes && theme !in themeSelectors) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.theme", "Unknown theme $theme")
            }
            validateMessageKey(source.nameMessage, "$path.name-message", diagnostics)
            val counter = BlockCounter()
            val nameBefore = compileFragments(source.nameBefore, "$path.name.before", counter, formats, glyphs, diagnostics)
            val nameAfter = compileFragments(source.nameAfter, "$path.name.after", counter, formats, glyphs, diagnostics)
            val blocks = compileBlocks(source.blocks, "$path.blocks", 1, counter, formats, glyphs, diagnostics)
            counter.summaryTargets.forEach { (slot, targetPath) ->
                if (slot !in counter.slots) {
                    diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, targetPath, "Unknown summary slot $slot")
                }
            }
            val layoutStrategy = (layouts[layout] as? CompiledLayout.Flow)?.source?.overflow ?: OverflowStrategy.FALLBACK
            val overflow = source.overflow ?: layoutStrategy
            if (overflow == OverflowStrategy.HIDE && layouts[layout] is CompiledLayout.Canvas) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.overflow", "Hiding on overflow requires a flow layout")
            }
            if (counter.count > budgets.maximumBlocksPerItem) {
                diagnostics.add(
                    PresentationDiagnosticCode.BUDGET_EXCEEDED,
                    "$path.blocks",
                    "Item has ${counter.count} blocks; maximum is ${budgets.maximumBlocksPerItem}",
                )
            }
            val shownFlags = compileShownFlags(source.shownFlags, "$path.shown-flags", diagnostics)
            val item = CompiledItemPresentation(
                key,
                source.enabled,
                layout,
                theme,
                source.nameMessage,
                blocks,
                shownFlags,
                source.marker,
                source.dividers,
                nameBefore,
                nameAfter,
                overflow,
            )
            if (result.putIfAbsent(key, item) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, path, "Duplicate item presentation $key")
            }
        }
        return result
    }

    /**
     * Shown flags are data component ids. Core deliberately knows no component vocabulary beyond
     * the projection-owned ids, so unknown components stay valid for catalogs shared across
     * Minecraft versions; the server warns about ids its own registry does not know.
     */
    private fun compileShownFlags(values: List<String>, path: String, diagnostics: Diagnostics): Set<ItemKey> {
        if (values.size > MAXIMUM_SHOWN_FLAGS) {
            diagnostics.add(
                PresentationDiagnosticCode.BUDGET_EXCEEDED,
                path,
                "Item shows ${values.size} vanilla tooltip components; maximum is $MAXIMUM_SHOWN_FLAGS",
            )
        }
        val result = sortedSetOf<ItemKey>()
        values.forEachIndexed { index, raw ->
            val valuePath = "$path[$index]"
            val key = parseKey(raw, valuePath, diagnostics) ?: return@forEachIndexed
            if (key in PROJECTION_OWNED_COMPONENTS) {
                diagnostics.add(
                    PresentationDiagnosticCode.INVALID_VALUE,
                    valuePath,
                    "Component $key is owned by projection and cannot be shown",
                )
                return@forEachIndexed
            }
            if (!result.add(key)) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, valuePath, "Duplicate shown component $key")
            }
        }
        return result
    }

    private fun compileBlocks(
        sources: List<PresentationBlockSource>,
        path: String,
        depth: Int,
        counter: BlockCounter,
        formats: Map<ItemKey, FormatSource>,
        glyphs: Map<String, CompiledGlyph>,
        diagnostics: Diagnostics,
    ): List<CompiledPresentationBlock> {
        if (depth > budgets.maximumBlockDepth) {
            diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, path, "Block nesting exceeds ${budgets.maximumBlockDepth}")
            return emptyList()
        }
        return sources.mapIndexedNotNull { index, source ->
            compileBlock(source, "$path[$index]", depth, counter, formats, glyphs, diagnostics)
        }
    }

    private fun compileBlock(
        source: PresentationBlockSource,
        blockPath: String,
        depth: Int,
        counter: BlockCounter,
        formats: Map<ItemKey, FormatSource>,
        glyphs: Map<String, CompiledGlyph>,
        diagnostics: Diagnostics,
    ): CompiledPresentationBlock? {
        counter.count++
        source.style?.let { validateSemantic(it, "$blockPath.style", diagnostics) }
        source.anchor?.let { validateSemantic(it, "$blockPath.anchor", diagnostics) }
        (source.weight as? HidingWeight.Ranked)?.let {
            if (it.value !in 0..MAXIMUM_HIDING_WEIGHT) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$blockPath.weight", "Weight must be within 0..$MAXIMUM_HIDING_WEIGHT or never")
            }
        }
        val summary = source.summary?.let { compileSummary(it, source, "$blockPath.summary", counter, formats, glyphs, diagnostics) }
        return when (source) {
            is PresentationBlockSource.Text -> {
                val data = parseDataKey(source.data, "$blockPath.data", diagnostics) ?: return null
                CompiledPresentationBlock.Text(
                    data,
                    source.style,
                    source.anchor,
                    source.wrapping,
                    source.unbreakable,
                    source.missingPolicy,
                    source.weight,
                    summary,
                )
            }

            is PresentationBlockSource.Field -> {
                validateMessageKey(source.labelMessage, "$blockPath.label", diagnostics)
                validateSeparator(source.separator, "$blockPath.separator", diagnostics)
                val data = parseDataKey(source.data, "$blockPath.data", diagnostics) ?: return null
                val format = source.format?.let { parseKey(it, "$blockPath.format", diagnostics) }
                if (format != null && format !in formats) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$blockPath.format", "Unknown format $format")
                if (source.icon != null && source.icon !in glyphs) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$blockPath.icon", "Unknown glyph ${source.icon}")
                validatePartStyles(source.partStyles, "$blockPath.styles", diagnostics)
                CompiledPresentationBlock.Field(
                    source.labelMessage,
                    data,
                    format,
                    source.icon,
                    source.style,
                    source.anchor,
                    source.wrapping,
                    source.missingPolicy,
                    source.separator,
                    source.partStyles,
                    source.weight,
                    summary,
                )
            }

            is PresentationBlockSource.Description -> {
                validateMessageKey(source.message, "$blockPath.message", diagnostics)
                CompiledPresentationBlock.Description(source.message, source.style, source.anchor, source.wrapping, source.weight, summary)
            }

            is PresentationBlockSource.Conditional -> {
                val condition = compileCondition(source.condition, "$blockPath.condition", diagnostics) ?: return null
                val thenBlocks = compileBlocks(source.thenBlocks, "$blockPath.then", depth + 1, counter, formats, glyphs, diagnostics)
                val otherwiseBlocks = compileBlocks(source.otherwiseBlocks, "$blockPath.otherwise", depth + 1, counter, formats, glyphs, diagnostics)
                CompiledPresentationBlock.Conditional(
                    condition,
                    thenBlocks,
                    otherwiseBlocks,
                    source.style,
                    source.anchor,
                    source.weight,
                )
            }

            is PresentationBlockSource.Repeat -> {
                val data = parseDataKey(source.data, "$blockPath.data", diagnostics) ?: return null
                if (source.maximumElements !in 1..budgets.maximumRepeatElements) {
                    diagnostics.add(
                        PresentationDiagnosticCode.BUDGET_EXCEEDED,
                        "$blockPath.maximum-elements",
                        "Repeat maximum must be within 1..${budgets.maximumRepeatElements}",
                    )
                }
                val template = source.template
                validateMessageKey(template.labelMessage, "$blockPath.template.label", diagnostics)
                validateMessageKey(template.missingMessage, "$blockPath.template.missing-message", diagnostics)
                validateSeparator(template.separator, "$blockPath.template.separator", diagnostics)
                if (!COMPOUND_PATH_PATTERN.matches(template.valuePath)) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_ID, "$blockPath.template.value-path", "Invalid compound value path")
                }
                val format = template.format?.let { parseKey(it, "$blockPath.template.format", diagnostics) }
                if (format != null && format !in formats) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$blockPath.template.format", "Unknown format $format")
                if (template.icon != null && template.icon !in glyphs) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$blockPath.template.icon", "Unknown glyph ${template.icon}")
                validatePartStyles(template.partStyles, "$blockPath.template.styles", diagnostics)
                CompiledPresentationBlock.Repeat(
                    data,
                    source.maximumElements,
                    CompiledCompoundFieldTemplate(
                        template.labelMessage,
                        template.valuePath,
                        template.missingMessage,
                        template.icon,
                        format,
                        template.separator,
                        template.partStyles,
                    ),
                    source.style,
                    source.anchor,
                    source.missingPolicy,
                    source.weight,
                    summary,
                )
            }

            is PresentationBlockSource.NestedItemList -> CompiledPresentationBlock.NestedItemList(source.style, source.anchor, source.weight, summary)

            is PresentationBlockSource.Group -> {
                if (source.gapBeforeLines !in 0..MAXIMUM_GROUP_GAP_LINES) {
                    diagnostics.add(
                        PresentationDiagnosticCode.INVALID_VALUE,
                        "$blockPath.gap-before-lines",
                        "Group gap must be within 0..$MAXIMUM_GROUP_GAP_LINES lines",
                    )
                }
                // A header is one row: anything that can expand into several rows or containers
                // would make the parent's marker ambiguous.
                val header = source.header?.let { header ->
                    if (header !is PresentationBlockSource.Field && header !is PresentationBlockSource.Text &&
                        header !is PresentationBlockSource.Row && header !is PresentationBlockSource.Rule
                    ) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$blockPath.header", "A group header must be a field, text, row or rule block")
                        null
                    } else if (depth + 1 > budgets.maximumBlockDepth) {
                        diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$blockPath.header", "Block nesting exceeds ${budgets.maximumBlockDepth}")
                        null
                    } else {
                        compileBlock(header, "$blockPath.header", depth + 1, counter, formats, glyphs, diagnostics)
                    }
                }
                val children = compileBlocks(source.children, "$blockPath.children", depth + 1, counter, formats, glyphs, diagnostics)
                CompiledPresentationBlock.Group(
                    header,
                    children,
                    source.marker,
                    source.dividers,
                    source.whenHeaderMissing,
                    source.whenEmpty,
                    source.gapBeforeLines,
                    source.style,
                    source.anchor,
                    source.weight,
                )
            }

            is PresentationBlockSource.Row -> {
                if (source.left.isEmpty() && source.right.isEmpty()) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, blockPath, "A row needs at least one fragment")
                }
                CompiledPresentationBlock.Row(
                    compileFragments(source.left, "$blockPath.left", counter, formats, glyphs, diagnostics),
                    compileFragments(source.right, "$blockPath.right", counter, formats, glyphs, diagnostics),
                    source.style,
                    source.anchor,
                    source.wrapping,
                    source.weight,
                    summary,
                )
            }

            is PresentationBlockSource.Rule -> CompiledPresentationBlock.Rule(
                compileFragments(source.title, "$blockPath.title", counter, formats, glyphs, diagnostics),
                source.style,
                source.anchor,
                source.weight,
                summary,
            )
        }
    }

    private fun validatePartStyles(styles: FieldPartStyles?, path: String, diagnostics: Diagnostics) {
        if (styles == null) return
        listOf("icon" to styles.icon, "label" to styles.label, "separator" to styles.separator, "value" to styles.value).forEach { (part, role) ->
            role?.let { validateSemantic(it, "$path.$part", diagnostics) }
        }
    }

    private fun compileFragments(
        sources: List<FragmentSource>,
        path: String,
        counter: BlockCounter,
        formats: Map<ItemKey, FormatSource>,
        glyphs: Map<String, CompiledGlyph>,
        diagnostics: Diagnostics,
    ): List<CompiledFragment> {
        if (sources.size > MAXIMUM_FRAGMENTS_PER_REGION) {
            diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, path, "At most $MAXIMUM_FRAGMENTS_PER_REGION fragments are allowed")
        }
        return sources.mapIndexedNotNull { index, source ->
            compileFragment(source, "$path[$index]", counter, formats, glyphs, diagnostics, allowDynamic = true)
        }
    }

    /**
     * Compiles one fragment. Slot decorations and summary pieces are [allowDynamic] = false: they
     * are static text or glyphs, so a summary can never depend on another slot's contents.
     */
    private fun compileFragment(
        source: FragmentSource,
        path: String,
        counter: BlockCounter,
        formats: Map<ItemKey, FormatSource>,
        glyphs: Map<String, CompiledGlyph>,
        diagnostics: Diagnostics,
        allowDynamic: Boolean,
    ): CompiledFragment? {
        source.style?.let { validateSemantic(it, "$path.style", diagnostics) }
        val condition = source.condition?.let {
            if (!allowDynamic) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.when", "Slot decorations and summaries cannot be conditional")
                return null
            }
            compileCondition(it, "$path.when", diagnostics) ?: return null
        }
        return when (source) {
            is FragmentSource.Message -> {
                validateMessageKey(source.message, "$path.message", diagnostics)
                CompiledFragment.Message(source.message, source.style, condition)
            }
            is FragmentSource.Data -> {
                if (!allowDynamic) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Slot decorations and summaries cannot read item data")
                    return null
                }
                val data = parseDataKey(source.data, "$path.data", diagnostics) ?: return null
                val format = source.format?.let { parseKey(it, "$path.format", diagnostics) }
                if (format != null && format !in formats) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.format", "Unknown format $format")
                CompiledFragment.Data(data, format, source.style, condition)
            }
            is FragmentSource.Glyph -> {
                if (source.glyph !in glyphs) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.glyph", "Unknown glyph ${source.glyph}")
                CompiledFragment.Glyph(source.glyph, source.style, condition)
            }
            is FragmentSource.Literal -> {
                val length = source.text.codePointCount(0, source.text.length)
                if (length !in 1..MAXIMUM_LITERAL_CODE_POINTS) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.literal", "Literal text must contain 1..$MAXIMUM_LITERAL_CODE_POINTS code points")
                }
                if (source.text.codePoints().anyMatch(Character::isISOControl)) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.literal", "Literal text contains a control character")
                }
                CompiledFragment.Literal(source.text, source.style, condition)
            }
            is FragmentSource.Slot -> {
                if (!allowDynamic) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Slot decorations and summaries cannot contain a slot")
                    return null
                }
                validateSemantic(source.id, "$path.slot", diagnostics)
                if (counter.slots.putIfAbsent(source.id, path) != null) {
                    diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, "$path.slot", "Duplicate summary slot ${source.id}")
                }
                source.maximumEntries?.let {
                    if (it !in 1..MAXIMUM_SLOT_ENTRIES) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.maximum-entries", "Slot entries must be within 1..$MAXIMUM_SLOT_ENTRIES")
                    }
                }
                source.overflowCountMessage?.let { validateMessageKey(it, "$path.overflow-count", diagnostics) }
                if (source.overflowCountMessage != null && source.maximumEntries == null) {
                    diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.overflow-count", "An overflow count requires maximum-entries")
                }
                fun decoration(piece: FragmentSource?, name: String) =
                    piece?.let { compileFragment(it, "$path.$name", counter, formats, glyphs, diagnostics, allowDynamic = false) }
                CompiledFragment.Slot(
                    source.id,
                    decoration(source.prefix, "prefix"),
                    decoration(source.suffix, "suffix"),
                    decoration(source.separator, "separator"),
                    source.maximumEntries,
                    source.overflowCountMessage,
                    source.style,
                    condition,
                )
            }
        }
    }

    private fun compileSummary(
        source: SummarySource,
        block: PresentationBlockSource,
        path: String,
        counter: BlockCounter,
        formats: Map<ItemKey, FormatSource>,
        glyphs: Map<String, CompiledGlyph>,
        diagnostics: Diagnostics,
    ): CompiledSummary? {
        validateSemantic(source.slot, "$path.slot", diagnostics)
        source.style?.let { validateSemantic(it, "$path.style", diagnostics) }
        if (block.weight == HidingWeight.Never) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "A block that is never hidden cannot leave a summary")
        }
        if ((source.piece == null) == (source.valuePath == null)) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "A summary needs exactly one of a piece or a value path")
            return null
        }
        if (source.valuePath != null) {
            if (block !is PresentationBlockSource.Repeat) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.value-path", "Only repeat elements can summarize an element value")
            }
            if (!COMPOUND_PATH_PATTERN.matches(source.valuePath)) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_ID, "$path.value-path", "Invalid compound value path")
            }
        }
        val format = source.format?.let { parseKey(it, "$path.format", diagnostics) }
        if (format != null && format !in formats) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.format", "Unknown format $format")
        if (format != null && source.valuePath == null) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.format", "A format applies only to a summarized element value")
        }
        val piece = source.piece?.let { compileFragment(it, "$path.piece", counter, formats, glyphs, diagnostics, allowDynamic = false) }
        counter.summaryTargets += source.slot to "$path.slot"
        return CompiledSummary(source.slot, piece, source.valuePath, format, source.style)
    }

    private fun validateSeparator(separator: FieldSeparatorSource?, path: String, diagnostics: Diagnostics) {
        if (separator is FieldSeparatorSource.Message) validateMessageKey(separator.message, path, diagnostics)
    }

    private fun compileCondition(
        source: ConditionSource,
        path: String,
        diagnostics: Diagnostics,
    ): CompiledCondition? {
        val left = compileValueReference(source.left, "$path.left", diagnostics) ?: return null
        val right = source.right?.let { compileValueReference(it, "$path.right", diagnostics) }
        if (source.operator == ConditionOperator.EXISTS && source.right != null) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.right", "EXISTS does not accept a right operand")
        }
        if (source.operator != ConditionOperator.EXISTS && source.right == null) {
            diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.right", "Condition requires a right operand")
        }
        return CompiledCondition(source.operator, left, right)
    }

    private fun compileValueReference(
        source: ValueReferenceSource,
        path: String,
        diagnostics: Diagnostics,
    ): CompiledValueReference? = when (source) {
        is ValueReferenceSource.Data -> parseDataKey(source.key, path, diagnostics)?.let(CompiledValueReference::Data)
        is ValueReferenceSource.Fact -> parseKey(source.key, path, diagnostics)?.let(CompiledValueReference::Fact)
        is ValueReferenceSource.Literal -> CompiledValueReference.Literal(source.value)
    }

    private fun validateCharacterFrame(source: ThemeSource, path: String, diagnostics: Diagnostics) {
        if (source.requiresResourcePack) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Character frame themes cannot require a resource pack")
        }
        if (source.vanillaTooltipLines != VanillaTooltipLinePolicy.PRESERVE_OUTSIDE_FRAME) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.vanilla-tooltip-lines", "Character frames must preserve unmanaged lines outside the frame")
        }
        val frame = source.characterFrame
        if (frame == null) {
            diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.frame", "Character frame settings are required")
            return
        }
        validateWidth(frame.minimumWidthPixels, frame.maximumWidthPixels, "$path.frame", diagnostics)
        validateNonNegative(frame.leftPaddingPixels, "$path.frame.left-padding", diagnostics)
        validateNonNegative(frame.rightPaddingPixels, "$path.frame.right-padding", diagnostics)
        validateLimit(frame.maximumLines, budgets.maximumLines, "$path.frame.maximum-lines", diagnostics)
        if (frame.alignmentTolerancePixels !in 0..8) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.frame.alignment-tolerance", "Alignment tolerance must be within 0..8")
        }
    }

    private fun validateSegmentedFrame(
        source: ThemeSource,
        path: String,
        glyphs: Map<String, CompiledGlyph>,
        spacing: CompiledSpacing?,
        diagnostics: Diagnostics,
    ) {
        val frame = source.segmentedFrame
        if (frame == null) {
            diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.frame", "Segmented frame settings are required")
            return
        }
        validateWidth(frame.minimumWidthPixels, frame.maximumWidthPixels, "$path.frame", diagnostics)
        validateNonNegative(frame.leftPaddingPixels, "$path.frame.left-padding", diagnostics)
        validateNonNegative(frame.rightPaddingPixels, "$path.frame.right-padding", diagnostics)
        listOfNotNull(frame.top, frame.body, frame.connector, frame.bottom).forEachIndexed { rowIndex, row ->
            val rowPath = "$path.frame.rows[$rowIndex]"
            listOfNotNull(row.left, row.fill, row.right, row.center, row.kern).forEach { glyph ->
                if (glyph !in glyphs) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, rowPath, "Unknown glyph $glyph")
            }
            if (frame.includeName || row.center != null || row.kern != null) {
                val kern = row.kern?.let(glyphs::get)
                if (kern != null) {
                    if (kern.advancePixels >= 0 || kern.visualBounds.right > kern.visualBounds.left || kern.visualBounds.bottom > kern.visualBounds.top) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$rowPath.kern", "A frame kern must have negative advance and no visual ink")
                    }
                    listOfNotNull(row.left, row.fill, row.right, row.center).mapNotNull(glyphs::get).forEach { piece ->
                        if (piece.font != kern.font) diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$rowPath.kern", "Frame pieces and their kern must share a font")
                    }
                }
                listOfNotNull(row.left, row.fill, row.right, row.center).mapNotNull(glyphs::get).forEach { piece ->
                    if (piece.advancePixels + (kern?.advancePixels ?: 0.0) <= 0) {
                        diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, rowPath, "Frame pieces must have positive net advance")
                    }
                }
            }
        }
        if (spacing == null) {
            diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.frame", "Segmented frames require signed spacing assets")
        }
    }

    private fun validateCanvasTheme(
        source: ThemeSource,
        path: String,
        glyphs: Map<String, CompiledGlyph>,
        bitmaps: Map<String, BitmapSource>,
        spacing: CompiledSpacing?,
        diagnostics: Diagnostics,
    ) {
        val canvas = source.canvas
        if (canvas == null) {
            diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.canvas", "Bitmap canvas settings are required")
            return
        }
        validateWidth(canvas.widthPixels, canvas.maximumWidthPixels, "$path.canvas.width", diagnostics)
        validateHeight(canvas.heightPixels, canvas.maximumHeightPixels, "$path.canvas.height", diagnostics)
        validateLimit(canvas.reserveTooltipLines, budgets.maximumLines, "$path.canvas.reserve-lines", diagnostics)
        validateLimit(canvas.maximumEmittedComponents, budgets.maximumRuns, "$path.canvas.maximum-components", diagnostics)
        if (canvas.layers.size > budgets.maximumCanvasLayers) {
            diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$path.canvas.layers", "Too many canvas layers")
        }
        if (canvas.finalTooltipWidthPixels !in 1..minOf(canvas.maximumWidthPixels, budgets.maximumWidthPixels)) {
            diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$path.canvas.final-width", "Final width is outside the configured bounds")
        }
        if (canvas.measuredAdvancePixels !in 1..minOf(canvas.maximumWidthPixels, budgets.maximumWidthPixels)) {
            diagnostics.add(
                PresentationDiagnosticCode.BUDGET_EXCEEDED,
                "$path.canvas.measured-advance",
                "Measured advance is outside the configured bounds",
            )
        } else if (canvas.measuredAdvancePixels != canvas.finalTooltipWidthPixels) {
            diagnostics.add(
                PresentationDiagnosticCode.INVALID_VALUE,
                "$path.canvas.measured-advance",
                "Measured advance must match the emitted final tooltip width",
            )
        }
        if (spacing == null) {
            diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$path.canvas", "Bitmap canvas requires signed spacing assets")
        }
        canvas.layers.forEachIndexed { index, layer ->
            val layerPath = "$path.canvas.layers[$index]"
            val glyph = glyphs[layer.asset]
            if (glyph == null) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$layerPath.asset", "Unknown glyph ${layer.asset}")
                return@forEachIndexed
            }
            val bitmap = glyph.bitmap?.let(bitmaps::get)
            if (bitmap == null) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$layerPath.asset", "Canvas layer glyph must reference a bitmap")
                return@forEachIndexed
            }
            if (bitmap.baselineVariant != layer.baselineVariant) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$layerPath.baseline-variant", "Layer baseline does not match the bitmap manifest")
            }
            if (layer.baselineLine !in 0 until canvas.reserveTooltipLines) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$layerPath.baseline-line", "Layer baseline is outside reserved lines")
            }
            val x = when (layer.anchor) {
                CanvasLayerAnchor.TOP_LEFT -> layer.xPixels
                CanvasLayerAnchor.TOP_RIGHT -> canvas.widthPixels + layer.xPixels - bitmap.renderWidthPixels
            }
            if (canvas.rejectOutOfBoundsLayer &&
                (x + bitmap.visualBounds.left < 0 || x + bitmap.visualBounds.right > canvas.widthPixels)
            ) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, layerPath, "Layer is outside the canvas width")
            }
        }
    }

    private fun validateThemes(themes: Map<ItemKey, CompiledTheme>, diagnostics: Diagnostics) {
        themes.values.forEach { theme ->
            if (theme.source.renderer == ThemeRenderer.PLAIN && theme.fallback != null) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "themes.${theme.id}.fallback", "Plain themes must be terminal")
            }
            var current: CompiledTheme? = theme
            val visited = HashSet<ItemKey>()
            while (current != null && visited.add(current.id)) {
                if (current.source.renderer == ThemeRenderer.PLAIN) return@forEach
                current = current.fallback?.let(themes::get)
            }
            if (current == null) {
                diagnostics.add(
                    PresentationDiagnosticCode.MISSING_REFERENCE,
                    "themes.${theme.id}.fallback",
                    "Theme fallback chain does not terminate at a plain theme",
                )
            }
        }
    }

    private fun validateFormatGraph(formats: Map<ItemKey, FormatSource>, diagnostics: Diagnostics) {
        formats.forEach { (id, source) ->
            if (source is FormatSource.ListFormat) {
                val element = parseKey(source.elementFormat, "formats.$id.element-format", diagnostics)
                if (element != null && element !in formats) {
                    diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "formats.$id.element-format", "Unknown format $element")
                }
            }
        }
        detectCycles(
            label = "formats",
            nodes = formats.keys,
            next = { id ->
                (formats[id] as? FormatSource.ListFormat)?.elementFormat?.let {
                    runCatching { ItemKey.parse(it) }.getOrNull()
                }
            },
            diagnostics = diagnostics,
        )
    }

    private fun validateItemLayoutContracts(
        items: Map<ItemKey, CompiledItemPresentation>,
        layouts: Map<ItemKey, CompiledLayout>,
        themes: Map<ItemKey, CompiledTheme>,
        themeSelectors: Map<ItemKey, CompiledThemeSelector>,
        diagnostics: Diagnostics,
    ) {
        items.values.forEach { item ->
            val layout = layouts[item.layout] ?: return@forEach
            // A selector can choose any of its themes at runtime, so each must accept the layout.
            val reachable = themeSelectors[item.theme]?.reachableThemes ?: setOf(item.theme)
            reachable.mapNotNull(themes::get).forEach { theme ->
                if (theme.source.renderer == ThemeRenderer.BITMAP_CANVAS && layout !is CompiledLayout.Canvas) {
                    diagnostics.add(
                        PresentationDiagnosticCode.INVALID_VALUE,
                        "items.${item.key}.layout",
                        if (theme.id == item.theme) {
                            "Bitmap canvas theme requires a canvas layout"
                        } else {
                            "Bitmap canvas theme ${theme.id}, reachable through theme selector ${item.theme}, requires a canvas layout"
                        },
                    )
                }
            }
            if (layout is CompiledLayout.Canvas && item.marker != GroupMarker.NONE) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "items.${item.key}.marker", "Root markers require a flow layout")
            }
            validateBlockLayoutReferences(item.blocks, layout, "items.${item.key}.blocks", diagnostics)
        }
    }

    private fun validateItemFactReferences(
        items: Map<ItemKey, CompiledItemPresentation>,
        facts: Map<ItemKey, ViewerFactDefinition>,
        diagnostics: Diagnostics,
    ) {
        items.values.forEach { item ->
            validateFragmentFactReferences(item.nameBefore, facts, "items.${item.key}.name.before", diagnostics)
            validateFragmentFactReferences(item.nameAfter, facts, "items.${item.key}.name.after", diagnostics)
            validateBlockFactReferences(item.blocks, facts, "items.${item.key}.blocks", diagnostics)
        }
    }

    private fun validateFragmentFactReferences(
        fragments: List<CompiledFragment>,
        facts: Map<ItemKey, ViewerFactDefinition>,
        path: String,
        diagnostics: Diagnostics,
    ) {
        fragments.forEachIndexed { index, fragment ->
            fragment.condition?.let { validateConditionFactReferences(it, facts, "$path[$index].when", diagnostics) }
        }
    }

    private fun validateBlockFactReferences(
        blocks: List<CompiledPresentationBlock>,
        facts: Map<ItemKey, ViewerFactDefinition>,
        path: String,
        diagnostics: Diagnostics,
    ) {
        blocks.forEachIndexed { index, block ->
            val blockPath = "$path[$index]"
            when (block) {
                is CompiledPresentationBlock.Conditional -> {
                    validateConditionFactReferences(block.condition, facts, "$blockPath.condition", diagnostics)
                    validateBlockFactReferences(block.thenBlocks, facts, "$blockPath.then", diagnostics)
                    validateBlockFactReferences(block.otherwiseBlocks, facts, "$blockPath.otherwise", diagnostics)
                }
                is CompiledPresentationBlock.Group -> {
                    block.header?.let { validateBlockFactReferences(listOf(it), facts, "$blockPath.header", diagnostics) }
                    validateBlockFactReferences(block.children, facts, "$blockPath.children", diagnostics)
                }
                is CompiledPresentationBlock.Row -> {
                    validateFragmentFactReferences(block.left, facts, "$blockPath.left", diagnostics)
                    validateFragmentFactReferences(block.right, facts, "$blockPath.right", diagnostics)
                }
                is CompiledPresentationBlock.Rule -> validateFragmentFactReferences(block.title, facts, "$blockPath.title", diagnostics)
                else -> Unit
            }
        }
    }

    private fun validateThemeSelectorFactReferences(
        selectors: Map<ItemKey, CompiledThemeSelector>,
        facts: Map<ItemKey, ViewerFactDefinition>,
        diagnostics: Diagnostics,
    ) {
        selectors.values.forEach { selector ->
            selector.cases.forEachIndexed { index, case ->
                validateConditionFactReferences(case.condition, facts, "theme-selectors.${selector.id}.cases[$index].when", diagnostics)
            }
        }
    }

    /** Shared by conditional blocks and theme selectors: both are evaluated per viewer. */
    private fun validateConditionFactReferences(
        condition: CompiledCondition,
        facts: Map<ItemKey, ViewerFactDefinition>,
        path: String,
        diagnostics: Diagnostics,
    ) {
        listOfNotNull(condition.left, condition.right).forEach { reference ->
            if (reference !is CompiledValueReference.Fact) return@forEach
            val fact = facts[reference.key]
            if (fact == null) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, path, "Unknown viewer fact ${reference.key}")
            } else if (!fact.cacheKey) {
                diagnostics.add(
                    PresentationDiagnosticCode.INVALID_VALUE,
                    path,
                    "Presentation-visible viewer fact ${reference.key} must participate in the cache key",
                )
            }
        }
    }

    private fun validateBlockLayoutReferences(
        blocks: List<CompiledPresentationBlock>,
        layout: CompiledLayout,
        path: String,
        diagnostics: Diagnostics,
    ) {
        blocks.forEachIndexed { index, block -> validateBlockLayoutReference(block, layout, "$path[$index]", diagnostics) }
    }

    private fun validateBlockLayoutReference(
        block: CompiledPresentationBlock,
        layout: CompiledLayout,
        blockPath: String,
        diagnostics: Diagnostics,
    ) {
        if (block.anchor != null) {
            val valid = layout is CompiledLayout.Canvas && block.anchor in layout.source.anchors
            if (!valid) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$blockPath.anchor", "Unknown layout anchor ${block.anchor}")
        }
        val wrapping = when (block) {
            is CompiledPresentationBlock.Text -> block.wrapping
            is CompiledPresentationBlock.Field -> block.wrapping
            is CompiledPresentationBlock.Description -> block.wrapping
            is CompiledPresentationBlock.Row -> block.wrapping
            else -> null
        }
        if ((block is CompiledPresentationBlock.Row || block is CompiledPresentationBlock.Rule) && layout is CompiledLayout.Canvas) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, blockPath, "Rows and rules require a flow layout")
        }
        if (wrapping != null) {
            val known = when (layout) {
                is CompiledLayout.Flow -> wrapping in layout.source.wrapping
                is CompiledLayout.Canvas -> wrapping in layout.source.wrapping
            }
            if (!known) diagnostics.add(PresentationDiagnosticCode.MISSING_REFERENCE, "$blockPath.wrapping", "Unknown wrapping policy $wrapping")
        }
        if (block is CompiledPresentationBlock.Conditional) {
            validateBlockLayoutReferences(block.thenBlocks, layout, "$blockPath.then", diagnostics)
            validateBlockLayoutReferences(block.otherwiseBlocks, layout, "$blockPath.otherwise", diagnostics)
        }
        if (block is CompiledPresentationBlock.Group) {
            // Canvas layouts place every block at an anchor; groups only decorate flow rows.
            if (layout is CompiledLayout.Canvas) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, blockPath, "Groups require a flow layout")
            }
            block.header?.let { validateBlockLayoutReference(it, layout, "$blockPath.header", diagnostics) }
            validateBlockLayoutReferences(block.children, layout, "$blockPath.children", diagnostics)
        }
    }

    private fun validateMessages(
        items: Map<ItemKey, CompiledItemPresentation>,
        formats: Map<ItemKey, FormatSource>,
        layouts: Map<ItemKey, CompiledLayout>,
        locales: Map<String, LocaleSource>,
        diagnostics: Diagnostics,
    ) {
        val required = LinkedHashMap<String, String>()
        formats.forEach { (id, source) ->
            when (source) {
                is FormatSource.BooleanFormat -> {
                    required[source.trueMessage] = "formats.$id.true-message"
                    required[source.falseMessage] = "formats.$id.false-message"
                }
                is FormatSource.DecimalFormat -> source.suffixMessage?.let { required[it] = "formats.$id.suffix-message" }
                is FormatSource.ListFormat -> required[source.separatorMessage] = "formats.$id.separator-message"
                else -> Unit
            }
        }
        layouts.forEach { (id, layout) ->
            ((layout.source as? LayoutSource.Flow)?.fieldSeparator as? FieldSeparatorSource.Message)?.let {
                required[it.message] = "layouts.$id.sections.field.separator"
            }
        }
        items.values.forEach { item ->
            required[item.nameMessage] = "items.${item.key}.name"
            collectFragmentMessages(item.nameBefore, "items.${item.key}.name.before", required)
            collectFragmentMessages(item.nameAfter, "items.${item.key}.name.after", required)
            collectBlockMessages(item.blocks, "items.${item.key}.blocks", required)
        }
        required.forEach { (message, path) ->
            if (resolveMessage(defaultLocale, message, locales) == null) {
                diagnostics.add(PresentationDiagnosticCode.MISSING_MESSAGE, path, "Message $message is missing from the default fallback chain")
            }
        }
    }

    private fun collectBlockMessages(
        blocks: List<CompiledPresentationBlock>,
        path: String,
        result: MutableMap<String, String>,
    ) {
        blocks.forEachIndexed { index, block -> collectBlockMessage(block, "$path[$index]", result) }
    }

    private fun collectBlockMessage(
        block: CompiledPresentationBlock,
        blockPath: String,
        result: MutableMap<String, String>,
    ) {
        when (block) {
            is CompiledPresentationBlock.Field -> {
                result[block.labelMessage] = "$blockPath.label"
                (block.separator as? FieldSeparatorSource.Message)?.let { result[it.message] = "$blockPath.separator" }
            }
            is CompiledPresentationBlock.Description -> result[block.message] = "$blockPath.message"
            is CompiledPresentationBlock.Repeat -> {
                result[block.template.labelMessage] = "$blockPath.template.label"
                result[block.template.missingMessage] = "$blockPath.template.missing-message"
                (block.template.separator as? FieldSeparatorSource.Message)?.let {
                    result[it.message] = "$blockPath.template.separator"
                }
            }
            is CompiledPresentationBlock.Conditional -> {
                collectBlockMessages(block.thenBlocks, "$blockPath.then", result)
                collectBlockMessages(block.otherwiseBlocks, "$blockPath.otherwise", result)
            }
            is CompiledPresentationBlock.Group -> {
                block.header?.let { collectBlockMessage(it, "$blockPath.header", result) }
                collectBlockMessages(block.children, "$blockPath.children", result)
            }
            is CompiledPresentationBlock.Row -> {
                collectFragmentMessages(block.left, "$blockPath.left", result)
                collectFragmentMessages(block.right, "$blockPath.right", result)
            }
            is CompiledPresentationBlock.Rule -> collectFragmentMessages(block.title, "$blockPath.title", result)
            else -> Unit
        }
        block.summary?.piece?.let { collectFragmentMessages(listOf(it), "$blockPath.summary.piece", result) }
    }

    private fun collectFragmentMessages(fragments: List<CompiledFragment>, path: String, result: MutableMap<String, String>) {
        fragments.forEachIndexed { index, fragment ->
            val fragmentPath = "$path[$index]"
            when (fragment) {
                is CompiledFragment.Message -> result[fragment.message] = "$fragmentPath.message"
                is CompiledFragment.Slot -> {
                    fragment.overflowCountMessage?.let { result[it] = "$fragmentPath.overflow-count" }
                    listOfNotNull(fragment.prefix, fragment.suffix, fragment.separator).forEach { piece ->
                        collectFragmentMessages(listOf(piece), "$fragmentPath.decoration", result)
                    }
                }
                else -> Unit
            }
        }
    }

    private fun resolveMessage(locale: String, key: String, locales: Map<String, LocaleSource>): String? {
        var current: String? = locale
        val visited = HashSet<String>()
        while (current != null && visited.add(current)) {
            val source = locales[current] ?: return null
            source.messages[key]?.let { return it }
            current = source.fallback
        }
        return null
    }

    private fun <K : Comparable<K>, V> validateFallbackGraph(
        label: String,
        nodes: Map<K, V>,
        fallback: (V) -> K?,
        diagnostics: Diagnostics,
    ) {
        detectCycles(label, nodes.keys, { key -> nodes[key]?.let(fallback) }, diagnostics)
    }

    private fun <K> detectCycles(
        label: String,
        nodes: Set<K>,
        next: (K) -> K?,
        diagnostics: Diagnostics,
    ) {
        val done = HashSet<K>()
        nodes.forEach { start ->
            if (start in done) return@forEach
            val order = LinkedHashMap<K, Int>()
            var current: K? = start
            while (current != null && current in nodes && current !in done) {
                val seenAt = order.putIfAbsent(current, order.size)
                if (seenAt != null) {
                    val cycle = order.keys.drop(seenAt) + current
                    diagnostics.add(PresentationDiagnosticCode.REFERENCE_CYCLE, "$label.$start", "Reference cycle: ${cycle.joinToString(" -> ")}")
                    break
                }
                current = next(current)
            }
            done.addAll(order.keys)
        }
    }

    private fun validateWrapping(wrapping: Map<String, WrappingSource>, path: String, diagnostics: Diagnostics) {
        wrapping.forEach { (id, source) ->
            validateSemantic(id, "$path.$id", diagnostics)
            source.widthPixels?.let {
                if (it !in 1..budgets.maximumWidthPixels) diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$path.$id.width", "Wrapping width exceeds hard limits")
            }
            validateLimit(source.maximumLines, budgets.maximumLines, "$path.$id.maximum-lines", diagnostics)
            validateNonNegative(source.continuationIndentPixels, "$path.$id.continuation-indent", diagnostics)
            if (source.lineHeightPixels !in 1..budgets.maximumHeightPixels) {
                diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$path.$id.line-height", "Line height exceeds hard limits")
            }
            if (source.widthPixels != null && source.continuationIndentPixels >= source.widthPixels) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.$id.continuation-indent", "Continuation indent consumes the wrapping width")
            }
        }
    }

    private fun validateWidth(minimum: Int, maximum: Int, path: String, diagnostics: Diagnostics) {
        if (minimum <= 0 || maximum < minimum) diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Invalid width range $minimum..$maximum")
        if (maximum > budgets.maximumWidthPixels) diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, path, "Width exceeds ${budgets.maximumWidthPixels}")
    }

    private fun validateHeight(height: Int, maximum: Int, path: String, diagnostics: Diagnostics) {
        if (height <= 0 || maximum < height) diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Invalid height range $height..$maximum")
        if (maximum > budgets.maximumHeightPixels) diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, path, "Height exceeds ${budgets.maximumHeightPixels}")
    }

    private fun validateSpacingRange(range: SpacingRangeSource, negative: Boolean, path: String, diagnostics: Diagnostics) {
        if (!Character.isValidCodePoint(range.firstCodePoint) || !Character.isValidCodePoint(range.lastCodePoint) ||
            range.firstCodePoint > range.lastCodePoint || range.firstCodePoint in 0xD800..0xDFFF || range.lastCodePoint in 0xD800..0xDFFF
        ) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Invalid spacing code point range")
        }
        if (range.minimumAdvancePixels > range.maximumAdvancePixels ||
            (negative && range.maximumAdvancePixels >= 0) || (!negative && range.minimumAdvancePixels <= 0)
        ) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Invalid spacing advance range")
        }
        val codePointCount = range.lastCodePoint.toLong() - range.firstCodePoint + 1
        val advanceCount = range.maximumAdvancePixels.toLong() - range.minimumAdvancePixels + 1
        if (codePointCount != advanceCount) diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Spacing code point and advance ranges differ")
    }

    private fun validateMetric(metric: GlyphMetricSource, path: String, diagnostics: Diagnostics) {
        if (!validAdvance(metric.advancePixels)) diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.advance", "Invalid glyph advance")
        if (metric.boldExtraAdvancePixels != null &&
            (!validAdvance(metric.boldExtraAdvancePixels) || metric.boldExtraAdvancePixels < 0)
        ) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, "$path.bold-extra-advance", "Invalid glyph bold advance")
        }
        validateBounds(metric.visualBounds, "$path.visual-bounds", diagnostics)
        if (metric.visualBounds.left < -budgets.maximumWidthPixels ||
            metric.visualBounds.right > budgets.maximumWidthPixels ||
            metric.visualBounds.right - metric.visualBounds.left > budgets.maximumWidthPixels
        ) {
            diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$path.visual-bounds", "Glyph horizontal bounds exceed hard limits")
        }
        if (metric.visualBounds.top < -budgets.maximumHeightPixels ||
            metric.visualBounds.bottom > budgets.maximumHeightPixels ||
            metric.visualBounds.bottom - metric.visualBounds.top > budgets.maximumHeightPixels
        ) {
            diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, "$path.visual-bounds", "Glyph vertical bounds exceed hard limits")
        }
    }

    private fun validateBounds(bounds: VisualBoundsSource, path: String, diagnostics: Diagnostics) {
        if (!listOf(bounds.left, bounds.right, bounds.top, bounds.bottom).all(Double::isFinite) ||
            bounds.right < bounds.left || bounds.bottom < bounds.top
        ) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Invalid visual bounds")
        }
    }

    private fun validateText(value: String, path: String, diagnostics: Diagnostics) {
        if (value.codePointCount(0, value.length) > budgets.maximumTextCodePoints) {
            diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, path, "Text exceeds ${budgets.maximumTextCodePoints} code points")
        }
        if (value.codePoints().anyMatch { Character.isISOControl(it) && it != '\n'.code }) {
            diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Text contains an unsupported control character")
        }
    }

    private fun validateLimit(value: Int, maximum: Int, path: String, diagnostics: Diagnostics) {
        if (value !in 1..maximum) diagnostics.add(PresentationDiagnosticCode.BUDGET_EXCEEDED, path, "Value must be within 1..$maximum")
    }

    private fun validateNonNegative(value: Int, path: String, diagnostics: Diagnostics) {
        if (value < 0) diagnostics.add(PresentationDiagnosticCode.INVALID_VALUE, path, "Value must not be negative")
    }

    private fun parseKey(raw: String, path: String, diagnostics: Diagnostics): ItemKey? = try {
        ItemKey.parse(raw)
    } catch (exception: IllegalArgumentException) {
        diagnostics.add(PresentationDiagnosticCode.INVALID_ID, path, exception.message ?: "Invalid namespaced key")
        null
    }

    private fun parseDataKey(raw: String, path: String, diagnostics: Diagnostics): DataKey? =
        parseKey(raw, path, diagnostics)?.let(::DataKey)

    private fun validateMessageKey(raw: String, path: String, diagnostics: Diagnostics) {
        if (!MESSAGE_PATTERN.matches(raw)) diagnostics.add(PresentationDiagnosticCode.INVALID_ID, path, "Invalid message key $raw")
    }

    private fun validateSemantic(raw: String, path: String, diagnostics: Diagnostics) {
        if (!SEMANTIC_PATTERN.matches(raw)) diagnostics.add(PresentationDiagnosticCode.INVALID_ID, path, "Invalid semantic id $raw")
    }

    private fun <T> collectByKey(
        sources: List<T>,
        rawId: (T) -> String,
        label: String,
        diagnostics: Diagnostics,
    ): Map<ItemKey, T> {
        val result = TreeMap<ItemKey, T>()
        sources.forEachIndexed { index, source ->
            val id = parseKey(rawId(source), "$label[$index].id", diagnostics) ?: return@forEachIndexed
            if (result.putIfAbsent(id, source) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, "$label[$index]", "Duplicate $label id $id")
            }
        }
        return result
    }

    private fun <T> collectSemantic(
        sources: List<T>,
        id: (T) -> String,
        label: String,
        diagnostics: Diagnostics,
    ): Map<String, T> {
        val result = TreeMap<String, T>()
        sources.forEachIndexed { index, source ->
            val raw = id(source)
            if (!SEMANTIC_PATTERN.matches(raw)) {
                diagnostics.add(PresentationDiagnosticCode.INVALID_ID, "$label[$index].id", "Invalid semantic id $raw")
                return@forEachIndexed
            }
            if (result.putIfAbsent(raw, source) != null) {
                diagnostics.add(PresentationDiagnosticCode.DUPLICATE_ID, "$label[$index]", "Duplicate $label id $raw")
            }
        }
        return result
    }

    private fun compileKeySet(values: Set<String>, path: String, diagnostics: Diagnostics): Set<ItemKey> =
        values.mapNotNullTo(sortedSetOf()) { parseKey(it, path, diagnostics) }

    /** Per-item compilation state: the block count and the summary slots declared and targeted. */
    private class BlockCounter(var count: Int = 0) {
        val slots = LinkedHashMap<String, String>()
        val summaryTargets = ArrayList<Pair<String, String>>()
    }

    private class Diagnostics {
        private val values = ArrayList<PresentationDiagnostic>()

        fun add(code: PresentationDiagnosticCode, path: String, message: String) {
            values += PresentationDiagnostic(code, path, message)
        }

        fun snapshot(): List<PresentationDiagnostic> = values.sortedWith(
            compareBy(PresentationDiagnostic::path, PresentationDiagnostic::code, PresentationDiagnostic::message),
        )
    }

    private companion object {
        const val MAXIMUM_SHOWN_FLAGS = 64
        val PROJECTION_OWNED_COMPONENTS = setOf(
            "minecraft:custom_data",
            "minecraft:custom_name",
            "minecraft:item_name",
            "minecraft:lore",
            "minecraft:tooltip_display",
            "minecraft:tooltip_style",
            "minecraft:item_model",
        ).mapTo(HashSet(), ItemKey::parse)
        val LOCALE_PATTERN = Regex("[a-z]{2}_[a-z]{2}(?:_[a-z0-9]+)?")
        val MESSAGE_PATTERN = Regex("[a-z0-9][a-z0-9._-]*")
        val SEMANTIC_PATTERN = Regex("[a-z0-9][a-z0-9._-]*")
        val COMPOUND_PATH_PATTERN = Regex("[a-zA-Z0-9_-]+(?:\\.[a-zA-Z0-9_-]+)*")
        val SHA1_PATTERN = Regex("[0-9a-fA-F]{40}")
        val ZERO_UUID = UUID(0, 0)
        const val TOOLTIP_LINE_HEIGHT_PIXELS = 10
        val NAMED_COLORS = setOf(
            "black", "dark_blue", "dark_green", "dark_aqua", "dark_red", "dark_purple", "gold",
            "gray", "dark_gray", "blue", "green", "aqua", "red", "light_purple", "yellow", "white",
        )

        fun validAdvance(value: Double): Boolean = value.isFinite() && value in -4096.0..4096.0

        fun validColor(value: String): Boolean = value in NAMED_COLORS || Regex("#[0-9a-fA-F]{6}").matches(value)

        fun matchesFactType(type: ViewerFactType, value: com.iroselle.itemerness.api.ItemDataValue): Boolean = when (type) {
            ViewerFactType.LOCALE, ViewerFactType.STRING -> value is StringDataValue
            ViewerFactType.BOOLEAN -> value is BooleanDataValue
            ViewerFactType.INTEGER -> value is IntegerDataValue
            ViewerFactType.LONG -> value is LongDataValue
            ViewerFactType.DECIMAL -> value is DecimalDataValue
            ViewerFactType.UUID -> value is UuidDataValue
            ViewerFactType.NAMESPACED_KEY -> value is NamespacedKeyDataValue
        }
    }
}

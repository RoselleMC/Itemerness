import type {
    BitmapNode,
    DataSchemaNode,
    FontNode,
    FormatNode,
    GlyphNode,
    ItemNode,
    LayoutNode,
    LocaleNode,
    PresentationBlock,
    ProjectDocument,
    ThemeNode,
    ViewerFactNode,
} from "../src/document.js";
import {
    PROJECT_DOCUMENT_SCHEMA_VERSION,
    projectDocumentSchema,
} from "../src/document.js";
import type { DataValue } from "../src/common.js";

/**
 * The baseline fixture: the five items bundled with the plugin, expressed as a project document.
 *
 * This is the shared truth for cross-language tests. The same document must validate under the
 * TypeScript schema and under the JVM codec, and both must produce the same canonical hash. It
 * also exercises all five renderers, so the preview engine has something to draw before any
 * Minecraft server exists.
 *
 * Source of record: `itemerness-bukkit/src/main/resources/{items,themes,layouts,locales,formats,
 * data-keys,viewer-facts,assets}`.
 */

/** Deterministic node identities keep the fixture's canonical hash stable across regenerations. */
let uuidCounter = 0;
function uuid(): string {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, "0")}`;
}

const str = (value: string): DataValue => ({ kind: "string", value });
const int = (value: number): DataValue => ({
    kind: "integer",
    value: String(value),
});
const dec = (value: string): DataValue => ({ kind: "decimal", value });
const bool = (value: boolean): DataValue => ({ kind: "boolean", value });
const list = (...values: DataValue[]): DataValue => ({ kind: "list", values });
const compound = (entries: Record<string, DataValue>): DataValue => ({
    kind: "compound",
    entries,
});

const formats: FormatNode[] = [
    { uuid: uuid(), kind: "integer", id: "itemerness:integer", pattern: "0" },
    {
        uuid: uuid(),
        kind: "decimal",
        id: "itemerness:decimal-one",
        pattern: "0.0",
        multiply: 1,
        suffixMessage: null,
    },
    {
        uuid: uuid(),
        kind: "decimal",
        id: "itemerness:percent-one",
        pattern: "0.0",
        multiply: 100,
        suffixMessage: "format.percent-suffix",
    },
    {
        uuid: uuid(),
        kind: "boolean",
        id: "itemerness:boolean",
        trueMessage: "format.boolean.true",
        falseMessage: "format.boolean.false",
    },
    {
        uuid: uuid(),
        kind: "namespacedKey",
        id: "itemerness:key-path",
        mode: "PATH",
        messagePattern: null,
        missingValue: "PATH",
    },
    {
        uuid: uuid(),
        kind: "namespacedKey",
        id: "itemerness:key-message",
        mode: "MESSAGE",
        messagePattern: "value.{namespace}.{path}",
        missingValue: "PATH",
    },
    {
        uuid: uuid(),
        kind: "list",
        id: "itemerness:key-list",
        elementFormat: "itemerness:key-message",
        separatorMessage: "format.list-separator",
    },
];

const englishMessages: Record<string, string> = {
    "item.travel-token.name": "Harbor Travel Token",
    "item.travel-token.description":
        "Consumed when travelling to the recorded region.",
    "item.ember-blade.name": "Ember Blade",
    "item.ember-blade.description":
        "A blade tempered in ember ash. Its settled attack roll remains unchanged when presentation files reload.",
    "item.survey-codex.name": "Survey Codex",
    "item.survey-codex.description":
        "Records landmarks, routes, and incomplete observations from the current expedition.",
    "item.nested-satchel.name": "Nested Satchel",
    "item.nested-satchel.description":
        "Its contained Itemerness items are projected recursively for the same viewer.",
    "item.framed-relic.name": "Framed Relic",
    "item.framed-relic.description":
        "A legacy segmented frame generated from measured content instead of manually padded Lore.",
    "data.region.label": "Region",
    "data.charges.label": "Charges",
    "data.attack-damage.label": "Attack Damage",
    "data.quality.label": "Quality",
    "data.required-level.label": "Required Level",
    "data.socket.label": "Socket",
    "data.socket.empty": "Empty",
    "value.example.common": "Common",
    "value.example.uncommon": "Uncommon",
    "value.example.rare": "Rare",
    "value.example.epic": "Epic",
    "value.example.harbor": "Harbor",
    "value.example.aurora-expanse": "Aurora Expanse",
    "value.example.ancient-vault": "Ancient Vault",
    "format.percent-suffix": "%",
    "format.boolean.true": "Yes",
    "format.boolean.false": "No",
    "format.list-separator": ", ",
};

const chineseMessages: Record<string, string> = {
    "item.travel-token.name": "港口旅行凭证",
    "item.travel-token.description": "前往记录区域时消耗。",
    "item.ember-blade.name": "余烬之刃",
    "item.ember-blade.description":
        "以余烬灰反复淬炼的长刃。展示配置重载不会重新生成已经落定的攻击数值。",
    "item.survey-codex.name": "勘探手册",
    "item.survey-codex.description":
        "记录本次远征发现的地标、路线和尚未完成的观察。",
    "item.nested-satchel.name": "叠层行囊",
    "item.nested-satchel.description":
        "其中包含的 Itemerness 物品会为同一观察者递归生成展示。",
    "item.framed-relic.name": "框饰遗物",
    "item.framed-relic.description":
        "兼容传统分段外框，但由引擎按实测内容生成，不再手工填充 Lore。",
    "data.region.label": "区域",
    "data.charges.label": "次数",
    "data.attack-damage.label": "攻击伤害",
    "data.quality.label": "品质",
    "data.required-level.label": "需求等级",
    "data.socket.label": "插槽",
    "data.socket.empty": "空",
    "value.example.common": "普通",
    "value.example.uncommon": "罕见",
    "value.example.rare": "稀有",
    "value.example.epic": "史诗",
    "value.example.harbor": "港口",
    "value.example.aurora-expanse": "极光荒原",
    "value.example.ancient-vault": "远古秘库",
    "format.percent-suffix": "%",
    "format.boolean.true": "是",
    "format.boolean.false": "否",
    "format.list-separator": "、",
};

const locales: LocaleNode[] = [
    {
        uuid: uuid(),
        locale: "en_us",
        fallback: null,
        messages: englishMessages,
    },
    {
        uuid: uuid(),
        locale: "zh_cn",
        fallback: "en_us",
        messages: chineseMessages,
    },
];

const fonts: FontNode[] = [
    {
        uuid: uuid(),
        id: "minecraft:default",
        metrics: "builtin:minecraft-default-26.1.2",
        fallback: null,
        fallbackAdvancePixels: null,
        advances: null,
    },
    {
        uuid: uuid(),
        id: "minecraft:uniform",
        metrics: "builtin:minecraft-uniform-26.1.2",
        fallback: null,
        fallbackAdvancePixels: null,
        advances: null,
    },
    {
        uuid: uuid(),
        id: "itemerness:body",
        metrics: "manifest:itemerness-body",
        fallback: "minecraft:default",
        fallbackAdvancePixels: null,
        advances: null,
    },
    {
        uuid: uuid(),
        id: "itemerness:icons",
        metrics: "explicit",
        fallback: "minecraft:default",
        fallbackAdvancePixels: null,
        advances: null,
    },
    {
        uuid: uuid(),
        id: "itemerness:frame",
        metrics: "explicit",
        fallback: "itemerness:icons",
        fallbackAdvancePixels: null,
        advances: null,
    },
    {
        uuid: uuid(),
        id: "itemerness:canvas",
        metrics: "explicit",
        fallback: "itemerness:icons",
        fallbackAdvancePixels: null,
        advances: null,
    },
    {
        uuid: uuid(),
        id: "itemerness:spacing",
        metrics: "space-provider",
        fallback: null,
        fallbackAdvancePixels: null,
        advances: { minimum: -256, maximum: 256 },
    },
];

const iconBounds = { left: 0, right: 8, top: -8, bottom: 0 };
const frameBounds = { left: 0, right: 4, top: -8, bottom: 2 };
const frameFillBounds = { left: 0, right: 1, top: -8, bottom: 2 };

const iconGlyph = (id: string, codePoint: number): GlyphNode => ({
    uuid: uuid(),
    id,
    font: "itemerness:icons",
    codePoint,
    advancePixels: 9,
    visualBounds: iconBounds,
    bitmap: null,
});

const frameGlyph = (
    id: string,
    codePoint: number,
    fill: boolean,
): GlyphNode => ({
    uuid: uuid(),
    id,
    font: "itemerness:frame",
    codePoint,
    advancePixels: fill ? 1 : 4,
    visualBounds: fill ? frameFillBounds : frameBounds,
    bitmap: null,
});

const glyphs: GlyphNode[] = [
    iconGlyph("icon.attack", 0xe001),
    iconGlyph("icon.quality", 0xe002),
    iconGlyph("icon.region", 0xe003),
    iconGlyph("icon.charges", 0xe004),
    iconGlyph("icon.socket", 0xe005),
    frameGlyph("frame.segment.top-left", 0xe101, false),
    frameGlyph("frame.segment.top-fill", 0xe102, true),
    frameGlyph("frame.segment.top-right", 0xe103, false),
    frameGlyph("frame.segment.body-left", 0xe104, false),
    frameGlyph("frame.segment.body-fill", 0xe105, true),
    frameGlyph("frame.segment.body-right", 0xe106, false),
    frameGlyph("frame.segment.connector-left", 0xe107, false),
    frameGlyph("frame.segment.connector-fill", 0xe108, true),
    frameGlyph("frame.segment.connector-right", 0xe109, false),
    frameGlyph("frame.segment.bottom-left", 0xe10a, false),
    frameGlyph("frame.segment.bottom-fill", 0xe10b, true),
    frameGlyph("frame.segment.bottom-right", 0xe10c, false),
    {
        uuid: uuid(),
        id: "canvas.aurora.background",
        font: "itemerness:canvas",
        codePoint: 0xe201,
        advancePixels: 176,
        visualBounds: { left: 0, right: 176, top: -94, bottom: 2 },
        bitmap: "canvas.aurora.panel",
    },
    {
        uuid: uuid(),
        id: "canvas.aurora.horizontal-rule",
        font: "itemerness:canvas",
        codePoint: 0xe202,
        advancePixels: 140,
        visualBounds: { left: 0, right: 140, top: -1, bottom: 1 },
        bitmap: "canvas.aurora.horizontal-rule",
    },
    {
        uuid: uuid(),
        id: "canvas.aurora.emblem",
        font: "itemerness:canvas",
        codePoint: 0xe203,
        advancePixels: 16,
        visualBounds: { left: 0, right: 16, top: -16, bottom: 0 },
        bitmap: "canvas.aurora.emblem",
    },
];

const bitmaps: BitmapNode[] = [
    {
        uuid: uuid(),
        id: "canvas.aurora.panel",
        baselineVariant: "canvas.aurora.panel",
        texture: "itemerness:font/canvas/aurora_panel.png",
        sourceWidthPixels: 176,
        sourceHeightPixels: 96,
        renderWidthPixels: 176,
        renderHeightPixels: 96,
        ascentPixels: 94,
        visualBounds: { left: 0, right: 176, top: -94, bottom: 2 },
    },
    {
        uuid: uuid(),
        id: "canvas.aurora.horizontal-rule",
        baselineVariant: "canvas.aurora.rule",
        texture: "itemerness:font/canvas/aurora_horizontal_rule.png",
        sourceWidthPixels: 140,
        sourceHeightPixels: 2,
        renderWidthPixels: 140,
        renderHeightPixels: 2,
        ascentPixels: 1,
        visualBounds: { left: 0, right: 140, top: -1, bottom: 1 },
    },
    {
        uuid: uuid(),
        id: "canvas.aurora.emblem",
        baselineVariant: "canvas.aurora.emblem",
        texture: "itemerness:font/canvas/aurora_emblem.png",
        sourceWidthPixels: 16,
        sourceHeightPixels: 16,
        renderWidthPixels: 16,
        renderHeightPixels: 16,
        ascentPixels: 16,
        visualBounds: { left: 0, right: 16, top: -16, bottom: 0 },
    },
    {
        uuid: uuid(),
        id: "frame.segment.body-fill",
        baselineVariant: null,
        texture: "itemerness:font/frame/body_fill.png",
        sourceWidthPixels: 1,
        sourceHeightPixels: 10,
        renderWidthPixels: 1,
        renderHeightPixels: 10,
        ascentPixels: 8,
        visualBounds: { left: 0, right: 1, top: -8, bottom: 2 },
    },
];

const viewerFacts: ViewerFactNode[] = [
    {
        uuid: uuid(),
        id: "itemerness:locale",
        type: "LOCALE",
        providers: ["api", "player-override", "client"],
        defaultValue: str("en_us"),
        nullable: false,
        cacheKey: true,
        previewValue: str("en_us"),
    },
    {
        uuid: uuid(),
        id: "itemerness:theme",
        type: "NAMESPACED_KEY",
        providers: ["api", "player-override"],
        defaultValue: null,
        nullable: true,
        cacheKey: true,
        previewValue: null,
    },
    {
        uuid: uuid(),
        id: "itemerness:resource-pack-ready",
        type: "BOOLEAN",
        providers: ["bukkit-resource-pack-status"],
        defaultValue: bool(false),
        nullable: false,
        cacheKey: true,
        previewValue: bool(true),
    },
    {
        uuid: uuid(),
        id: "itemerness:asset-profile",
        type: "NAMESPACED_KEY",
        providers: ["api", "bukkit-resource-pack-status"],
        defaultValue: str("itemerness:vanilla"),
        nullable: false,
        cacheKey: true,
        previewValue: str("itemerness:example-pack-v1"),
    },
    {
        uuid: uuid(),
        id: "example:level",
        type: "INTEGER",
        providers: ["api"],
        defaultValue: int(0),
        nullable: false,
        cacheKey: true,
        previewValue: int(8),
    },
    {
        uuid: uuid(),
        id: "example:class",
        type: "NAMESPACED_KEY",
        providers: ["api"],
        defaultValue: null,
        nullable: true,
        cacheKey: true,
        previewValue: null,
    },
];

const bodyWrapping = {
    widthPixels: null,
    maximumLines: 16,
    overflow: "ELLIPSIS" as const,
    preserveExplicitLines: true,
    continuationIndentPixels: 0,
    lineHeightPixels: 10,
};

const layouts: LayoutNode[] = [
    {
        uuid: uuid(),
        kind: "flow",
        id: "itemerness:plain",
        minimumWidthPixels: 80,
        maximumWidthPixels: 220,
        blockGapAfterPixels: 0,
        fieldLeftPaddingPixels: 0,
        fieldIconGapPixels: 0,
        fieldValueAlignment: "LEFT",
        descriptionLeftPaddingPixels: 0,
        descriptionRightPaddingPixels: 0,
        descriptionGapBeforePixels: 0,
        wrapping: { body: bodyWrapping },
    },
    {
        uuid: uuid(),
        kind: "flow",
        id: "itemerness:equipment",
        minimumWidthPixels: 140,
        maximumWidthPixels: 220,
        blockGapAfterPixels: 0,
        fieldLeftPaddingPixels: 8,
        fieldIconGapPixels: 3,
        fieldValueAlignment: "RIGHT",
        descriptionLeftPaddingPixels: 8,
        descriptionRightPaddingPixels: 8,
        descriptionGapBeforePixels: 10,
        wrapping: { body: { ...bodyWrapping, maximumLines: 12 } },
    },
    {
        uuid: uuid(),
        kind: "canvas",
        id: "itemerness:bitmap-canvas",
        widthPixels: 176,
        heightPixels: 96,
        maximumWidthPixels: 220,
        maximumHeightPixels: 180,
        reserveTooltipLines: 10,
        anchors: {
            subtitle: {
                x: 18,
                y: 16,
                width: 140,
                height: 10,
                overflow: "ELLIPSIS",
            },
            region: {
                x: 18,
                y: 36,
                width: 140,
                height: 10,
                overflow: "ELLIPSIS",
            },
            body: {
                x: 18,
                y: 56,
                width: 140,
                height: 40,
                overflow: "ELLIPSIS",
            },
        },
        wrapping: {
            "canvas-body": {
                widthPixels: 140,
                maximumLines: 4,
                overflow: "ELLIPSIS",
                preserveExplicitLines: true,
                continuationIndentPixels: 0,
                lineHeightPixels: 10,
            },
        },
    },
];

const plainStyles = {
    "item-name": {
        color: "white",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
    label: {
        color: "gray",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
    value: {
        color: "white",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
    "requirement-met": {
        color: "green",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
    "requirement-unmet": {
        color: "red",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
    description: {
        color: "dark_gray",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
};

const emberStyles = {
    "item-name": {
        color: "#ffcf7a",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
    label: {
        color: "#c69b72",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
    value: {
        color: "#fff0d0",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
    "requirement-met": {
        color: "#8bd17c",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
    "requirement-unmet": {
        color: "#ff6961",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
    description: {
        color: "#e6c9a8",
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
    },
};

const themes: ThemeNode[] = [
    {
        uuid: uuid(),
        id: "itemerness:default",
        renderer: "PLAIN",
        requiresResourcePack: false,
        requiredCapabilities: [],
        vanillaTooltipLines: "PRESERVE",
        fallback: null,
        fonts: { text: "minecraft:default" },
        styles: plainStyles,
        tooltipStyle: null,
        requireExactFontMetrics: false,
        content: null,
        characterFrame: null,
        segmentedFrame: null,
        canvas: null,
    },
    {
        uuid: uuid(),
        id: "itemerness:vanilla-frame",
        renderer: "VANILLA_CHARACTER_FRAME",
        requiresResourcePack: false,
        requiredCapabilities: [],
        vanillaTooltipLines: "PRESERVE_OUTSIDE_FRAME",
        fallback: "itemerness:default",
        fonts: { text: "minecraft:uniform", frame: "minecraft:uniform" },
        styles: {
            ...plainStyles,
            frame: {
                color: "dark_gray",
                bold: false,
                italic: false,
                underlined: false,
                strikethrough: false,
            },
        },
        tooltipStyle: null,
        requireExactFontMetrics: false,
        content: null,
        characterFrame: {
            preset: "UNICODE_SINGLE",
            minimumWidthPixels: 80,
            maximumWidthPixels: 220,
            leftPaddingPixels: 4,
            rightPaddingPixels: 4,
            alignmentTolerancePixels: 3,
            maximumLines: 16,
            fallbackBidirectionalText: true,
        },
        segmentedFrame: null,
        canvas: null,
    },
    {
        uuid: uuid(),
        id: "itemerness:ember",
        renderer: "NATIVE_TOOLTIP_STYLE",
        requiresResourcePack: true,
        requiredCapabilities: ["itemerness:native-tooltip-style-v1"],
        vanillaTooltipLines: "PRESERVE",
        fallback: "itemerness:vanilla-frame",
        fonts: { text: "itemerness:body", icons: "itemerness:icons" },
        styles: emberStyles,
        tooltipStyle: "itemerness:ember",
        requireExactFontMetrics: false,
        content: {
            minimumWidthPixels: 140,
            maximumWidthPixels: 220,
            leftPaddingPixels: 8,
            rightPaddingPixels: 8,
        },
        characterFrame: null,
        segmentedFrame: null,
        canvas: null,
    },
    {
        uuid: uuid(),
        id: "itemerness:segmented",
        renderer: "SEGMENTED_FRAME",
        requiresResourcePack: true,
        requiredCapabilities: ["itemerness:segmented-frame-v1"],
        vanillaTooltipLines: "REQUIRE_MANAGED",
        fallback: "itemerness:vanilla-frame",
        fonts: {
            text: "itemerness:body",
            icons: "itemerness:icons",
            frame: "itemerness:frame",
        },
        styles: emberStyles,
        tooltipStyle: null,
        requireExactFontMetrics: false,
        content: null,
        characterFrame: null,
        segmentedFrame: {
            minimumWidthPixels: 140,
            maximumWidthPixels: 220,
            leftPaddingPixels: 12,
            rightPaddingPixels: 12,
            top: {
                left: "frame.segment.top-left",
                fill: "frame.segment.top-fill",
                right: "frame.segment.top-right",
            },
            body: {
                left: "frame.segment.body-left",
                fill: "frame.segment.body-fill",
                right: "frame.segment.body-right",
            },
            connector: {
                left: "frame.segment.connector-left",
                fill: "frame.segment.connector-fill",
                right: "frame.segment.connector-right",
            },
            bottom: {
                left: "frame.segment.bottom-left",
                fill: "frame.segment.bottom-fill",
                right: "frame.segment.bottom-right",
            },
        },
        canvas: null,
    },
    {
        uuid: uuid(),
        id: "itemerness:aurora-canvas",
        renderer: "BITMAP_CANVAS",
        requiresResourcePack: true,
        requiredCapabilities: [
            "itemerness:bitmap-canvas-v1",
            "itemerness:signed-advance-v1",
        ],
        vanillaTooltipLines: "REQUIRE_MANAGED",
        fallback: "itemerness:ember",
        fonts: {
            text: "itemerness:body",
            icons: "itemerness:icons",
            canvas: "itemerness:canvas",
            spacing: "itemerness:spacing",
        },
        styles: emberStyles,
        tooltipStyle: "itemerness:transparent-canvas",
        requireExactFontMetrics: true,
        content: null,
        characterFrame: null,
        segmentedFrame: null,
        canvas: {
            widthPixels: 176,
            heightPixels: 96,
            maximumWidthPixels: 220,
            maximumHeightPixels: 180,
            reserveTooltipLines: 10,
            layers: [
                {
                    asset: "canvas.aurora.background",
                    anchor: "TOP_LEFT",
                    xPixels: 0,
                    baselineLine: 9,
                    baselineVariant: "canvas.aurora.panel",
                    drawOrder: 0,
                },
                {
                    asset: "canvas.aurora.horizontal-rule",
                    anchor: "TOP_LEFT",
                    xPixels: 18,
                    baselineLine: 4,
                    baselineVariant: "canvas.aurora.rule",
                    drawOrder: 1,
                },
                {
                    asset: "canvas.aurora.emblem",
                    anchor: "TOP_RIGHT",
                    xPixels: -24,
                    baselineLine: 2,
                    baselineVariant: "canvas.aurora.emblem",
                    drawOrder: 2,
                },
            ],
            measuredAdvancePixels: 176,
            finalTooltipWidthPixels: 176,
            rejectNegativeFinalAdvance: true,
            rejectOutOfBoundsLayer: true,
            maximumEmittedComponents: 256,
            normalizeVisualOrigin: true,
        },
    },
];

const emptyConstraints = {
    minimum: null,
    maximum: null,
    scale: null,
    maximumCodePoints: null,
    maximumElements: null,
    maximumEntries: null,
    maximumDepth: null,
    allowedValues: [],
};

const dataSchemas: DataSchemaNode[] = [
    {
        uuid: uuid(),
        id: "itemerness:common",
        version: 1,
        keys: [
            {
                uuid: uuid(),
                id: "itemerness:created-at",
                type: { kind: "long" },
                scope: "INSTANCE",
                nullable: false,
                defaultValue: null,
                affectsStacking: true,
                presentationReadable: true,
                constraints: emptyConstraints,
            },
            {
                uuid: uuid(),
                id: "example:quality",
                type: { kind: "namespacedKey" },
                scope: "INSTANCE",
                nullable: true,
                defaultValue: str("example:common"),
                affectsStacking: true,
                presentationReadable: true,
                constraints: {
                    ...emptyConstraints,
                    allowedValues: [
                        str("example:common"),
                        str("example:uncommon"),
                        str("example:rare"),
                        str("example:epic"),
                    ],
                },
            },
            {
                uuid: uuid(),
                id: "example:attack-damage",
                type: { kind: "decimal" },
                scope: "INSTANCE",
                nullable: false,
                defaultValue: dec("1.0"),
                affectsStacking: true,
                presentationReadable: true,
                constraints: {
                    ...emptyConstraints,
                    minimum: "0.0",
                    maximum: "1000000.0",
                    scale: 2,
                },
            },
            {
                uuid: uuid(),
                id: "example:required-level",
                type: { kind: "integer" },
                scope: "DEFINITION",
                nullable: false,
                defaultValue: int(1),
                affectsStacking: false,
                presentationReadable: true,
                constraints: {
                    ...emptyConstraints,
                    minimum: "1",
                    maximum: "1000",
                },
            },
            {
                uuid: uuid(),
                id: "example:bound",
                type: { kind: "boolean" },
                scope: "INSTANCE",
                nullable: false,
                defaultValue: bool(false),
                affectsStacking: true,
                presentationReadable: true,
                constraints: emptyConstraints,
            },
            {
                uuid: uuid(),
                id: "example:bound-player",
                type: { kind: "uuid" },
                scope: "INSTANCE",
                nullable: true,
                defaultValue: null,
                affectsStacking: true,
                presentationReadable: false,
                constraints: emptyConstraints,
            },
            {
                uuid: uuid(),
                id: "example:charges",
                type: { kind: "integer" },
                scope: "INSTANCE",
                nullable: false,
                defaultValue: int(0),
                affectsStacking: true,
                presentationReadable: true,
                constraints: {
                    ...emptyConstraints,
                    minimum: "0",
                    maximum: "9999",
                },
            },
            {
                uuid: uuid(),
                id: "example:region",
                type: { kind: "namespacedKey" },
                scope: "INSTANCE",
                nullable: true,
                defaultValue: null,
                affectsStacking: true,
                presentationReadable: true,
                constraints: emptyConstraints,
            },
            {
                uuid: uuid(),
                id: "example:custom-label",
                type: { kind: "string" },
                scope: "INSTANCE",
                nullable: true,
                defaultValue: null,
                affectsStacking: true,
                presentationReadable: true,
                constraints: { ...emptyConstraints, maximumCodePoints: 128 },
            },
            {
                uuid: uuid(),
                id: "example:tags",
                type: { kind: "list", element: { kind: "namespacedKey" } },
                scope: "INSTANCE",
                nullable: false,
                defaultValue: list(),
                affectsStacking: true,
                presentationReadable: true,
                constraints: { ...emptyConstraints, maximumElements: 32 },
            },
            {
                uuid: uuid(),
                id: "example:sockets",
                type: {
                    kind: "list",
                    element: {
                        kind: "compound",
                        fields: [
                            {
                                name: "type",
                                type: { kind: "namespacedKey" },
                                nullable: false,
                            },
                            {
                                name: "accepted",
                                type: {
                                    kind: "list",
                                    element: { kind: "namespacedKey" },
                                },
                                nullable: false,
                            },
                            {
                                name: "inserted",
                                type: { kind: "namespacedKey" },
                                nullable: true,
                            },
                        ],
                    },
                },
                scope: "INSTANCE",
                nullable: false,
                defaultValue: list(),
                affectsStacking: true,
                presentationReadable: true,
                constraints: {
                    ...emptyConstraints,
                    maximumElements: 8,
                    maximumDepth: 4,
                },
            },
            {
                uuid: uuid(),
                id: "example:metadata",
                type: { kind: "compound", fields: null },
                scope: "INSTANCE",
                nullable: false,
                defaultValue: compound({}),
                affectsStacking: true,
                presentationReadable: false,
                constraints: {
                    ...emptyConstraints,
                    maximumEntries: 32,
                    maximumDepth: 4,
                },
            },
        ],
    },
];

const field = (
    labelMessage: string,
    data: string,
    options: Partial<Extract<PresentationBlock, { type: "field" }>> = {},
): PresentationBlock => ({
    uuid: uuid(),
    type: "field",
    labelMessage,
    data,
    format: null,
    icon: null,
    style: null,
    anchor: null,
    wrapping: null,
    missingPolicy: "ERROR",
    ...options,
});

const description = (
    message: string,
    options: Partial<Extract<PresentationBlock, { type: "description" }>> = {},
): PresentationBlock => ({
    uuid: uuid(),
    type: "description",
    message,
    style: "description",
    anchor: null,
    wrapping: "body",
    ...options,
});

const items: ItemNode[] = [
    {
        uuid: uuid(),
        id: "travel-token",
        enabled: true,
        definition: {
            material: "minecraft:paper",
            baseComponents: [
                { id: "minecraft:max_stack_size", value: int(16) },
                {
                    id: "minecraft:enchantment_glint_override",
                    value: bool(false),
                },
                { id: "minecraft:item_model", value: str("minecraft:paper") },
                { id: "minecraft:rarity", value: str("uncommon") },
            ],
            contentComponent: null,
            contents: [],
            definitionData: [],
            instance: {
                mode: "FUNGIBLE",
                idGenerator: null,
                schemas: [{ id: "itemerness:common", version: 1 }],
                defaults: [
                    { key: "example:region", value: str("example:harbor") },
                    { key: "example:charges", value: int(3) },
                ],
                generators: [
                    { kind: "unixMillis", key: "itemerness:created-at" },
                ],
            },
        },
        presentation: {
            layout: "itemerness:plain",
            theme: "itemerness:vanilla-frame",
            nameMessage: "item.travel-token.name",
            blocks: [
                field("data.region.label", "example:region", {
                    icon: "icon.region",
                    missingPolicy: "OMIT",
                    format: "itemerness:key-message",
                }),
                field("data.charges.label", "example:charges", {
                    icon: "icon.charges",
                    format: "itemerness:integer",
                }),
                description("item.travel-token.description"),
            ],
        },
        previewData: [
            { key: "example:region", value: str("example:harbor") },
            { key: "example:charges", value: int(3) },
            { key: "itemerness:created-at", value: int(1785000000000) },
        ],
    },
    {
        uuid: uuid(),
        id: "ember-blade",
        enabled: true,
        definition: {
            material: "minecraft:netherite_sword",
            baseComponents: [
                { id: "minecraft:max_stack_size", value: int(1) },
                { id: "minecraft:max_damage", value: int(2031) },
                { id: "minecraft:damage", value: int(0) },
                { id: "minecraft:unbreakable", value: bool(true) },
                { id: "minecraft:repair_cost", value: int(0) },
            ],
            contentComponent: null,
            contents: [],
            definitionData: [{ key: "example:required-level", value: int(12) }],
            instance: {
                mode: "UNIQUE",
                idGenerator: "UUID_V4",
                schemas: [{ id: "itemerness:common", version: 1 }],
                defaults: [
                    { key: "example:quality", value: str("example:rare") },
                    { key: "example:bound", value: bool(false) },
                    {
                        key: "example:tags",
                        value: list(str("example:weapon"), str("example:fire")),
                    },
                ],
                generators: [
                    { kind: "unixMillis", key: "itemerness:created-at" },
                    {
                        kind: "randomDecimal",
                        key: "example:attack-damage",
                        minimum: "34.0",
                        maximum: "42.0",
                        scale: 1,
                    },
                ],
            },
        },
        presentation: {
            layout: "itemerness:equipment",
            theme: "itemerness:ember",
            nameMessage: "item.ember-blade.name",
            blocks: [
                field("data.attack-damage.label", "example:attack-damage", {
                    icon: "icon.attack",
                    format: "itemerness:decimal-one",
                }),
                field("data.quality.label", "example:quality", {
                    icon: "icon.quality",
                    missingPolicy: "OMIT",
                    format: "itemerness:key-message",
                }),
                {
                    uuid: uuid(),
                    type: "conditional",
                    condition: {
                        operator: "LESS_THAN",
                        left: { kind: "fact", key: "example:level" },
                        right: { kind: "data", key: "example:required-level" },
                    },
                    thenBlocks: [
                        field(
                            "data.required-level.label",
                            "example:required-level",
                            {
                                style: "requirement-unmet",
                                format: "itemerness:integer",
                            },
                        ),
                    ],
                    otherwiseBlocks: [
                        field(
                            "data.required-level.label",
                            "example:required-level",
                            {
                                style: "requirement-met",
                                format: "itemerness:integer",
                            },
                        ),
                    ],
                    style: null,
                    anchor: null,
                },
                {
                    uuid: uuid(),
                    type: "repeat",
                    data: "example:sockets",
                    maximumElements: 8,
                    template: {
                        labelMessage: "data.socket.label",
                        valuePath: "inserted",
                        missingMessage: "data.socket.empty",
                        icon: "icon.socket",
                        format: null,
                    },
                    style: null,
                    anchor: null,
                    missingPolicy: "ERROR",
                },
                description("item.ember-blade.description"),
            ],
        },
        previewData: [
            { key: "example:attack-damage", value: dec("38.5") },
            { key: "example:quality", value: str("example:rare") },
            { key: "example:bound", value: bool(false) },
            {
                key: "example:tags",
                value: list(str("example:weapon"), str("example:fire")),
            },
            {
                key: "example:sockets",
                value: list(
                    compound({
                        type: str("example:gem"),
                        accepted: list(str("example:fire-gem")),
                        inserted: str("example:fire-gem"),
                    }),
                    compound({
                        type: str("example:gem"),
                        accepted: list(str("example:fire-gem")),
                    }),
                ),
            },
            { key: "itemerness:created-at", value: int(1785000000000) },
        ],
    },
    {
        uuid: uuid(),
        id: "survey-codex",
        enabled: true,
        definition: {
            material: "minecraft:book",
            baseComponents: [{ id: "minecraft:max_stack_size", value: int(1) }],
            contentComponent: null,
            contents: [],
            definitionData: [],
            instance: {
                mode: "UNIQUE",
                idGenerator: "UUID_V4",
                schemas: [{ id: "itemerness:common", version: 1 }],
                defaults: [
                    {
                        key: "example:region",
                        value: str("example:aurora-expanse"),
                    },
                    { key: "example:custom-label", value: str("Expedition 7") },
                    {
                        key: "example:metadata",
                        value: compound({
                            completion: dec("0.625"),
                            discovered: int(18),
                            total: int(32),
                        }),
                    },
                ],
                generators: [
                    { kind: "unixMillis", key: "itemerness:created-at" },
                ],
            },
        },
        presentation: {
            layout: "itemerness:bitmap-canvas",
            theme: "itemerness:aurora-canvas",
            nameMessage: "item.survey-codex.name",
            blocks: [
                {
                    uuid: uuid(),
                    type: "text",
                    data: "example:custom-label",
                    style: null,
                    anchor: "subtitle",
                    wrapping: null,
                    unbreakable: false,
                    missingPolicy: "OMIT",
                },
                field("data.region.label", "example:region", {
                    icon: "icon.region",
                    anchor: "region",
                    missingPolicy: "OMIT",
                    format: "itemerness:key-message",
                }),
                description("item.survey-codex.description", {
                    anchor: "body",
                    wrapping: "canvas-body",
                }),
            ],
        },
        previewData: [
            { key: "example:region", value: str("example:aurora-expanse") },
            { key: "example:custom-label", value: str("Expedition 7") },
            { key: "itemerness:created-at", value: int(1785000000000) },
        ],
    },
    {
        uuid: uuid(),
        id: "nested-satchel",
        enabled: true,
        definition: {
            material: "minecraft:bundle",
            baseComponents: [],
            contentComponent: "BUNDLE",
            contents: [{ item: "itemerness:travel-token", amount: 2 }],
            definitionData: [],
            instance: {
                mode: "UNIQUE",
                idGenerator: "UUID_V4",
                schemas: [{ id: "itemerness:common", version: 1 }],
                defaults: [
                    { key: "example:quality", value: str("example:uncommon") },
                ],
                generators: [
                    { kind: "unixMillis", key: "itemerness:created-at" },
                ],
            },
        },
        presentation: {
            layout: "itemerness:plain",
            theme: "itemerness:default",
            nameMessage: "item.nested-satchel.name",
            blocks: [
                {
                    uuid: uuid(),
                    type: "nestedItemList",
                    style: null,
                    anchor: null,
                },
                description("item.nested-satchel.description"),
            ],
        },
        previewData: [
            { key: "example:quality", value: str("example:uncommon") },
            { key: "itemerness:created-at", value: int(1785000000000) },
        ],
    },
    {
        uuid: uuid(),
        id: "framed-relic",
        enabled: true,
        definition: {
            material: "minecraft:echo_shard",
            baseComponents: [],
            contentComponent: null,
            contents: [],
            definitionData: [],
            instance: {
                mode: "FUNGIBLE",
                idGenerator: null,
                schemas: [{ id: "itemerness:common", version: 1 }],
                defaults: [
                    { key: "example:quality", value: str("example:epic") },
                    {
                        key: "example:region",
                        value: str("example:ancient-vault"),
                    },
                ],
                generators: [
                    { kind: "unixMillis", key: "itemerness:created-at" },
                ],
            },
        },
        presentation: {
            layout: "itemerness:equipment",
            theme: "itemerness:segmented",
            nameMessage: "item.framed-relic.name",
            blocks: [
                field("data.quality.label", "example:quality", {
                    icon: "icon.quality",
                    missingPolicy: "OMIT",
                    format: "itemerness:key-message",
                }),
                field("data.region.label", "example:region", {
                    icon: "icon.region",
                    missingPolicy: "OMIT",
                    format: "itemerness:key-message",
                }),
                description("item.framed-relic.description"),
            ],
        },
        previewData: [
            { key: "example:quality", value: str("example:epic") },
            { key: "example:region", value: str("example:ancient-vault") },
            { key: "itemerness:created-at", value: int(1785000000000) },
        ],
    },
];

const raw = {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    documentId: "00000000-0000-4000-8000-0000000000ff",
    namespace: "itemerness",
    defaultLocale: "en_us",
    budgets: {},
    formats,
    locales,
    fonts,
    glyphs,
    bitmaps,
    assetProfiles: [
        {
            uuid: uuid(),
            id: "itemerness:vanilla",
            capabilities: [],
            metricsRevision: null,
            fallback: null,
        },
        {
            uuid: uuid(),
            id: "itemerness:example-pack-v1",
            capabilities: [
                "itemerness:native-tooltip-style-v1",
                "itemerness:segmented-frame-v1",
                "itemerness:signed-advance-v1",
                "itemerness:bitmap-canvas-v1",
            ],
            metricsRevision: "itemerness:example-pack-v1",
            fallback: "itemerness:vanilla",
        },
    ],
    resourcePackBindings: [
        {
            uuid: uuid(),
            id: "itemerness:example-pack-v1",
            enabled: false,
            packId: "00000000-0000-0000-0000-000000000001",
            sha1: "0000000000000000000000000000000000000001",
            assetProfile: "itemerness:example-pack-v1",
        },
    ],
    tooltipStyles: [
        {
            uuid: uuid(),
            id: "itemerness:ember",
            expectedBackgroundSprite: "itemerness:tooltip/ember_background",
            expectedFrameSprite: "itemerness:tooltip/ember_frame",
            scaling: "nine-slice",
        },
        {
            uuid: uuid(),
            id: "itemerness:transparent-canvas",
            expectedBackgroundSprite:
                "itemerness:tooltip/transparent-canvas_background",
            expectedFrameSprite: "itemerness:tooltip/transparent-canvas_frame",
            scaling: "stretch",
        },
    ],
    spacing: {
        font: "itemerness:spacing",
        negative: {
            firstCodePoint: 0xf0000,
            lastCodePoint: 0xf00ff,
            minimumAdvancePixels: -256,
            maximumAdvancePixels: -1,
        },
        positive: {
            firstCodePoint: 0xf0100,
            lastCodePoint: 0xf01ff,
            minimumAdvancePixels: 1,
            maximumAdvancePixels: 256,
        },
    },
    viewerFacts,
    layouts,
    themes,
    dataSchemas,
    items,
    accessPolicies: [],
};

/** The parsed, defaulted baseline document. */
export const baselineDocument: ProjectDocument =
    projectDocumentSchema.parse(raw);

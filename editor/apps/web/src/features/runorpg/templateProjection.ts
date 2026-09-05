import {
    qualityThemeOf,
    type DataSchemaNode,
    type DataValue,
    type ItemTemplate,
    type PresentationBlock,
    type ProjectDocument,
    type RunoRpgAttributeDefinition,
    type RunoRpgCatalogItem,
} from "@itemerness/protocol";
import { newUuid } from "../common/uuid.js";

const EMPTY_CONSTRAINTS = {
    minimum: null,
    maximum: null,
    scale: null,
    maximumCodePoints: null,
    maximumElements: null,
    maximumEntries: null,
    maximumDepth: null,
    allowedValues: [] as DataValue[],
};

const EQUIPMENT_TYPES = new Set([
    "ACCESSORIES",
    "AMULET",
    "BOW",
    "BRACELET",
    "CROSSBOW",
    "DAGGER",
    "GREAT_SWORD",
    "LIGHT_ARMOR",
    "OFF_DAGGER",
    "PLATE_ARMOR",
    "RING",
    "ROBE",
    "SHIELD",
    "SKIN_ARMOR",
    "SPEAR",
    "STAFF",
    "SWORD",
    "WAND",
]);

/** Path half of a template id, e.g. `runocraft:template-sword` -> `template-sword`. */
export function templateLocalId(template: ItemTemplate): string {
    return template.id.split(":", 2)[1] ?? template.id;
}

/**
 * A new prefab, named uniquely against `existing`.
 *
 * It starts at common quality, so the very first preview already draws the pack's frame rather
 * than the character-art fallback an author would otherwise have to diagnose.
 */
export function newItemTemplate(
    existing: readonly ItemTemplate[],
    displayName: string,
): ItemTemplate {
    let counter = 1;
    const taken = new Set(existing.map((template) => template.id));
    while (taken.has(`runocraft:template-${counter}`)) counter += 1;
    return {
        uuid: newUuid(),
        id: `runocraft:template-${counter}`,
        displayName,
        description: "",
        enabled: true,
        revision: 0,
        material: "minecraft:iron_sword",
        layout: "itemerness:equipment",
        theme: qualityThemeOf("common")!,
        mode: "unique",
        maxStackSize: 1,
        unbreakable: false,
        itemTier: "common",
        itemLevel: 1,
        itemPrefix: "",
        baseModifiers: [],
        baseSkills: [],
        presentationBlocks: [],
        presentationMessages: {},
    };
}

/**
 * Presents a template as the item it would produce, so the stage can render a prefab through the
 * exact projection a live catalogue item goes through. Nothing here is written anywhere; the
 * synthetic source file and hash exist only to satisfy the shared shape.
 */
export function catalogItemFromTemplate(
    template: ItemTemplate,
): RunoRpgCatalogItem {
    return {
        id: template.id,
        localId: templateLocalId(template),
        sourceFile: "templates/(draft)",
        fileHash: `sha256:${"0".repeat(64)}`,
        displayName: template.displayName,
        description: template.description,
        enabled: template.enabled,
        material: template.material,
        layout: template.layout,
        theme: template.theme,
        mode: template.mode,
        maxStackSize: template.maxStackSize,
        unbreakable: template.unbreakable,
        vanillaAttributesDisabled: true,
        schemas: ["runorpg:item-stats@1", "runorpg:item-skill-contract@1"],
        legacyReference: null,
        requiredLevel: null,
        itemLevel: template.itemLevel,
        itemTier: template.itemTier,
        itemPrefix: template.itemPrefix,
        modifiers: template.baseModifiers,
        skills: template.baseSkills,
        presentationBlocks: template.presentationBlocks,
        presentationMessages: template.presentationMessages,
    };
}

function uuid(index: number): string {
    return `f0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function stringValue(value: string): DataValue {
    return { kind: "string", value };
}

function integerValue(value: number): DataValue {
    return { kind: "integer", value: String(value) };
}

function decimalLiteral(value: number): string {
    return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * What an item should look like when it does not say.
 *
 * Quality decides the frame whenever the pack has art for that tier — an item's border is a
 * statement about how good it is, so a "rare" item that draws the common frame is simply wrong. The
 * equipment/plain split only decides the fallback for items with no recognised tier.
 */
export function defaultRunoRpgAppearance(item: RunoRpgCatalogItem): {
    layout: string;
    theme: string;
} {
    const legacyType = item.legacyReference?.split(":", 1)[0] ?? "";
    const material = item.material.split(":", 2)[1] ?? item.material;
    const equipmentMaterial =
        /(?:^|_)(?:sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$/u.test(
            material,
        ) ||
        ["bow", "crossbow", "trident", "mace", "shield"].includes(material);
    const equipment =
        EQUIPMENT_TYPES.has(legacyType) ||
        equipmentMaterial ||
        /(?:weapons|harvest-tools)/u.test(item.sourceFile);
    const layout = equipment ? "itemerness:equipment" : "itemerness:plain";
    const quality = qualityThemeOf(item.itemTier);
    if (quality) return { layout, theme: quality };
    return {
        layout,
        theme: equipment ? "itemerness:ember" : "itemerness:vanilla-frame",
    };
}

function modifierText(value: number, relative: boolean): string {
    const rounded = Number.isInteger(value) ? String(value) : String(value);
    const sign = value > 0 ? "+" : "";
    return `${sign}${rounded}${relative ? "%" : ""}`;
}

function repeatBlock(
    uuid: string,
    data: "runorpg:attribute-lore" | "runorpg:item-skills",
): PresentationBlock {
    const attributes = data === "runorpg:attribute-lore";
    return {
        uuid,
        type: "repeat",
        data,
        maximumElements: attributes ? 128 : 32,
        template: {
            labelMessage: attributes
                ? "runorpg.data.attribute.label"
                : "runorpg.data.skill.label",
            valuePath: "lore",
            missingMessage: attributes
                ? "runorpg.data.attribute.missing"
                : "runorpg.data.skill.missing",
            icon: null,
            format: null,
        },
        style: null,
        anchor: null,
        missingPolicy: "OMIT",
    };
}

export function effectiveRunoRpgBlocks(
    item: RunoRpgCatalogItem,
): PresentationBlock[] {
    const blocks = structuredClone(item.presentationBlocks ?? []);
    const hasAttributes = blocks.some(
        (block) =>
            block.type === "repeat" && block.data === "runorpg:attribute-lore",
    );
    const hasSkills = blocks.some(
        (block) =>
            block.type === "repeat" && block.data === "runorpg:item-skills",
    );
    let insertion = 0;
    if (item.modifiers.length > 0 && !hasAttributes) {
        blocks.splice(
            insertion++,
            0,
            repeatBlock(
                `a0000000-0000-4000-8000-${item.localId.length.toString(16).padStart(12, "0")}`,
                "runorpg:attribute-lore",
            ),
        );
    }
    if (item.skills.some((skill) => !skill.hidden) && !hasSkills) {
        blocks.splice(
            insertion,
            0,
            repeatBlock(
                `b0000000-0000-4000-8000-${item.localId.length.toString(16).padStart(12, "0")}`,
                "runorpg:item-skills",
            ),
        );
    }
    if (
        item.description.trim() !== "" &&
        !blocks.some((block) => block.type === "description")
    ) {
        blocks.push({
            uuid: `c0000000-0000-4000-8000-${item.localId.length.toString(16).padStart(12, "0")}`,
            type: "description",
            message: "runorpg.preview.description",
            style: "description",
            anchor: null,
            wrapping: "body",
        });
    }
    return blocks;
}

/**
 * Builds one preview-only Itemerness document for a live RunoRPG item. Runtime attributes and
 * MythicMobs execution stay in RunoRPG; this projection only gives them the normal template/Lore
 * rendering path.
 */
export function projectRunoRpgTemplate(
    base: ProjectDocument,
    item: RunoRpgCatalogItem,
    attributes: readonly RunoRpgAttributeDefinition[],
): ProjectDocument {
    let nextUuid = 1;
    const id = () => uuid(nextUuid++);
    const messages: Record<string, string> = {
        ...(item.presentationMessages ?? {}),
        "runorpg.preview.name": item.displayName,
        "runorpg.preview.description": item.description,
        "runorpg.data.attribute.label": "属性",
        "runorpg.data.attribute.missing": "未知属性",
        "runorpg.data.skill.label": "技能",
        "runorpg.data.skill.missing": "未知技能",
        "runorpg.data.item-level.label": "物品等级",
        "runorpg.data.item-tier.label": "品质",
        "runorpg.data.item-prefix.label": "前缀",
    };
    const attributeNames = new Map(
        attributes.map((entry) => [entry.id, entry.name]),
    );
    const scalarKey = (
        key: string,
        type: { kind: "integer" } | { kind: "string" },
    ): DataSchemaNode["keys"][number] => ({
        uuid: id(),
        id: key,
        type,
        scope: "INSTANCE",
        nullable: false,
        defaultValue:
            type.kind === "integer" ? integerValue(0) : stringValue(""),
        affectsStacking: true,
        presentationReadable: true,
        constraints: EMPTY_CONSTRAINTS,
    });
    const loreList = (key: string): DataSchemaNode["keys"][number] => ({
        uuid: id(),
        id: key,
        type: {
            kind: "list",
            element: {
                kind: "compound",
                fields: [
                    { name: "lore", type: { kind: "string" }, nullable: false },
                ],
            },
        },
        scope: "INSTANCE",
        nullable: false,
        defaultValue: { kind: "list", values: [] },
        affectsStacking: true,
        presentationReadable: true,
        constraints: {
            ...EMPTY_CONSTRAINTS,
            maximumElements: 128,
            maximumDepth: 2,
        },
    });
    const keys: DataSchemaNode["keys"] = [
        scalarKey("runorpg:item-level", { kind: "integer" }),
        scalarKey("runorpg:item-tier", { kind: "string" }),
        scalarKey("runorpg:item-prefix", { kind: "string" }),
        loreList("runorpg:attribute-lore"),
        loreList("runorpg:item-skills"),
    ];
    const attributeLore: DataValue = {
        kind: "list",
        values: item.modifiers.map((modifier) => {
            const definition = attributes.find(
                (entry) => entry.id === modifier.attribute,
            );
            const name =
                definition?.name ??
                attributeNames.get(modifier.attribute) ??
                modifier.attribute.split(":", 2)[1]!.replaceAll("_", " ");
            return {
                kind: "compound",
                entries: {
                    lore: stringValue(
                        `§7${name}: §f${modifierText(
                            modifier.value,
                            definition?.percent === true ||
                                modifier.operation === "runorpg:relative",
                        )}`,
                    ),
                },
            };
        }),
    };
    const skillLore: DataValue = {
        kind: "list",
        values: item.skills
            .filter((skill) => !skill.hidden)
            .map((skill) => ({
                kind: "compound",
                entries: { lore: stringValue(skill.lore) },
            })),
    };
    const previewData: ProjectDocument["items"][number]["previewData"] = [
        {
            key: "runorpg:item-level",
            value: integerValue(item.itemLevel ?? item.requiredLevel ?? 0),
        },
        { key: "runorpg:item-tier", value: stringValue(item.itemTier ?? "") },
        {
            key: "runorpg:item-prefix",
            value: stringValue(item.itemPrefix ?? ""),
        },
        { key: "runorpg:attribute-lore", value: attributeLore },
        { key: "runorpg:item-skills", value: skillLore },
    ];
    const blocks = effectiveRunoRpgBlocks(item);

    const schema: DataSchemaNode = {
        uuid: id(),
        id: "runorpg:item-stats",
        version: 1,
        keys,
    };
    const appearance = defaultRunoRpgAppearance(item);
    const viewerFacts = [
        {
            uuid: id(),
            id: "runorpg:level",
            type: "INTEGER" as const,
            providers: ["api"],
            defaultValue: integerValue(1),
            nullable: false,
            cacheKey: true,
            previewValue: integerValue(1),
        },
        {
            uuid: id(),
            id: "runorpg:class",
            type: "STRING" as const,
            providers: ["api"],
            defaultValue: stringValue("HUMAN"),
            nullable: false,
            cacheKey: true,
            previewValue: stringValue("HUMAN"),
        },
        ...attributes.map((entry): ProjectDocument["viewerFacts"][number] => {
            const modifiers = item.modifiers.filter(
                (modifier) => modifier.attribute === entry.id,
            );
            const flat = modifiers
                .filter((modifier) => modifier.operation === "runorpg:flat")
                .reduce(
                    (sum, modifier) =>
                        sum +
                        (modifier.valueMode === "runorpg:final"
                            ? modifier.value - (entry.defaultValue ?? 0)
                            : modifier.value),
                    0,
                );
            const relative = modifiers
                .filter((modifier) => modifier.operation === "runorpg:relative")
                .reduce((sum, modifier) => sum + modifier.value, 0);
            const defaultValue = entry.defaultValue ?? 0;
            const value = (defaultValue + flat) * (1 + relative / 100);
            const factId = `runorpg:attribute.${entry.id.split(":", 2)[1]}`;
            const previewValue: DataValue = {
                kind: "decimal",
                value: decimalLiteral(value),
            };
            return {
                uuid: id(),
                id: factId,
                type: "DECIMAL" as const,
                providers: ["api"],
                defaultValue: {
                    kind: "decimal" as const,
                    value: decimalLiteral(defaultValue),
                },
                nullable: false,
                cacheKey: true,
                previewValue,
            };
        }),
    ];

    return {
        ...base,
        namespace: "runocraft",
        locales: base.locales.map((locale) => ({
            ...locale,
            messages: { ...locale.messages, ...messages },
        })),
        dataSchemas: [schema],
        viewerFacts: [
            ...base.viewerFacts.filter((fact) =>
                fact.id.startsWith("itemerness:"),
            ),
            ...viewerFacts,
        ],
        items: [
            {
                uuid: id(),
                id: item.localId,
                enabled: item.enabled,
                definition: {
                    material: item.material,
                    baseComponents: [
                        {
                            id: "minecraft:attribute_modifiers",
                            value: { kind: "list", values: [] },
                        },
                        {
                            id: "minecraft:max_stack_size",
                            value: integerValue(item.maxStackSize),
                        },
                        ...(item.unbreakable
                            ? [
                                  {
                                      id: "minecraft:unbreakable",
                                      value: {
                                          kind: "boolean" as const,
                                          value: true,
                                      },
                                  },
                              ]
                            : []),
                    ],
                    contentComponent: null,
                    contents: [],
                    definitionData: [],
                    instance: {
                        mode: item.mode === "unique" ? "UNIQUE" : "FUNGIBLE",
                        idGenerator: item.mode === "unique" ? "UUID_V4" : null,
                        schemas: [{ id: "runorpg:item-stats", version: 1 }],
                        defaults: [],
                        generators: [],
                    },
                },
                presentation: {
                    layout: item.layout ?? appearance.layout,
                    theme: item.theme ?? appearance.theme,
                    nameMessage: "runorpg.preview.name",
                    blocks,
                },
                previewData,
            },
        ],
    };
}

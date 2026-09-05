import { createRequire } from "node:module";
import {
    copyFile,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const require = createRequire(
    new URL("../apps/control-plane/package.json", import.meta.url),
);
const { parseDocument } = require("yaml");

const EQUIPMENT_TYPES = new Set([
    "ACCESSORIES",
    "AMULET",
    "BOW",
    "BRACELET",
    "CATALYST",
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

function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}

function appearanceOf(item, sourceFile) {
    const base = record(item.base);
    const material = String(base?.material ?? "minecraft:barrier")
        .split(":")
        .at(-1);
    const definitionData = record(item["definition-data"]);
    const profile = record(definitionData?.["runorpg:item-profile"]);
    const legacyType = String(profile?.["legacy-type"] ?? "");
    const equipmentMaterial =
        /(?:^|_)(?:sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$/u.test(
            material,
        ) ||
        ["bow", "crossbow", "trident", "mace", "shield"].includes(material);
    const equipment =
        EQUIPMENT_TYPES.has(legacyType) ||
        equipmentMaterial ||
        /(?:weapons|harvest-tools)/u.test(sourceFile);
    return equipment
        ? { layout: "itemerness:equipment", theme: "itemerness:ember" }
        : { layout: "itemerness:plain", theme: "itemerness:vanilla-frame" };
}

function usage() {
    console.error(
        "usage: node normalize-runorpg-presentation.mjs <Itemerness root> [--write]",
    );
    process.exitCode = 2;
}

const rootArgument = process.argv[2];
const write = process.argv.includes("--write");
if (!rootArgument) {
    usage();
} else {
    const root = await realpath(rootArgument);
    const itemsDirectory = join(root, "items");
    const allFiles = (await readdir(itemsDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    const files = allFiles.filter((name) => name !== "examples.yml");
    const documents = [];
    const totals = {
        files: files.length,
        items: 0,
        equipment: 0,
        plain: 0,
        attributeBlocksAdded: 0,
        skillBlocksAdded: 0,
    };

    for (const sourceFile of files) {
        const path = join(itemsDirectory, sourceFile);
        const source = await readFile(path, "utf8");
        const document = parseDocument(source, {
            keepSourceTokens: true,
            prettyErrors: true,
            strict: true,
            uniqueKeys: true,
        });
        if (document.errors.length > 0) {
            throw new Error(`${sourceFile}: ${document.errors[0].message}`);
        }
        const value = record(document.toJS());
        const items = record(value?.items);
        if (!items)
            throw new Error(`${sourceFile}: YAML items is not an object`);

        for (const [itemId, itemValue] of Object.entries(items)) {
            const item = record(itemValue);
            if (!item)
                throw new Error(`${sourceFile}:${itemId} is not an object`);
            const appearance = appearanceOf(item, sourceFile);
            document.setIn(
                ["items", itemId, "presentation", "layout"],
                appearance.layout,
            );
            document.setIn(
                ["items", itemId, "presentation", "theme"],
                appearance.theme,
            );
            const instance = record(item.instance);
            const defaults = record(instance?.defaults);
            const presentation = record(item.presentation);
            const currentBlocks = Array.isArray(presentation?.blocks)
                ? presentation.blocks
                : [];
            const blocks = [...currentBlocks];
            const modifiers = Array.isArray(
                defaults?.["runorpg:attribute-modifiers"],
            )
                ? defaults["runorpg:attribute-modifiers"]
                : [];
            const skills = Array.isArray(defaults?.["runorpg:item-skills"])
                ? defaults["runorpg:item-skills"]
                : [];
            const hasRepeat = (data) =>
                blocks.some(
                    (block) =>
                        record(block)?.type === "repeat" &&
                        record(block)?.data === data,
                );
            let insertion = 0;
            if (
                modifiers.length > 0 &&
                !hasRepeat("runorpg:attribute-lore")
            ) {
                blocks.splice(insertion++, 0, {
                    type: "repeat",
                    data: "runorpg:attribute-lore",
                    "maximum-elements": 64,
                    template: {
                        type: "compound-field",
                        label: "runorpg.data.legacy-stat.label",
                        "value-path": "lore",
                        "missing-message": "runorpg.data.legacy-stat.missing",
                    },
                    "missing-policy": "omit",
                });
                totals.attributeBlocksAdded += 1;
            }
            if (skills.length > 0 && !hasRepeat("runorpg:item-skills")) {
                blocks.splice(insertion, 0, {
                    type: "repeat",
                    data: "runorpg:item-skills",
                    "maximum-elements": 32,
                    template: {
                        type: "compound-field",
                        label: "runorpg.data.skill.label",
                        "value-path": "lore",
                        "missing-message": "runorpg.data.skill.missing",
                    },
                    "missing-policy": "omit",
                });
                totals.skillBlocksAdded += 1;
            }
            if (blocks.length !== currentBlocks.length) {
                document.setIn(
                    ["items", itemId, "presentation", "blocks"],
                    blocks,
                );
            }
            totals.items += 1;
            if (appearance.layout === "itemerness:equipment") {
                totals.equipment += 1;
            } else {
                totals.plain += 1;
            }
        }
        documents.push({
            path,
            sourceFile,
            source,
            next: document.toString({ lineWidth: 0 }),
        });
    }

    if (write) {
        const stamp = new Date()
            .toISOString()
            .replaceAll(":", "-")
            .replaceAll(".", "-");
        const backupDirectory = join(
            dirname(itemsDirectory),
            "_editor-backups",
            `presentation-normalization-${stamp}`,
        );
        await mkdir(backupDirectory, { recursive: true });
        for (const sourceFile of allFiles) {
            const path = join(itemsDirectory, sourceFile);
            await copyFile(path, join(backupDirectory, basename(path)));
        }
        for (const entry of documents) {
            if (entry.next === entry.source) continue;
            const temporary = `${entry.path}.${process.pid}.tmp`;
            await writeFile(temporary, entry.next, "utf8");
            await rename(temporary, entry.path);
        }
        console.log(
            JSON.stringify(
                { mode: "write", backupDirectory, ...totals },
                null,
                2,
            ),
        );
    } else {
        console.log(JSON.stringify({ mode: "dry-run", ...totals }, null, 2));
    }
}

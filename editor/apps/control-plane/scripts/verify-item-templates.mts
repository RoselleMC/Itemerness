/**
 * End-to-end check for item type templates against a running control plane.
 *
 * It drives the same three contracts the editor drives — `PUT /api/v1/document` for the template
 * registry, `POST`/`PUT /api/v1/runorpg/catalog/item` for the instance — and then reads the YAML
 * the server actually wrote. The point of reading the file is the one thing an API round trip
 * cannot prove: that a templated item is still an ordinary flat definition, with no provenance key
 * that `CatalogSourceLoader`'s `rejectUnknown` would refuse at plugin startup.
 *
 * Usage: tsx scripts/verify-item-templates.mts <base-url> <catalog-root>
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
    itemTemplateOverlay,
    itemTemplateRegistryOf,
    itemTemplateSchema,
    pendingItemTemplateFields,
    projectDocumentSchema,
    runoRpgCatalogSchema,
    withItemTemplateRegistry,
    type ItemTemplate,
    type ItemTemplateBinding,
    type RunoRpgCatalog,
} from "@itemerness/protocol";

const [baseUrl, catalogRoot] = process.argv.slice(2);
if (!baseUrl || !catalogRoot) {
    throw new Error(
        "usage: tsx scripts/verify-item-templates.mts <base-url> <catalog-root>",
    );
}

const LOCAL_ID = "template-probe-blade";
const INSTANCE_ID = `runocraft:${LOCAL_ID}`;
const ITEM_FILE = join(
    catalogRoot,
    "items",
    `runocraft-editor-${LOCAL_ID}.yml`,
);

const checks: string[] = [];
function check(label: string, condition: boolean, detail?: unknown): void {
    if (!condition) {
        throw new Error(
            `FAIL ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
        );
    }
    checks.push(label);
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
            "content-type": "application/json",
            ...(init?.headers ?? {}),
        },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(
            `${path}: HTTP ${response.status} ${JSON.stringify(body)}`,
        );
    }
    return body;
}

async function document(): Promise<{
    document: ReturnType<typeof projectDocumentSchema.parse>;
    snapshotHash: string;
}> {
    const body = (await api("/api/v1/document")) as {
        document: unknown;
        snapshotHash: string;
    };
    return {
        document: projectDocumentSchema.parse(body.document),
        snapshotHash: body.snapshotHash,
    };
}

async function catalog(): Promise<RunoRpgCatalog> {
    return runoRpgCatalogSchema.parse(await api("/api/v1/runorpg/catalog"));
}

async function itemYaml(): Promise<Record<string, unknown>> {
    const source = await readFile(ITEM_FILE, "utf8");
    return parse(source) as Record<string, unknown>;
}

const template: ItemTemplate = itemTemplateSchema.parse({
    uuid: "9f1d0c2a-1f5b-4a6d-9c3e-7f0b2d4e6a81",
    id: "runocraft:template-probe-sword",
    displayName: "探针剑模板",
    category: "sword",
    material: "minecraft:netherite_sword",
    layout: "itemerness:equipment",
    theme: "itemerness:ember",
    mode: "unique",
    unbreakable: true,
    itemTier: "unique",
    itemLevel: 30,
    baseModifiers: [
        {
            attribute: "runocraft:attack_damage",
            operation: "runorpg:flat",
            value: 42,
        },
    ],
});

// A clean slate: a leftover probe item from an earlier run would make step 3 pass for the wrong
// reason.
await rm(ITEM_FILE, { force: true });

// 1. The registry survives the document round trip through the extension channel.
{
    const { document: current, snapshotHash } = await document();
    const next = withItemTemplateRegistry(current, {
        version: 1,
        templates: [template],
        bindings: [],
    });
    await api("/api/v1/document", {
        method: "PUT",
        body: JSON.stringify({ document: next, expectedHash: snapshotHash }),
    });
    const reloaded = await document();
    const registry = itemTemplateRegistryOf(reloaded.document);
    check(
        "template survives the document round trip",
        registry.templates.length === 1,
    );
    check(
        "template values are preserved verbatim",
        registry.templates[0]?.material === template.material &&
            registry.templates[0]?.itemTier === "unique" &&
            registry.templates[0]?.baseModifiers[0]?.value === 42,
        registry.templates[0],
    );
}

// 2. Creating an instance from the template writes the template's values.
await api("/api/v1/runorpg/catalog/item", {
    method: "POST",
    body: JSON.stringify({
        localId: LOCAL_ID,
        displayName: "探针之刃",
        description: "模板验证用物品。",
        enabled: false,
        material: template.material,
        layout: template.layout,
        theme: template.theme,
        mode: template.mode,
        maxStackSize: template.maxStackSize,
        unbreakable: template.unbreakable,
        modifiers: template.baseModifiers,
        skills: template.baseSkills,
        itemTier: template.itemTier,
        itemLevel: template.itemLevel,
        itemPrefix: template.itemPrefix,
    }),
});

{
    const yaml = await itemYaml();
    const item = (yaml.items as Record<string, Record<string, never>>)[
        LOCAL_ID
    ];
    check("the instance file was written", item !== undefined);
    const base = item.base as unknown as Record<string, unknown>;
    const presentation = item.presentation as unknown as Record<
        string,
        unknown
    >;
    const defaults = (item.instance as unknown as Record<string, unknown>)
        .defaults as Record<string, unknown>;
    check(
        "material, theme and layout come from the template",
        base.material === template.material &&
            presentation.theme === template.theme &&
            presentation.layout === template.layout,
        { base, presentation },
    );
    check(
        "tier and level come from the template",
        defaults["runorpg:item-tier"] === "unique" &&
            defaults["runorpg:item-level"] === 30,
        defaults,
    );
    check(
        "base attributes come from the template",
        (defaults["runorpg:attribute-modifiers"] as { value: number }[])[0]
            ?.value === 42,
        defaults["runorpg:attribute-modifiers"],
    );
    // The whole reason provenance lives in the authoring document: an unknown key here takes the
    // plugin — and every plugin that depends on it — down at startup.
    const keys = JSON.stringify(yaml);
    check(
        "no template provenance leaked into the game YAML",
        !keys.includes("template") ||
            !/"template(Id|RevisionSeen)"/u.test(keys),
        keys.slice(0, 200),
    );
    check(
        "the loader reads the generated item back",
        (await catalog()).items.some((entry) => entry.id === INSTANCE_ID),
    );
}

// 3. A template change reaches an instance that has not overridden the field, and stops at one
//    that has.
{
    const moved: ItemTemplate = {
        ...template,
        itemLevel: 55,
        itemTier: "legendary",
        revision: 1,
    };
    const binding: ItemTemplateBinding = {
        instanceId: INSTANCE_ID,
        templateId: template.id,
        overriddenFields: ["itemTier"],
        templateRevisionSeen: 0,
    };
    const live = await catalog();
    const instance = live.items.find((entry) => entry.id === INSTANCE_ID)!;
    const pending = pendingItemTemplateFields(moved, binding, instance);
    check(
        "only the non-overridden field is pending",
        pending.length === 1 && pending[0] === "itemLevel",
        pending,
    );

    const overlay = itemTemplateOverlay(moved, pending);
    await api("/api/v1/runorpg/catalog/item", {
        method: "PUT",
        body: JSON.stringify({
            id: instance.id,
            expectedFileHash: instance.fileHash,
            enabled: instance.enabled,
            material: instance.material,
            layout: instance.layout,
            theme: instance.theme,
            mode: instance.mode,
            maxStackSize: instance.maxStackSize,
            unbreakable: instance.unbreakable,
            displayName: instance.displayName,
            itemLevel: overlay.itemLevel ?? instance.itemLevel,
            itemTier: overlay.itemTier ?? instance.itemTier,
            itemPrefix: instance.itemPrefix,
            modifiers: instance.modifiers,
            skills: instance.skills,
            presentationBlocks: instance.presentationBlocks,
            presentationMessages: instance.presentationMessages,
        }),
    });

    const yaml = await itemYaml();
    const defaults = (
        (yaml.items as Record<string, Record<string, never>>)[LOCAL_ID]!
            .instance as unknown as Record<string, unknown>
    ).defaults as Record<string, unknown>;
    check(
        "the template update reached the instance",
        defaults["runorpg:item-level"] === 55,
        defaults,
    );
    check(
        "the overridden field was left alone",
        defaults["runorpg:item-tier"] === "unique",
        defaults,
    );
}

for (const label of checks) process.stdout.write(`ok  ${label}\n`);
process.stdout.write(`\n${checks.length} checks passed\n`);

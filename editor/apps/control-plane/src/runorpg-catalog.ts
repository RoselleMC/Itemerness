import { createHash, randomBytes } from "node:crypto";
import {
    access,
    copyFile,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
    runoRpgCatalogItemCreateSchema,
    runoRpgCatalogItemUpdateSchema,
    runoRpgItemSkillSchema,
    type RunoRpgAttributeDefinition,
    type RunoRpgAttributeModifier,
    type RunoRpgCatalog,
    type RunoRpgCatalogItem,
    type RunoRpgCatalogItemCreate,
    type RunoRpgCatalogItemUpdate,
    type RunoRpgItemSkill,
    type DataValue,
    type PresentationBlock,
} from "@itemerness/protocol";
import { Document, parseDocument } from "yaml";

type UnknownRecord = Record<string, unknown>;

export class RunoRpgCatalogError extends Error {
    constructor(
        readonly code:
            | "not-configured"
            | "not-found"
            | "conflict"
            | "invalid-source"
            | "read-only",
        message: string,
    ) {
        super(message);
    }
}

export interface RunoRpgCatalogOptions {
    readonly catalogRoot: string | null;
    readonly attributesFile?: string | null;
    /**
     * RunoRPG's own editor snapshot (`plugins/RunoRPG/editor/snapshot.json`).
     *
     * Preferred over [attributesFile]: the snapshot is the runtime's authoritative view, carries a
     * revision and content hash, and includes bounds, owners, item kinds and the MythicMobs skill
     * index that regex-scraping the Kotlin script could never provide. The script scrape stays as a
     * fallback for deployments that have not mounted the snapshot yet.
     */
    readonly snapshotFile?: string | null;
    readonly namespace?: string;
}

/** Sections the control plane consumes from RunoRPG's editor snapshot. */
interface RunoRpgEditorSnapshot {
    readonly schemaVersion?: number;
    readonly revision?: number;
    readonly hash?: string;
    readonly attributes?: readonly {
        readonly id?: string;
        readonly name?: string;
        readonly defaultValue?: number;
        readonly percent?: boolean;
        readonly order?: number;
    }[];
    readonly itemKinds?: readonly { readonly id?: string }[];
    readonly mythicSkills?: readonly string[];
}

function record(value: unknown): UnknownRecord | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as UnknownRecord)
        : null;
}

function text(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function integer(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function bool(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
}

function hash(bytes: string | Buffer): string {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stableUuid(seed: string): string {
    const value = createHash("sha256").update(seed).digest("hex").slice(0, 32);
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20)}`;
}

function enumValue(value: unknown): string | null {
    const source = text(value);
    return source ? source.replaceAll("-", "_").toUpperCase() : null;
}

function missingPolicy(value: unknown): "ERROR" | "OMIT" {
    const parsed = enumValue(value);
    return parsed === "OMIT" ? parsed : "ERROR";
}

function scalarDataValue(value: unknown): DataValue | null {
    if (typeof value === "boolean") return { kind: "boolean", value };
    if (typeof value === "number" && Number.isFinite(value)) {
        return Number.isInteger(value)
            ? { kind: "integer", value: String(value) }
            : { kind: "decimal", value: String(value) };
    }
    if (typeof value === "string") return { kind: "string", value };
    return null;
}

type ValueReference = Extract<
    PresentationBlock,
    { type: "conditional" }
>["condition"]["left"];

function valueReference(value: unknown): ValueReference | null {
    const source = record(value);
    if (!source) return null;
    const data = text(source.data);
    if (data && namespaced(data)) return { kind: "data", key: data };
    const fact = text(source.fact);
    if (fact && namespaced(fact)) return { kind: "fact", key: fact };
    if (Object.hasOwn(source, "literal")) {
        const literal = scalarDataValue(source.literal);
        if (literal) return { kind: "literal", value: literal };
    }
    return null;
}

function presentationBlock(
    value: unknown,
    seed: string,
    diagnostics: string[],
): PresentationBlock | null {
    const source = record(value);
    const type = text(source?.type);
    const uuid = stableUuid(`${seed}:${text(source?.id) ?? "block"}`);
    const style = text(source?.style);
    const anchor = text(source?.anchor);
    const wrapping = text(source?.wrapping);
    if (!source || !type) {
        diagnostics.push(`${seed}: 展示块不是有效对象`);
        return null;
    }
    switch (type) {
        case "field": {
            const labelMessage = text(source.label);
            const data = text(source.data);
            if (!labelMessage || !data || !namespaced(data)) break;
            return {
                uuid,
                type: "field",
                labelMessage,
                data,
                format: text(source.format),
                icon: text(source.icon),
                style,
                anchor,
                wrapping,
                missingPolicy: missingPolicy(source["missing-policy"]),
            };
        }
        case "text": {
            const data = text(source.data);
            if (!data || !namespaced(data)) break;
            return {
                uuid,
                type: "text",
                data,
                style,
                anchor,
                wrapping,
                unbreakable: bool(source.unbreakable) ?? false,
                missingPolicy: missingPolicy(source["missing-policy"]),
            };
        }
        case "description": {
            const message = text(source.message);
            if (!message) break;
            return {
                uuid,
                type: "description",
                message,
                style,
                anchor,
                wrapping,
            };
        }
        case "conditional": {
            const condition = record(source.condition);
            const operator = enumValue(condition?.operator) as
                | "LESS_THAN"
                | "LESS_THAN_OR_EQUAL"
                | "GREATER_THAN"
                | "GREATER_THAN_OR_EQUAL"
                | "EQUALS"
                | "NOT_EQUALS"
                | "EXISTS"
                | null;
            const left = valueReference(condition?.left);
            const right = valueReference(condition?.right);
            if (!operator || !left || (operator !== "EXISTS" && !right)) break;
            const branch = (raw: unknown, branchName: string) =>
                (Array.isArray(raw) ? raw : [])
                    .map((entry, index) =>
                        presentationBlock(
                            entry,
                            `${seed}.${branchName}.${index}`,
                            diagnostics,
                        ),
                    )
                    .filter(
                        (entry): entry is PresentationBlock => entry !== null,
                    );
            return {
                uuid,
                type: "conditional",
                condition: {
                    operator,
                    left,
                    right: operator === "EXISTS" ? null : right,
                },
                thenBlocks: branch(source.then, "then"),
                otherwiseBlocks: branch(source.otherwise, "otherwise"),
                style,
                anchor,
            };
        }
        case "repeat": {
            const data = text(source.data);
            const template = record(source.template);
            const labelMessage = text(template?.label);
            const valuePath = text(template?.["value-path"]);
            const missingMessage = text(template?.["missing-message"]);
            if (
                !data ||
                !namespaced(data) ||
                !labelMessage ||
                !valuePath ||
                !missingMessage
            )
                break;
            return {
                uuid,
                type: "repeat",
                data,
                maximumElements: integer(source["maximum-elements"]) ?? 128,
                template: {
                    labelMessage,
                    valuePath,
                    missingMessage,
                    icon: text(template?.icon),
                    format: text(template?.format),
                },
                style,
                anchor,
                missingPolicy: missingPolicy(source["missing-policy"]),
            };
        }
        case "nested-item-list":
            return { uuid, type: "nestedItemList", style, anchor };
    }
    diagnostics.push(`${seed}: 不支持或不完整的展示块 ${type}`);
    return null;
}

function rawDataValue(value: DataValue): unknown {
    switch (value.kind) {
        case "null":
            return null;
        case "boolean":
        case "string":
            return value.value;
        case "integer":
        case "decimal":
            return Number(value.value);
        case "list":
            return value.values.map(rawDataValue);
        case "compound":
            return Object.fromEntries(
                Object.entries(value.entries).map(([key, entry]) => [
                    key,
                    rawDataValue(entry),
                ]),
            );
    }
}

function rawReference(reference: ValueReference): UnknownRecord {
    switch (reference.kind) {
        case "data":
            return { data: reference.key };
        case "fact":
            return { fact: reference.key };
        case "literal":
            return { literal: rawDataValue(reference.value) };
    }
}

function rawPresentationBlock(block: PresentationBlock): UnknownRecord {
    const common = {
        ...(block.style ? { style: block.style } : {}),
        ...(block.anchor ? { anchor: block.anchor } : {}),
    };
    switch (block.type) {
        case "field":
            return {
                type: "field",
                ...common,
                ...(block.icon ? { icon: block.icon } : {}),
                label: block.labelMessage,
                data: block.data,
                ...(block.format ? { format: block.format } : {}),
                ...(block.wrapping ? { wrapping: block.wrapping } : {}),
                ...(block.missingPolicy !== "ERROR"
                    ? { "missing-policy": block.missingPolicy.toLowerCase() }
                    : {}),
            };
        case "text":
            return {
                type: "text",
                ...common,
                data: block.data,
                ...(block.wrapping ? { wrapping: block.wrapping } : {}),
                ...(block.unbreakable ? { unbreakable: true } : {}),
                ...(block.missingPolicy !== "ERROR"
                    ? { "missing-policy": block.missingPolicy.toLowerCase() }
                    : {}),
            };
        case "description":
            return {
                type: "description",
                ...common,
                message: block.message,
                ...(block.wrapping ? { wrapping: block.wrapping } : {}),
            };
        case "conditional":
            return {
                type: "conditional",
                ...common,
                condition: {
                    operator: block.condition.operator
                        .toLowerCase()
                        .replaceAll("_", "-"),
                    left: rawReference(block.condition.left),
                    ...(block.condition.right
                        ? { right: rawReference(block.condition.right) }
                        : {}),
                },
                then: block.thenBlocks.map(rawPresentationBlock),
                ...(block.otherwiseBlocks.length > 0
                    ? {
                          otherwise:
                              block.otherwiseBlocks.map(rawPresentationBlock),
                      }
                    : {}),
            };
        case "repeat":
            return {
                type: "repeat",
                ...common,
                data: block.data,
                "maximum-elements": block.maximumElements,
                template: {
                    type: "compound-field",
                    label: block.template.labelMessage,
                    "value-path": block.template.valuePath,
                    "missing-message": block.template.missingMessage,
                    ...(block.template.icon
                        ? { icon: block.template.icon }
                        : {}),
                    ...(block.template.format
                        ? { format: block.template.format }
                        : {}),
                },
                ...(block.missingPolicy !== "ERROR"
                    ? { "missing-policy": block.missingPolicy.toLowerCase() }
                    : {}),
            };
        case "nestedItemList":
            return { type: "nested-item-list", ...common };
    }
}

function presentationMessageKeys(
    blocks: readonly PresentationBlock[],
): Set<string> {
    const keys = new Set<string>();
    const visit = (block: PresentationBlock) => {
        if (block.type === "field") keys.add(block.labelMessage);
        if (block.type === "description") keys.add(block.message);
        if (block.type === "repeat") {
            keys.add(block.template.labelMessage);
            keys.add(block.template.missingMessage);
        }
        if (block.type === "conditional") {
            block.thenBlocks.forEach(visit);
            block.otherwiseBlocks.forEach(visit);
        }
    };
    blocks.forEach(visit);
    return keys;
}

const RUNORPG_SCALAR_PRESENTATION_DATA = new Set([
    "runorpg:item-level",
    "runorpg:item-tier",
    "runorpg:item-prefix",
    "runorpg:unidentified-origin",
    "runorpg:unidentified-kind",
    "runorpg:unidentified-tier",
    "runorpg:unidentified-visible-tier",
    "runorpg:unidentified-min-level",
    "runorpg:unidentified-max-level",
]);

const RUNORPG_REPEAT_PRESENTATION_DATA = new Set([
    "runorpg:attribute-lore",
    "runorpg:item-skills",
    "runorpg:socket-entries",
]);

function validatePresentationBlocks(
    blocks: readonly PresentationBlock[],
    attributes: readonly RunoRpgAttributeDefinition[],
): void {
    const facts = new Set([
        "runorpg:level",
        "runorpg:class",
        ...attributes.map(
            (entry) =>
                `runorpg:attribute.${entry.id.split(":", 2)[1] ?? entry.id}`,
        ),
    ]);
    const validateReference = (reference: ValueReference, path: string) => {
        if (
            reference.kind === "data" &&
            !RUNORPG_SCALAR_PRESENTATION_DATA.has(reference.key)
        ) {
            throw new RunoRpgCatalogError(
                "invalid-source",
                `${path} 只能引用 RunoRPG 可展示的物品数据，收到 ${reference.key}`,
            );
        }
        if (reference.kind === "fact" && !facts.has(reference.key)) {
            throw new RunoRpgCatalogError(
                "invalid-source",
                `${path} 只能引用 RunoRPG 玩家等级、职业或脚本属性，收到 ${reference.key}`,
            );
        }
    };
    const visit = (block: PresentationBlock, path: string) => {
        if (
            (block.type === "field" || block.type === "text") &&
            !RUNORPG_SCALAR_PRESENTATION_DATA.has(block.data)
        ) {
            throw new RunoRpgCatalogError(
                "invalid-source",
                `${path} 引用了非 RunoRPG 标量数据 ${block.data}`,
            );
        }
        if (
            block.type === "repeat" &&
            !RUNORPG_REPEAT_PRESENTATION_DATA.has(block.data)
        ) {
            throw new RunoRpgCatalogError(
                "invalid-source",
                `${path} 引用了非 RunoRPG 列表数据 ${block.data}`,
            );
        }
        if (block.type === "nestedItemList") {
            throw new RunoRpgCatalogError(
                "invalid-source",
                `${path} 不允许在 RunoRPG 物品中嵌入未知物品列表`,
            );
        }
        if (block.type === "conditional") {
            validateReference(block.condition.left, `${path}.condition.left`);
            if (block.condition.right) {
                validateReference(
                    block.condition.right,
                    `${path}.condition.right`,
                );
            }
            block.thenBlocks.forEach((entry, index) =>
                visit(entry, `${path}.then.${index}`),
            );
            block.otherwiseBlocks.forEach((entry, index) =>
                visit(entry, `${path}.otherwise.${index}`),
            );
        }
    };
    blocks.forEach((block, index) =>
        visit(block, `presentation.blocks.${index}`),
    );
}

function namespaced(value: string): boolean {
    return /^[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_./-]*$/u.test(value);
}

function modifier(
    value: unknown,
    itemId: string,
    diagnostics: string[],
): RunoRpgAttributeModifier | null {
    const source = record(value);
    if (!source) {
        diagnostics.push(`${itemId}: 属性条目不是对象`);
        return null;
    }
    const attribute = text(source.attribute);
    const operation = text(source.operation) ?? "runorpg:flat";
    const numericValue = source.value;
    const valueMode = text(source["value-mode"]) ?? "runorpg:bonus";
    const sourceType = text(source["source-type"]) ?? "runorpg:item";
    const sourceId = text(source["source-id"]);
    const priority = integer(source.priority) ?? 100;
    const parsed =
        runoRpgCatalogItemUpdateSchema.shape.modifiers.element.safeParse({
            attribute,
            operation,
            value: numericValue,
            valueMode,
            sourceType,
            sourceId,
            priority,
        });
    if (!parsed.success) {
        diagnostics.push(
            `${itemId}: 无法读取属性 ${attribute ?? "<missing>"} (${parsed.error.issues[0]?.message ?? "格式错误"})`,
        );
        return null;
    }
    return parsed.data;
}

function validateModifierSemantics(
    modifiers: readonly RunoRpgAttributeModifier[],
): void {
    const finalAttributes = new Set<string>();
    for (const entry of modifiers) {
        if (entry.valueMode !== "runorpg:final") continue;
        if (
            entry.operation !== "runorpg:flat" ||
            entry.sourceType !== "runorpg:item"
        ) {
            throw new RunoRpgCatalogError(
                "invalid-source",
                `属性 ${entry.attribute} 的最终值模式仅支持物品固定值`,
            );
        }
        if (finalAttributes.has(entry.attribute)) {
            throw new RunoRpgCatalogError(
                "invalid-source",
                `属性 ${entry.attribute} 只能有一个最终值`,
            );
        }
        finalAttributes.add(entry.attribute);
    }
}

function skill(
    value: unknown,
    itemId: string,
    diagnostics: string[],
): RunoRpgItemSkill | null {
    const source = record(value);
    if (!source) {
        diagnostics.push(`${itemId}: 技能条目不是对象`);
        return null;
    }
    const parsed = runoRpgItemSkillSchema.safeParse({
        id: source.id,
        mythicSkill: source["mythic-skill"],
        trigger: source.trigger,
        cooldownGroup: source["cooldown-group"],
        cooldownSeconds: source["cooldown-seconds"],
        manaCost: source["mana-cost"],
        staminaCost: source["stamina-cost"],
        power: source.power,
        cancelVanilla: source["cancel-vanilla"],
        hidden: source.hidden,
        lore: source.lore,
    });
    if (!parsed.success) {
        diagnostics.push(
            `${itemId}: 无法读取技能 ${text(source.id) ?? "<missing>"} (${parsed.error.issues[0]?.message ?? "格式错误"})`,
        );
        return null;
    }
    return parsed.data;
}

function itemMessage(
    source: UnknownRecord,
    messages: ReadonlyMap<string, string>,
    kind: "name" | "description",
): string | null {
    const presentation = record(source.presentation);
    if (kind === "name") {
        const name = record(presentation?.name);
        const message = text(name?.message);
        return message ? (messages.get(message) ?? null) : null;
    }
    const blocks = Array.isArray(presentation?.blocks)
        ? presentation.blocks
        : [];
    for (const rawBlock of blocks) {
        const block = record(rawBlock);
        if (text(block?.type) !== "description") continue;
        const message = text(block?.message);
        if (message) return messages.get(message) ?? null;
    }
    return null;
}

function itemDisplayName(
    namespace: string,
    localId: string,
    source: UnknownRecord,
    messages: ReadonlyMap<string, string>,
): string {
    return itemMessage(source, messages, "name") ?? `${namespace}:${localId}`;
}

function relativeFile(root: string, candidate: string): string {
    const value = relative(root, candidate);
    if (value === "" || value.startsWith("..") || isAbsolute(value)) {
        throw new RunoRpgCatalogError(
            "invalid-source",
            "目录文件越过了 Itemerness 配置根目录",
        );
    }
    return value.replaceAll("\\", "/");
}

async function parsedYaml(path: string): Promise<{
    readonly source: string;
    readonly value: UnknownRecord;
    readonly document: ReturnType<typeof parseDocument>;
}> {
    const source = await readFile(path, "utf8");
    const document = parseDocument(source, {
        keepSourceTokens: true,
        prettyErrors: true,
        strict: true,
        uniqueKeys: true,
    });
    if (document.errors.length > 0) {
        throw new RunoRpgCatalogError(
            "invalid-source",
            `${basename(path)}: ${document.errors[0]!.message}`,
        );
    }
    const value = record(document.toJS());
    if (!value) {
        throw new RunoRpgCatalogError(
            "invalid-source",
            `${basename(path)}: YAML 根节点不是对象`,
        );
    }
    return { source, value, document };
}

export class RunoRpgCatalogService {
    private readonly configuredRoot: string | null;
    private readonly attributesFile: string | null;
    private readonly snapshotFile: string | null;
    private readonly namespace: string;

    constructor(options: RunoRpgCatalogOptions) {
        this.configuredRoot = options.catalogRoot
            ? resolve(options.catalogRoot)
            : null;
        this.snapshotFile = options.snapshotFile
            ? resolve(options.snapshotFile)
            : null;
        this.attributesFile = options.attributesFile
            ? resolve(options.attributesFile)
            : null;
        this.namespace = options.namespace ?? "runocraft";
    }

    async catalog(): Promise<RunoRpgCatalog> {
        if (!this.configuredRoot) {
            return {
                available: false,
                writable: false,
                items: [],
                attributes: [],
                diagnostics: ["未配置 ITEMERNESS_CATALOG_ROOT"],
            };
        }

        const diagnostics: string[] = [];
        let root: string;
        try {
            root = await realpath(this.configuredRoot);
        } catch (error) {
            return {
                available: false,
                writable: false,
                items: [],
                attributes: [],
                diagnostics: [
                    `无法读取 Itemerness 配置目录：${(error as Error).message}`,
                ],
            };
        }
        const itemsDirectory = join(root, "items");
        let writable = true;
        try {
            await access(itemsDirectory, fsConstants.R_OK | fsConstants.W_OK);
        } catch {
            writable = false;
        }

        const messages = await this.messages(root, diagnostics);
        const files = (await readdir(itemsDirectory, { withFileTypes: true }))
            .filter(
                (entry) =>
                    entry.isFile() && /\.(?:yml|yaml)$/iu.test(entry.name),
            )
            .map((entry) => join(itemsDirectory, entry.name))
            .sort();
        const items: RunoRpgCatalogItem[] = [];
        const usedAttributes = new Set<string>();

        for (const file of files) {
            try {
                const resolvedFile = await realpath(file);
                const sourceFile = relativeFile(root, resolvedFile);
                const loaded = await parsedYaml(resolvedFile);
                const namespace = text(loaded.value.namespace);
                if (namespace !== this.namespace) continue;
                const itemMap = record(loaded.value.items);
                if (!itemMap) continue;
                const fileHash = hash(loaded.source);

                for (const [localId, rawItem] of Object.entries(itemMap)) {
                    const source = record(rawItem);
                    if (!source) {
                        diagnostics.push(
                            `${sourceFile}#${localId}: 物品节点不是对象`,
                        );
                        continue;
                    }
                    const base = record(source.base);
                    const components = record(base?.components);
                    const instance = record(source.instance);
                    const defaults = record(instance?.defaults);
                    const definitionData = record(source["definition-data"]);
                    const presentation = record(source.presentation);
                    const profile = record(
                        definitionData?.["runorpg:item-profile"],
                    );
                    const id = `${namespace}:${localId}`;
                    const modifierDiagnostics: string[] = [];
                    const modifiers = Array.isArray(
                        defaults?.["runorpg:attribute-modifiers"],
                    )
                        ? defaults!["runorpg:attribute-modifiers"]
                              .map((entry) =>
                                  modifier(entry, id, modifierDiagnostics),
                              )
                              .filter(
                                  (entry): entry is RunoRpgAttributeModifier =>
                                      entry !== null,
                              )
                        : [];
                    diagnostics.push(...modifierDiagnostics);
                    const skillDiagnostics: string[] = [];
                    const skills = Array.isArray(
                        defaults?.["runorpg:item-skills"],
                    )
                        ? defaults!["runorpg:item-skills"]
                              .map((entry) =>
                                  skill(entry, id, skillDiagnostics),
                              )
                              .filter(
                                  (entry): entry is RunoRpgItemSkill =>
                                      entry !== null,
                              )
                        : [];
                    diagnostics.push(...skillDiagnostics);
                    modifiers.forEach((entry) =>
                        usedAttributes.add(entry.attribute),
                    );
                    const legacyType = text(profile?.["legacy-type"]);
                    const legacyId = text(profile?.["legacy-id"]);
                    const schemas = Array.isArray(instance?.schemas)
                        ? instance!.schemas.filter(
                              (entry): entry is string =>
                                  typeof entry === "string",
                          )
                        : [];
                    const vanilla =
                        components?.["minecraft:attribute_modifiers"];
                    const rawBlocks = Array.isArray(presentation?.blocks)
                        ? presentation.blocks
                        : [];
                    const blockDiagnostics: string[] = [];
                    const presentationBlocks = rawBlocks
                        .map((entry, index) =>
                            presentationBlock(
                                entry,
                                `${sourceFile}#${localId}.presentation.blocks.${index}`,
                                blockDiagnostics,
                            ),
                        )
                        .filter(
                            (entry): entry is PresentationBlock =>
                                entry !== null,
                        );
                    diagnostics.push(...blockDiagnostics);
                    const messageKeys =
                        presentationMessageKeys(presentationBlocks);
                    const nameMessage = text(
                        record(presentation?.name)?.message,
                    );
                    if (nameMessage) messageKeys.add(nameMessage);
                    const presentationMessages = Object.fromEntries(
                        [...messageKeys].map((key) => [
                            key,
                            messages.get(key) ?? "",
                        ]),
                    );

                    items.push({
                        id,
                        localId,
                        sourceFile,
                        fileHash,
                        displayName: itemDisplayName(
                            namespace,
                            localId,
                            source,
                            messages,
                        ),
                        description:
                            itemMessage(source, messages, "description") ?? "",
                        enabled: source.enabled === true,
                        material: text(base?.material) ?? "minecraft:barrier",
                        layout: text(presentation?.layout),
                        theme: text(presentation?.theme),
                        mode:
                            text(instance?.mode)?.toLowerCase() === "fungible"
                                ? "fungible"
                                : "unique",
                        maxStackSize:
                            integer(components?.["minecraft:max_stack_size"]) ??
                            1,
                        unbreakable:
                            bool(components?.["minecraft:unbreakable"]) ===
                            true,
                        vanillaAttributesDisabled:
                            Array.isArray(vanilla) && vanilla.length === 0,
                        schemas,
                        legacyReference:
                            legacyType && legacyId
                                ? `${legacyType}:${legacyId}`
                                : null,
                        requiredLevel: integer(profile?.["required-level"]),
                        itemLevel:
                            integer(defaults?.["runorpg:item-level"]) ??
                            integer(profile?.["required-level"]) ??
                            0,
                        itemTier:
                            text(defaults?.["runorpg:item-tier"]) ??
                            text(profile?.tier) ??
                            "",
                        itemPrefix:
                            text(defaults?.["runorpg:item-prefix"]) ?? "",
                        modifiers,
                        skills,
                        presentationBlocks,
                        presentationMessages,
                    });
                }
            } catch (error) {
                diagnostics.push((error as Error).message);
            }
        }

        const attributes = await this.attributeDefinitions(
            usedAttributes,
            diagnostics,
        );
        items.sort((left, right) =>
            left.displayName.localeCompare(right.displayName, "zh-CN"),
        );
        return {
            available: true,
            writable,
            items,
            attributes,
            diagnostics: diagnostics.slice(0, 256),
        };
    }

    async update(raw: unknown): Promise<RunoRpgCatalogItemUpdate> {
        const update = runoRpgCatalogItemUpdateSchema.parse(raw);
        if (!this.configuredRoot) {
            throw new RunoRpgCatalogError(
                "not-configured",
                "未配置 ITEMERNESS_CATALOG_ROOT",
            );
        }
        const separator = update.id.indexOf(":");
        const namespace = update.id.slice(0, separator);
        const localId = update.id.slice(separator + 1);
        if (namespace !== this.namespace) {
            throw new RunoRpgCatalogError(
                "not-found",
                `编辑器只管理 ${this.namespace}:* 物品`,
            );
        }
        const root = await realpath(this.configuredRoot);
        const itemsDirectory = join(root, "items");
        try {
            await access(itemsDirectory, fsConstants.R_OK | fsConstants.W_OK);
        } catch {
            throw new RunoRpgCatalogError(
                "read-only",
                "Itemerness 物品目录不可写",
            );
        }
        const attributeDiagnostics: string[] = [];
        const attributes = await this.attributeDefinitions(
            new Set(),
            attributeDiagnostics,
        );
        if (attributes.length === 0 && update.presentationBlocks) {
            throw new RunoRpgCatalogError(
                "invalid-source",
                attributeDiagnostics[0] ?? "没有读取到 RunoRPG 脚本属性定义",
            );
        }
        const attributeIds = new Set(attributes.map((entry) => entry.id));
        const unknownModifier =
            attributes.length > 0
                ? update.modifiers.find(
                      (entry) => !attributeIds.has(entry.attribute),
                  )
                : undefined;
        if (unknownModifier) {
            throw new RunoRpgCatalogError(
                "invalid-source",
                `属性 ${unknownModifier.attribute} 不在 RunoRPG 脚本属性目录中`,
            );
        }
        validateModifierSemantics(update.modifiers);
        if (update.presentationBlocks) {
            validatePresentationBlocks(update.presentationBlocks, attributes);
        }
        const files = (await readdir(itemsDirectory, { withFileTypes: true }))
            .filter(
                (entry) =>
                    entry.isFile() && /\.(?:yml|yaml)$/iu.test(entry.name),
            )
            .map((entry) => join(itemsDirectory, entry.name));

        for (const candidate of files) {
            const file = await realpath(candidate);
            relativeFile(root, file);
            const loaded = await parsedYaml(file);
            if (text(loaded.value.namespace) !== namespace) continue;
            const sourceItems = record(loaded.value.items);
            const sourceItem = record(sourceItems?.[localId]);
            if (!sourceItem) continue;
            const currentHash = hash(loaded.source);
            if (currentHash !== update.expectedFileHash) {
                throw new RunoRpgCatalogError(
                    "conflict",
                    `${basename(file)} 已被其他进程修改，请重新加载`,
                );
            }

            const itemPath = ["items", localId];
            loaded.document.setIn([...itemPath, "enabled"], update.enabled);
            loaded.document.setIn(
                [...itemPath, "base", "material"],
                update.material,
            );
            loaded.document.setIn(
                [...itemPath, "presentation", "layout"],
                update.layout,
            );
            loaded.document.setIn(
                [...itemPath, "presentation", "theme"],
                update.theme,
            );
            const sourcePresentation = record(sourceItem.presentation);
            const sourceName = record(sourcePresentation?.name);
            const nameMessage =
                text(sourceName?.message) ?? `runorpg.item.${localId}.name`;
            loaded.document.setIn(
                [...itemPath, "presentation", "name", "message"],
                nameMessage,
            );
            if (update.presentationBlocks) {
                loaded.document.setIn(
                    [...itemPath, "presentation", "blocks"],
                    update.presentationBlocks.map(rawPresentationBlock),
                );
            }
            loaded.document.setIn(
                [...itemPath, "base", "components", "minecraft:max_stack_size"],
                update.maxStackSize,
            );
            if (update.unbreakable) {
                loaded.document.setIn(
                    [
                        ...itemPath,
                        "base",
                        "components",
                        "minecraft:unbreakable",
                    ],
                    true,
                );
            } else {
                loaded.document.deleteIn([
                    ...itemPath,
                    "base",
                    "components",
                    "minecraft:unbreakable",
                ]);
            }
            // RunoRPG is authoritative for every managed item. An empty vanilla component patch
            // suppresses material defaults for swords, tools and armour.
            loaded.document.setIn(
                [
                    ...itemPath,
                    "base",
                    "components",
                    "minecraft:attribute_modifiers",
                ],
                [],
            );

            const sourceInstance = record(sourceItem.instance);
            const currentSchemas = sourceInstance?.schemas;
            const schemaValues = Array.isArray(currentSchemas)
                ? currentSchemas.filter(
                      (entry): entry is string => typeof entry === "string",
                  )
                : [];
            if (!schemaValues.includes("runorpg:item-stats@1")) {
                schemaValues.push("runorpg:item-stats@1");
            }
            if (!schemaValues.includes("runorpg:item-skill-contract@1")) {
                schemaValues.push("runorpg:item-skill-contract@1");
            }
            loaded.document.setIn(
                [...itemPath, "instance", "mode"],
                update.mode,
            );
            if (update.mode === "unique") {
                loaded.document.setIn(
                    [...itemPath, "instance", "id-generator"],
                    "uuid-v4",
                );
            } else {
                loaded.document.deleteIn([
                    ...itemPath,
                    "instance",
                    "id-generator",
                ]);
            }
            loaded.document.setIn(
                [...itemPath, "instance", "schemas"],
                schemaValues,
            );
            loaded.document.setIn(
                [
                    ...itemPath,
                    "instance",
                    "defaults",
                    "runorpg:attribute-modifiers",
                ],
                update.modifiers.map((entry) => ({
                    attribute: entry.attribute,
                    operation: entry.operation,
                    value: entry.value,
                    "value-mode": entry.valueMode,
                    "source-type": entry.sourceType,
                    ...(entry.sourceId ? { "source-id": entry.sourceId } : {}),
                    priority: entry.priority,
                })),
            );
            loaded.document.setIn(
                [...itemPath, "instance", "defaults", "runorpg:item-skills"],
                update.skills.map((entry) => ({
                    id: entry.id,
                    "mythic-skill": entry.mythicSkill,
                    trigger: entry.trigger,
                    "cooldown-group": entry.cooldownGroup,
                    "cooldown-seconds": entry.cooldownSeconds,
                    "mana-cost": entry.manaCost,
                    "stamina-cost": entry.staminaCost,
                    power: entry.power,
                    "cancel-vanilla": entry.cancelVanilla,
                    hidden: entry.hidden,
                    lore: entry.lore,
                })),
            );
            if (update.itemLevel !== undefined) {
                loaded.document.setIn(
                    [...itemPath, "instance", "defaults", "runorpg:item-level"],
                    update.itemLevel,
                );
            }
            if (update.itemTier !== undefined) {
                loaded.document.setIn(
                    [...itemPath, "instance", "defaults", "runorpg:item-tier"],
                    update.itemTier,
                );
            }
            if (update.itemPrefix !== undefined) {
                loaded.document.setIn(
                    [
                        ...itemPath,
                        "instance",
                        "defaults",
                        "runorpg:item-prefix",
                    ],
                    update.itemPrefix,
                );
            }

            const next = loaded.document.toString({ lineWidth: 0 });
            const localeUpdates = {
                ...(update.presentationMessages ?? {}),
                ...(update.displayName
                    ? { [nameMessage]: update.displayName }
                    : {}),
            };
            if (Object.keys(localeUpdates).length > 0) {
                await this.writeLocaleMessages(root, localeUpdates);
            }
            if (next === loaded.source) return update;
            const backupDirectory = join(root, "_editor-backups", "items");
            await mkdir(backupDirectory, { recursive: true });
            const timestamp = new Date()
                .toISOString()
                .replaceAll(":", "-")
                .replaceAll(".", "-");
            await copyFile(
                file,
                join(
                    backupDirectory,
                    `${basename(file)}.${timestamp}.${currentHash.slice(-12)}.bak`,
                ),
            );
            const temporary = join(
                itemsDirectory,
                `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`,
            );
            await writeFile(temporary, next, { encoding: "utf8", flag: "wx" });
            await rename(temporary, file);
            return update;
        }

        throw new RunoRpgCatalogError("not-found", `找不到物品 ${update.id}`);
    }

    async create(raw: unknown): Promise<RunoRpgCatalogItemCreate> {
        const create = runoRpgCatalogItemCreateSchema.parse(raw);
        validateModifierSemantics(create.modifiers);
        if (create.presentationBlocks) {
            const diagnostics: string[] = [];
            const attributes = await this.attributeDefinitions(
                new Set(),
                diagnostics,
            );
            if (attributes.length === 0) {
                throw new RunoRpgCatalogError(
                    "invalid-source",
                    diagnostics[0] ?? "没有读取到 RunoRPG 脚本属性定义",
                );
            }
            validatePresentationBlocks(create.presentationBlocks, attributes);
        }
        if (!this.configuredRoot) {
            throw new RunoRpgCatalogError(
                "not-configured",
                "未配置 ITEMERNESS_CATALOG_ROOT",
            );
        }
        const root = await realpath(this.configuredRoot);
        const itemsDirectory = join(root, "items");
        try {
            await access(itemsDirectory, fsConstants.R_OK | fsConstants.W_OK);
        } catch {
            throw new RunoRpgCatalogError(
                "read-only",
                "Itemerness 物品目录不可写",
            );
        }
        const itemId = `${this.namespace}:${create.localId}`;
        if ((await this.catalog()).items.some((item) => item.id === itemId)) {
            throw new RunoRpgCatalogError("conflict", `物品 ${itemId} 已存在`);
        }

        const itemFile = join(
            itemsDirectory,
            `${this.namespace}-editor-${create.localId}.yml`,
        );
        try {
            await access(itemFile, fsConstants.F_OK);
            throw new RunoRpgCatalogError(
                "conflict",
                `${basename(itemFile)} 已存在`,
            );
        } catch (error) {
            if (error instanceof RunoRpgCatalogError) throw error;
        }

        const nameMessage = `runorpg.item.${create.localId}.name`;
        const descriptionMessage = `runorpg.item.${create.localId}.description`;
        await this.writeLocaleMessages(root, {
            [nameMessage]: create.displayName,
            [descriptionMessage]: create.description,
        });

        const components: UnknownRecord = {
            "minecraft:attribute_modifiers": [],
            "minecraft:max_stack_size": create.maxStackSize,
        };
        if (create.unbreakable) components["minecraft:unbreakable"] = true;
        const instance: UnknownRecord = {
            mode: create.mode,
            schemas: ["runorpg:item-stats@1", "runorpg:item-skill-contract@1"],
            defaults: {
                "runorpg:attribute-modifiers": create.modifiers.map(
                    (entry) => ({
                        attribute: entry.attribute,
                        operation: entry.operation,
                        value: entry.value,
                        "value-mode": entry.valueMode,
                        "source-type": entry.sourceType,
                        ...(entry.sourceId
                            ? { "source-id": entry.sourceId }
                            : {}),
                        priority: entry.priority,
                    }),
                ),
                "runorpg:item-skills": create.skills.map((entry) => ({
                    id: entry.id,
                    "mythic-skill": entry.mythicSkill,
                    trigger: entry.trigger,
                    "cooldown-group": entry.cooldownGroup,
                    "cooldown-seconds": entry.cooldownSeconds,
                    "mana-cost": entry.manaCost,
                    "stamina-cost": entry.staminaCost,
                    power: entry.power,
                    "cancel-vanilla": entry.cancelVanilla,
                    hidden: entry.hidden,
                    lore: entry.lore,
                })),
            },
        };
        if (create.mode === "unique") instance["id-generator"] = "uuid-v4";
        const defaults = instance.defaults as UnknownRecord;
        if (create.itemLevel !== undefined)
            defaults["runorpg:item-level"] = create.itemLevel;
        if (create.itemTier !== undefined)
            defaults["runorpg:item-tier"] = create.itemTier;
        if (create.itemPrefix !== undefined)
            defaults["runorpg:item-prefix"] = create.itemPrefix;

        // A template supplies its own lore layout. Without one the item gets the default pair of
        // repeat blocks, which is what every hand-made editor item has always started with.
        const blocks = create.presentationBlocks
            ? create.presentationBlocks.map(rawPresentationBlock)
            : [
                  {
                      type: "repeat",
                      data: "runorpg:item-skills",
                      "maximum-elements": 32,
                      template: {
                          type: "compound-field",
                          label: "runorpg.data.skill.label",
                          "value-path": "lore",
                          "missing-message": "runorpg.data.skill.missing",
                      },
                  },
                  {
                      type: "repeat",
                      data: "runorpg:attribute-lore",
                      "maximum-elements": 128,
                      template: {
                          type: "compound-field",
                          label: "runorpg.data.legacy-stat.label",
                          "value-path": "lore",
                          "missing-message": "runorpg.data.legacy-stat.missing",
                      },
                  },
                  { type: "description", message: descriptionMessage },
              ];

        const document = new Document({
            "schema-version": 1,
            namespace: this.namespace,
            items: {
                [create.localId]: {
                    enabled: create.enabled,
                    base: { material: create.material, components },
                    instance,
                    presentation: {
                        layout: create.layout,
                        theme: create.theme,
                        name: { message: nameMessage },
                        blocks,
                    },
                },
            },
        });
        const temporary = join(
            itemsDirectory,
            `.${basename(itemFile)}.${randomBytes(8).toString("hex")}.tmp`,
        );
        await writeFile(temporary, document.toString({ lineWidth: 0 }), {
            encoding: "utf8",
            flag: "wx",
        });
        await rename(temporary, itemFile);
        return create;
    }

    private async writeLocaleMessages(
        root: string,
        messages: Readonly<Record<string, string>>,
    ): Promise<void> {
        const backupDirectory = join(root, "_editor-backups", "locales");
        await mkdir(backupDirectory, { recursive: true });
        for (const name of ["zh_cn.yml", "en_us.yml"]) {
            const file = join(root, "locales", name);
            const loaded = await parsedYaml(file);
            for (const [key, value] of Object.entries(messages)) {
                loaded.document.setIn(["messages", key], value);
            }
            const timestamp = new Date()
                .toISOString()
                .replaceAll(":", "-")
                .replaceAll(".", "-");
            await copyFile(
                file,
                join(
                    backupDirectory,
                    `${name}.${timestamp}.${hash(loaded.source).slice(-12)}.bak`,
                ),
            );
            const temporary = join(
                file.slice(0, file.length - name.length),
                `.${name}.${randomBytes(8).toString("hex")}.tmp`,
            );
            await writeFile(
                temporary,
                loaded.document.toString({ lineWidth: 0 }),
                { encoding: "utf8", flag: "wx" },
            );
            await rename(temporary, file);
        }
    }

    private async messages(
        root: string,
        diagnostics: string[],
    ): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        for (const name of ["zh_cn.yml", "en_us.yml"]) {
            try {
                const loaded = await parsedYaml(join(root, "locales", name));
                const messages = record(loaded.value.messages);
                for (const [key, value] of Object.entries(messages ?? {})) {
                    if (typeof value === "string" && !result.has(key)) {
                        result.set(key, value);
                    }
                }
            } catch (error) {
                diagnostics.push((error as Error).message);
            }
        }
        return result;
    }

    /**
     * Reads RunoRPG's editor snapshot, or null when it is absent or unreadable.
     *
     * An unreadable snapshot is reported as a diagnostic rather than thrown: the editor must stay
     * usable on a deployment that has not mounted it yet.
     */
    private async readSnapshot(
        diagnostics: string[],
    ): Promise<RunoRpgEditorSnapshot | null> {
        if (!this.snapshotFile) return null;
        try {
            const source = await readFile(this.snapshotFile, "utf8");
            const parsed = JSON.parse(source) as RunoRpgEditorSnapshot;
            if (parsed.schemaVersion !== 1) {
                diagnostics.push(
                    `RunoRPG 编辑器快照版本 ${parsed.schemaVersion ?? "未知"} 不受支持，已回退到脚本解析`,
                );
                return null;
            }
            return parsed;
        } catch (error) {
            diagnostics.push(
                `无法读取 RunoRPG 编辑器快照：${(error as Error).message}`,
            );
            return null;
        }
    }

    private async attributeDefinitions(
        used: ReadonlySet<string>,
        diagnostics: string[],
    ): Promise<RunoRpgAttributeDefinition[]> {
        const definitions = new Map<string, RunoRpgAttributeDefinition>();

        // The runtime's own snapshot wins; scraping the Kotlin script is only a fallback.
        const snapshot = await this.readSnapshot(diagnostics);
        for (const attribute of snapshot?.attributes ?? []) {
            const id = attribute.id;
            if (!id || !namespaced(id)) continue;
            definitions.set(id, {
                id,
                name: attribute.name ?? id,
                defaultValue: attribute.defaultValue ?? 0,
                percent: attribute.percent === true,
                order: attribute.order ?? 0,
            });
        }

        if (definitions.size === 0 && this.attributesFile) {
            try {
                const source = await readFile(this.attributesFile, "utf8");
                const pattern =
                    /numericAttribute\(\s*"([A-Za-z0-9_.-]+)"\s*,\s*"([^"]+)"([^\r\n]*)/gu;
                for (const match of source.matchAll(pattern)) {
                    const id = `runocraft:${match[1]!.toLowerCase()}`;
                    const argumentsText = match[3] ?? "";
                    const defaultValue = Number(
                        /defaultValue\s*=\s*(-?\d+(?:\.\d+)?)/u.exec(
                            argumentsText,
                        )?.[1] ?? "0",
                    );
                    const order = Number(
                        /order\s*=\s*(-?\d+)/u.exec(argumentsText)?.[1] ?? "0",
                    );
                    definitions.set(id, {
                        id,
                        name: match[2]!,
                        defaultValue,
                        percent: /percent\s*=\s*true/u.test(argumentsText),
                        order,
                    });
                }
            } catch (error) {
                diagnostics.push(
                    `无法读取 RunoRPG 属性脚本：${(error as Error).message}`,
                );
            }
        }
        for (const id of used) {
            if (namespaced(id) && !definitions.has(id)) {
                definitions.set(id, {
                    id,
                    name: id.split(":", 2)[1]!.replaceAll("_", " "),
                    defaultValue: 0,
                    percent: false,
                    order: 0,
                });
            }
        }
        return [...definitions.values()].sort(
            (left, right) =>
                left.order - right.order ||
                left.name.localeCompare(right.name, "zh-CN"),
        );
    }
}

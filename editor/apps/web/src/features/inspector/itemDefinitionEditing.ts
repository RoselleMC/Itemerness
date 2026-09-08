import { itemKey } from "@itemerness/protocol";
import {
    decimalStringSchema,
    namespacedIdSchema,
    type DataKeyNode,
    type ItemNode,
    type PresentationBlock,
    type ProjectDocument,
} from "@itemerness/protocol";
import { itemDataKeys } from "../common/typedValues.js";

export type ItemDefinition = ItemNode["definition"];
export type Generator = ItemDefinition["instance"]["generators"][number];
export type Binding = ItemDefinition["instance"]["schemas"][number];
export type DefinitionIssue = { code: string; detail: string };

export function inferContentComponent(
    material: string,
): ItemDefinition["contentComponent"] {
    if (!material.startsWith("minecraft:")) return null;
    const path = material.slice(10);
    if (path === "bundle" || path.endsWith("_bundle")) return "BUNDLE";
    if (
        path === "shulker_box" ||
        path.endsWith("_shulker_box") ||
        ["chest", "trapped_chest", "barrel"].includes(path)
    )
        return "CONTAINER";
    return null;
}

export function normalizeMaterial(raw: string): string | null {
    const value = raw.includes(":") ? raw : `minecraft:${raw}`;
    return namespacedIdSchema.safeParse(value).success ? value : null;
}

export function setInstanceMode(
    definition: ItemDefinition,
    mode: ItemDefinition["instance"]["mode"],
): ItemDefinition {
    return {
        ...definition,
        instance: {
            ...definition.instance,
            mode,
            idGenerator: mode === "UNIQUE" ? "UUID_V4" : null,
        },
    };
}

export function replaceBinding(
    definition: ItemDefinition,
    index: number,
    binding: Binding | null,
): ItemDefinition {
    const schemas = [...definition.instance.schemas];
    if (binding === null) schemas.splice(index, 1);
    else if (index === schemas.length) schemas.push(binding);
    else schemas[index] = binding;
    return { ...definition, instance: { ...definition.instance, schemas } };
}

export function bindingIssue(
    document: ProjectDocument,
    schemas: Binding[],
): string | null {
    if (schemas.length > 64) return "bindingBudget";
    const ids = new Set<string>();
    const keys = new Set<string>();
    let missing = false;
    for (const ref of schemas) {
        if (ref.id.length > 128) return "bindingBudget";
        if (ids.has(ref.id)) return "duplicateSchema";
        ids.add(ref.id);
        const schema = document.dataSchemas.find(
            (entry) => entry.id === ref.id && entry.version === ref.version,
        );
        if (!schema) {
            missing = true;
            continue;
        }
        for (const key of schema.keys) {
            if (key.id.length > 128) return "bindingBudget";
            if (keys.has(key.id)) return "duplicateKey";
            keys.add(key.id);
        }
    }
    return keys.size > 256 ? "bindingBudget" : missing ? "missingSchema" : null;
}

export function definitionReferenceIssues(
    document: ProjectDocument,
    item: ItemNode,
): DefinitionIssue[] {
    const issues: DefinitionIssue[] = [];
    for (const ref of item.definition.instance.schemas) {
        if (
            !document.dataSchemas.some(
                (entry) => entry.id === ref.id && entry.version === ref.version,
            )
        )
            issues.push({
                code: "missingSchema",
                detail: `${ref.id}@${ref.version}`,
            });
    }
    const bindingError = bindingIssue(
        document,
        item.definition.instance.schemas,
    );
    if (bindingError && bindingError !== "missingSchema")
        issues.push({ code: bindingError, detail: "" });
    const keys = itemDataKeys(document, item);
    const check = (
        id: string,
        scope?: DataKeyNode["scope"],
        readable = false,
    ) => {
        const matches = keys.filter((key) => key.id === id);
        if (matches.length !== 1)
            issues.push({ code: "unboundKey", detail: id });
        else if (scope && matches[0]!.scope !== scope)
            issues.push({ code: "wrongScope", detail: id });
        else if (readable && !matches[0]!.presentationReadable)
            issues.push({ code: "unreadableKey", detail: id });
    };
    item.definition.definitionData.forEach((entry) =>
        check(entry.key, "DEFINITION"),
    );
    item.definition.instance.defaults.forEach((entry) =>
        check(entry.key, "INSTANCE"),
    );
    item.definition.instance.generators.forEach((entry) =>
        check(entry.key, "INSTANCE"),
    );
    item.previewData.forEach((entry) => check(entry.key));
    const visit = (blocks: PresentationBlock[]) =>
        blocks.forEach((block) => {
            if ("data" in block) check(block.data, undefined, true);
            if (block.type === "conditional") {
                [block.condition.left, block.condition.right].forEach((ref) => {
                    if (ref?.kind === "data") check(ref.key, undefined, true);
                });
                visit(block.thenBlocks);
                visit(block.otherwiseBlocks);
            }
        });
    visit(item.presentation.blocks);
    return [
        ...new Map(
            issues.map((issue) => [`${issue.code}:${issue.detail}`, issue]),
        ).values(),
    ];
}

// Compare decimal strings without rounding distinct BigDecimal bounds to the same JS number.
export function compareDecimal(left: string, right: string): number {
    const parts = (raw: string) => {
        const [mantissa = "0", exponent = "0"] = raw.toLowerCase().split("e");
        const negative = mantissa.startsWith("-");
        const [whole = "0", fraction = ""] = mantissa
            .replace(/^[+-]/, "")
            .split(".");
        const digits = `${whole}${fraction}`.replace(/^0+/, "") || "0";
        return {
            negative: digits !== "0" && negative,
            digits,
            power: Number(exponent) - fraction.length,
        };
    };
    const a = parts(left),
        b = parts(right);
    if (a.digits === "0" && b.digits === "0") return 0;
    if (a.negative !== b.negative) return a.negative ? -1 : 1;
    const sign = a.negative ? -1 : 1;
    if (a.digits === "0") return -sign;
    if (b.digits === "0") return sign;
    const sizeA = a.digits.length + a.power,
        sizeB = b.digits.length + b.power;
    if (sizeA !== sizeB) return (sizeA < sizeB ? -1 : 1) * sign;
    const width = Math.max(a.digits.length, b.digits.length);
    const paddedA = a.digits.padEnd(width, "0"),
        paddedB = b.digits.padEnd(width, "0");
    return paddedA === paddedB ? 0 : (paddedA < paddedB ? -1 : 1) * sign;
}

export function generatorIssue(
    generator: Generator,
    key: DataKeyNode | undefined,
    defaults: ItemDefinition["instance"]["defaults"],
): string | null {
    if (!key) return "unboundKey";
    if (key.scope !== "INSTANCE") return "wrongScope";
    if (defaults.some((entry) => entry.key === generator.key))
        return "generatorDefault";
    if (key.constraints.allowedValues.length) return "generatorAllowed";
    if (
        key.type.kind !== (generator.kind === "unixMillis" ? "long" : "decimal")
    )
        return "generatorType";
    if (generator.kind === "unixMillis") return null;
    if (
        ![generator.minimum, generator.maximum].every(
            (value) =>
                decimalStringSchema.safeParse(value).success &&
                Number.isFinite(Number(value)),
        )
    )
        return "number";
    if (compareDecimal(generator.minimum, generator.maximum) >= 0)
        return "generatorRange";
    if (
        !Number.isInteger(generator.scale) ||
        generator.scale < 0 ||
        generator.scale > Math.min(12, key.constraints.scale ?? 12)
    )
        return "generatorScale";
    if (
        (key.constraints.minimum !== null &&
            compareDecimal(generator.minimum, key.constraints.minimum) < 0) ||
        (key.constraints.maximum !== null &&
            compareDecimal(generator.maximum, key.constraints.maximum) > 0)
    )
        return "generatorConstraints";
    if (key.constraints.scale !== null) {
        const scale = key.constraints.scale;
        if (
            [generator.minimum, generator.maximum].some((value) => {
                const [mantissa = "0", exponent = "0"] = String(
                    Number(value),
                ).split("e");
                const fraction = (mantissa.split(".")[1] ?? "").replace(
                    /0+$/,
                    "",
                );
                return Math.max(0, fraction.length - Number(exponent)) > scale;
            })
        )
            return "generatorConstraints";
    }
    return null;
}

export function initialGenerator(key: DataKeyNode): Generator {
    if (key.type.kind === "long") return { kind: "unixMillis", key: key.id };
    const { minimum, maximum, scale } = key.constraints;
    const lower =
        minimum ??
        (maximum !== null && compareDecimal(maximum, "0") <= 0
            ? String(
                  Number(maximum) - Math.max(1, Math.abs(Number(maximum)) / 2),
              )
            : "0");
    const upper =
        maximum ??
        (compareDecimal(lower, "1") >= 0
            ? String(Number(lower) + Math.max(1, Math.abs(Number(lower)) / 2))
            : "1");
    return {
        kind: "randomDecimal",
        key: key.id,
        minimum: lower,
        maximum: upper,
        scale: Math.min(scale ?? 2, 12),
    };
}

type GraphIssue = { item: string; code: string; score: number };
export function contentGraphIssues(document: ProjectDocument): GraphIssue[] {
    const items = new Map(
        document.items.map((item) => [
            itemKey(document, item),
            item,
        ]),
    );
    const issues: GraphIssue[] = [];
    const report = (item: string, code: string, score = 1) =>
        issues.push({ item, code, score });
    const memo = new Map<string, { depth: number; count: number }>();
    const walk = (
        key: string,
        path: string[],
    ): { depth: number; count: number } => {
        const cycleIndex = path.indexOf(key);
        if (cycleIndex >= 0) {
            path.slice(cycleIndex).forEach((id) => report(id, "contentCycle"));
            return { depth: 9, count: 257 };
        }
        const cached = memo.get(key);
        if (cached) return cached;
        const current = items.get(key);
        if (!current) return { depth: 0, count: 0 };
        const next = [...path, key];
        let depth = 1,
            count = 1;
        for (const child of current.definition.contents) {
            const result = walk(child.item, next);
            depth = Math.max(depth, 1 + result.depth);
            count = Math.min(
                257,
                count + Math.max(0, child.amount) * result.count,
            );
        }
        const result = { depth, count };
        memo.set(key, result);
        return result;
    };
    for (const [id, item] of items) {
        const contents = item.definition.contents;
        if (contents.length > 64) report(id, "contentEntries", contents.length);
        for (const entry of contents) {
            if (
                !Number.isInteger(entry.amount) ||
                entry.amount < 1 ||
                entry.amount > 99
            )
                report(id, "contentAmount", Math.abs(entry.amount));
            const target = items.get(entry.item);
            if (!target) report(id, "contentMissing");
            else if (item.enabled && !target.enabled)
                report(id, "contentDisabled");
        }
        const result = walk(id, []);
        if (result.depth > 8) report(id, "contentDepth", result.depth);
        if (result.count > 256) report(id, "contentBudget", result.count);
    }
    return issues;
}

export function contentsEditIssue(
    document: ProjectDocument,
    item: ItemNode,
    contents: ItemDefinition["contents"],
): string | null {
    if (contents.length && !inferContentComponent(item.definition.material))
        return "contentCarrier";
    const previous = new Map(
        contentGraphIssues(document).map((issue) => [
            `${issue.item}:${issue.code}`,
            issue.score,
        ]),
    );
    const totals = (entries: ItemDefinition["contents"]) => {
        const result = new Map<string, number>();
        for (const entry of entries)
            result.set(
                entry.item,
                (result.get(entry.item) ?? 0) + entry.amount,
            );
        return result;
    };
    const oldTotals = totals(item.definition.contents);
    const growing = [...totals(contents)].some(
        ([id, amount]) => amount > (oldTotals.get(id) ?? 0),
    );
    const affected = new Set([itemKey(document, item)]);
    if (growing) {
        let changed = true;
        while (changed) {
            changed = false;
            for (const entry of document.items) {
                const id = itemKey(document, entry);
                if (
                    !affected.has(id) &&
                    entry.definition.contents.some((child) =>
                        affected.has(child.item),
                    )
                ) {
                    affected.add(id);
                    changed = true;
                }
            }
        }
    }
    const next = {
        ...document,
        items: document.items.map((entry) =>
            entry.uuid === item.uuid
                ? { ...entry, definition: { ...entry.definition, contents } }
                : entry,
        ),
    };
    return (
        contentGraphIssues(next).find(
            (issue) =>
                issue.score >
                    (previous.get(`${issue.item}:${issue.code}`) ?? 0) ||
                (growing &&
                    affected.has(issue.item) &&
                    [
                        "contentCycle",
                        "contentDepth",
                        "contentBudget",
                        "contentEntries",
                    ].includes(issue.code)),
        )?.code ?? null
    );
}

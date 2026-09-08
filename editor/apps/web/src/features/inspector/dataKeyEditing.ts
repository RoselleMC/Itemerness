import { itemKey } from "@itemerness/protocol";
import {
    decimalStringSchema,
    type DataKeyNode,
    type DataTypeNode,
    type ItemNode,
    type PresentationBlock,
    type ProjectDocument,
} from "@itemerness/protocol";

export function dataKeyReferences(
    document: ProjectDocument,
    uuid: string,
): {
    items: ItemNode[];
    labels: string[];
} {
    const schema = document.dataSchemas.find((entry) =>
        entry.keys.some((key) => key.uuid === uuid),
    );
    const key = schema?.keys.find((entry) => entry.uuid === uuid);
    if (!schema || !key) return { items: [], labels: [] };
    const labels = new Set<string>();
    const collect = (blocks: readonly PresentationBlock[]) => {
        for (const block of blocks) {
            if (block.type === "field" && block.data === key.id)
                labels.add(block.labelMessage);
            if (block.type === "repeat" && block.data === key.id)
                labels.add(block.template.labelMessage);
            if (block.type === "conditional") {
                collect(block.thenBlocks);
                collect(block.otherwiseBlocks);
            }
        }
    };
    const items = document.items.filter((item) => {
        if (
            !item.definition.instance.schemas.some(
                (ref) => ref.id === schema.id && ref.version === schema.version,
            )
        )
            return false;
        collect(item.presentation.blocks);
        return true;
    });
    return { items, labels: [...labels].sort() };
}

export function initialDataType(kind: DataTypeNode["kind"]): DataTypeNode {
    if (kind === "list") return { kind, element: { kind: "string" } };
    if (kind === "compound") return { kind, fields: null };
    return { kind };
}

export function dataKeyPreviewItem(
    document: ProjectDocument,
    uuid: string,
    preferredId: string | null,
): ItemNode | null {
    const key = document.dataSchemas
        .flatMap((schema) => schema.keys)
        .find((entry) => entry.uuid === uuid);
    if (!key) return null;
    const uses = (block: PresentationBlock): boolean => {
        if (block.type === "conditional")
            return (
                [block.condition.left, block.condition.right].some(
                    (value) => value?.kind === "data" && value.key === key.id,
                ) || [...block.thenBlocks, ...block.otherwiseBlocks].some(uses)
            );
        return "data" in block && block.data === key.id;
    };
    const items = dataKeyReferences(document, uuid).items.filter((item) =>
        item.presentation.blocks.some(uses),
    );
    return (
        items.find((item) => itemKey(document, item) === preferredId) ??
        items[0] ??
        null
    );
}

export function validCompoundFieldName(name: string): boolean {
    return (
        /[^\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(
            name,
        ) &&
        name.length <= 128 &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(name)
    );
}

export function validOptionalConstraint(
    raw: string,
    maximum?: number,
): boolean {
    if (raw === "") return true;
    if (maximum !== undefined)
        return /^(0|[1-9][0-9]*)$/.test(raw) && Number(raw) <= maximum;
    return (
        decimalStringSchema.safeParse(raw).success &&
        Number.isFinite(Number(raw))
    );
}

export const constraintLimits = {
    scale: 12,
    maximumCodePoints: 8192,
    maximumElements: 256,
    maximumEntries: 256,
    maximumDepth: 16,
} as const;

export function applicableConstraints(
    kind: DataTypeNode["kind"],
): Set<keyof DataKeyNode["constraints"]> {
    const keys = new Set<keyof DataKeyNode["constraints"]>(["allowedValues"]);
    if (["integer", "long", "decimal"].includes(kind)) {
        keys.add("minimum");
        keys.add("maximum");
    }
    if (kind === "decimal") keys.add("scale");
    if (kind === "string") keys.add("maximumCodePoints");
    if (kind === "list") keys.add("maximumElements");
    if (kind === "compound") keys.add("maximumEntries");
    if (kind === "list" || kind === "compound") keys.add("maximumDepth");
    return keys;
}

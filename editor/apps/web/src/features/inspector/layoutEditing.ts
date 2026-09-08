import { itemLayout, itemTheme } from "@itemerness/protocol";
import type {
    LayoutNode,
    PresentationBlock,
    ProjectDocument,
    Wrapping,
} from "@itemerness/protocol";

export type CanvasLayout = Extract<LayoutNode, { kind: "canvas" }>;
export type LayoutEntryKind = "wrapping" | "anchors";
export type LayoutEditError =
    | "invalidName"
    | "duplicateName"
    | "missingEntry"
    | "referenced"
    | "implicitDefault";
export type LayoutEditResult =
    | { document: ProjectDocument; error: null }
    | { document: null; error: LayoutEditError };

export function layoutNameError(
    name: string,
    names: string[],
    previous?: string,
): LayoutEditError | null {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return "invalidName";
    return name !== previous && names.includes(name) ? "duplicateName" : null;
}

export function layoutNumberError(
    raw: string,
    minimum: number,
    maximum: number,
    step = 1,
): "integerRange" | "step" | null {
    if (
        !/^-?\d+$/.test(raw) ||
        !Number.isSafeInteger(Number(raw)) ||
        Number(raw) < minimum ||
        Number(raw) > maximum
    )
        return "integerRange";
    return Number(raw) % step === 0 ? null : "step";
}

export function defaultWrappingName(layout: LayoutNode): string | undefined {
    return Object.hasOwn(layout.wrapping, "body")
        ? "body"
        : Object.keys(layout.wrapping)[0];
}

export function canvasThemeMismatches(
    document: ProjectDocument,
    layout: CanvasLayout,
) {
    const referenced = new Set(
        document.items
            .filter((item) => itemLayout(document, item) === layout.id)
            .map((item) => itemTheme(document, item)),
    );
    for (const id of referenced) {
        const fallback = document.themes.find(
            (theme) => theme.id === id,
        )?.fallback;
        if (fallback) referenced.add(fallback);
    }
    return document.themes.filter(
        (theme) =>
            referenced.has(theme.id) &&
            theme.renderer === "BITMAP_CANVAS" &&
            theme.canvas &&
            (theme.canvas.widthPixels !== layout.widthPixels ||
                theme.canvas.heightPixels !== layout.heightPixels ||
                theme.canvas.reserveTooltipLines !==
                    layout.reserveTooltipLines),
    );
}

function walkBlocks(
    blocks: PresentationBlock[],
    visit: (block: PresentationBlock) => PresentationBlock,
): PresentationBlock[] {
    return blocks.map((block) =>
        visit(
            block.type === "conditional"
                ? {
                      ...block,
                      thenBlocks: walkBlocks(block.thenBlocks, visit),
                      otherwiseBlocks: walkBlocks(block.otherwiseBlocks, visit),
                  }
                : block,
        ),
    );
}

function usesDefault(block: PresentationBlock) {
    return (
        block.type !== "conditional" &&
        (!("wrapping" in block) || block.wrapping === null)
    );
}

export function layoutEntryReferences(
    document: ProjectDocument,
    layout: LayoutNode,
    kind: LayoutEntryKind,
    name: string,
): number {
    let references = 0;
    for (const item of document.items) {
        if (itemLayout(document, item) !== layout.id) continue;
        walkBlocks(item.presentation.blocks, (block) => {
            if (
                kind === "anchors"
                    ? block.anchor === name
                    : ("wrapping" in block && block.wrapping === name) ||
                      (defaultWrappingName(layout) === name &&
                          usesDefault(block))
            )
                references++;
            return block;
        });
    }
    return references;
}

function renameRecord<T>(
    entries: Record<string, T>,
    previous: string,
    next: string,
): Record<string, T> {
    return Object.fromEntries(
        Object.entries(entries).map(([name, value]) => [
            name === previous ? next : name,
            value,
        ]),
    );
}

function applyWrappingChange(
    document: ProjectDocument,
    layout: LayoutNode,
    wrapping: Record<string, Wrapping>,
    rename?: { previous: string; next: string },
): LayoutEditResult {
    const previousDefault = defaultWrappingName(layout);
    const retainedDefault =
        rename && previousDefault === rename.previous
            ? rename.next
            : previousDefault;
    const nextLayout = { ...layout, wrapping };
    const defaultChanged =
        previousDefault !== undefined &&
        defaultWrappingName(nextLayout) !== retainedDefault;
    let cannotPreserve = false;
    const items = document.items.map((item) => {
        if (itemLayout(document, item) !== layout.id) return item;
        return {
            ...item,
            presentation: {
                ...item.presentation,
                blocks: walkBlocks(item.presentation.blocks, (block) => {
                    if (
                        defaultChanged &&
                        usesDefault(block) &&
                        !("wrapping" in block)
                    )
                        cannotPreserve = true;
                    if (!("wrapping" in block)) return block;
                    if (rename && block.wrapping === rename.previous)
                        return { ...block, wrapping: rename.next };
                    if (defaultChanged && block.wrapping === null)
                        return { ...block, wrapping: retainedDefault ?? null };
                    return block;
                }),
            },
        };
    });
    if (cannotPreserve) return { document: null, error: "implicitDefault" };
    return {
        error: null,
        document: {
            ...document,
            items,
            layouts: document.layouts.map((entry) =>
                entry.uuid === layout.uuid ? nextLayout : entry,
            ),
        },
    };
}

export function renameLayoutEntry(
    document: ProjectDocument,
    uuid: string,
    kind: LayoutEntryKind,
    previous: string,
    next: string,
): LayoutEditResult {
    const layout = document.layouts.find((entry) => entry.uuid === uuid);
    if (!layout || (kind === "anchors" && layout.kind !== "canvas"))
        return { document: null, error: "missingEntry" };
    const entries =
        kind === "wrapping"
            ? layout.wrapping
            : (layout as CanvasLayout).anchors;
    if (!Object.hasOwn(entries, previous))
        return { document: null, error: "missingEntry" };
    const error = layoutNameError(next, Object.keys(entries), previous);
    if (error) return { document: null, error };
    if (previous === next) return { document, error: null };
    if (kind === "wrapping")
        return applyWrappingChange(
            document,
            layout,
            renameRecord(layout.wrapping, previous, next),
            { previous, next },
        );
    const canvas = layout as CanvasLayout;
    return {
        error: null,
        document: {
            ...document,
            layouts: document.layouts.map((entry) =>
                entry.uuid === uuid
                    ? {
                          ...canvas,
                          anchors: renameRecord(canvas.anchors, previous, next),
                      }
                    : entry,
            ),
            items: document.items.map((item) =>
                itemLayout(document, item) !== layout.id
                    ? item
                    : {
                          ...item,
                          presentation: {
                              ...item.presentation,
                              blocks: walkBlocks(
                                  item.presentation.blocks,
                                  (block) =>
                                      block.anchor === previous
                                          ? { ...block, anchor: next }
                                          : block,
                              ),
                          },
                      },
            ),
        },
    };
}

export function removeLayoutEntry(
    document: ProjectDocument,
    uuid: string,
    kind: LayoutEntryKind,
    name: string,
): LayoutEditResult {
    const layout = document.layouts.find((entry) => entry.uuid === uuid);
    if (!layout || (kind === "anchors" && layout.kind !== "canvas"))
        return { document: null, error: "missingEntry" };
    if (layoutEntryReferences(document, layout, kind, name))
        return { document: null, error: "referenced" };
    if (kind === "wrapping")
        return applyWrappingChange(
            document,
            layout,
            Object.fromEntries(
                Object.entries(layout.wrapping).filter(([key]) => key !== name),
            ),
        );
    const canvas = layout as CanvasLayout;
    return {
        error: null,
        document: {
            ...document,
            layouts: document.layouts.map((entry) =>
                entry.uuid === uuid
                    ? {
                          ...canvas,
                          anchors: Object.fromEntries(
                              Object.entries(canvas.anchors).filter(
                                  ([key]) => key !== name,
                              ),
                          ),
                      }
                    : entry,
            ),
        },
    };
}

export function addWrapping(
    document: ProjectDocument,
    uuid: string,
    name: string,
): LayoutEditResult {
    const layout = document.layouts.find((entry) => entry.uuid === uuid);
    if (!layout) return { document: null, error: "missingEntry" };
    const error = layoutNameError(name, Object.keys(layout.wrapping));
    if (error) return { document: null, error };
    return applyWrappingChange(document, layout, {
        ...layout.wrapping,
        [name]: {
            widthPixels: null,
            maximumLines: Math.min(16, document.budgets.maximumLines),
            overflow: "ELLIPSIS",
            preserveExplicitLines: true,
            continuationIndentPixels: 0,
            lineHeightPixels: Math.min(
                10,
                document.budgets.maximumHeightPixels,
            ),
        },
    });
}

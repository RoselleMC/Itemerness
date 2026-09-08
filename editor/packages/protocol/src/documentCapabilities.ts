import type { ProjectDocument } from "./document.js";

export const EXTENDED_BASE_COMPONENTS_CAPABILITY =
    "catalog.base-components.attributes-enchantments";

export function isExtendedBaseComponent(id: string): boolean {
    return [
        "minecraft:attribute_modifiers",
        "minecraft:enchantments",
        "minecraft:stored_enchantments",
    ].includes(id);
}

export function supportsExtendedBaseComponents(
    capabilities: readonly string[] | null | undefined,
): boolean {
    return capabilities?.includes(EXTENDED_BASE_COMPONENTS_CAPABILITY) === true;
}

export function usesExtendedBaseComponents(
    document: Pick<ProjectDocument, "items">,
): boolean {
    return document.items.some((item) =>
        item.definition.baseComponents.some((component) =>
            isExtendedBaseComponent(component.id),
        ),
    );
}

export const SEGMENTED_FRAME_DECORATIONS_CAPABILITY =
    "presentation.segmented-frame.decorations";

export function supportsSegmentedFrameDecorations(
    capabilities: readonly string[] | null | undefined,
): boolean {
    return (
        capabilities?.includes(SEGMENTED_FRAME_DECORATIONS_CAPABILITY) === true
    );
}

/** Old strict decoders reject even inactive fields with null or false values. */
export function usesSegmentedFrameDecorations(
    document: Pick<ProjectDocument, "themes">,
): boolean {
    return document.themes.some((theme) => {
        if (theme.renderer === "SEGMENTED_FRAME" && theme.tooltipStyle != null)
            return true;
        const frame = theme.segmentedFrame;
        return (
            frame != null &&
            (Object.hasOwn(frame, "includeName") ||
                [frame.top, frame.body, frame.connector, frame.bottom].some(
                    (row) =>
                        row != null &&
                        (Object.hasOwn(row, "center") ||
                            Object.hasOwn(row, "kern")),
                ))
        );
    });
}

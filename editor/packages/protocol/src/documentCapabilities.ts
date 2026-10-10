import type { DataTypeNode } from "./common.js";
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

export const DATA_FIELD_CONSTRAINTS_CAPABILITY =
    "catalog.data-keys.field-constraints";

export function supportsDataFieldConstraints(
    capabilities: readonly string[] | null | undefined,
): boolean {
    return capabilities?.includes(DATA_FIELD_CONSTRAINTS_CAPABILITY) === true;
}

function typeUsesFieldConstraints(type: DataTypeNode): boolean {
    if (type.kind === "list") return typeUsesFieldConstraints(type.element);
    if (type.kind !== "compound") return false;
    return (type.fields ?? []).some(
        (field) =>
            Object.hasOwn(field, "constraints") ||
            typeUsesFieldConstraints(field.type),
    );
}

/** Old strict decoders reject a `constraints` property on compound fields. */
export function usesDataFieldConstraints(
    document: Pick<ProjectDocument, "dataSchemas">,
): boolean {
    return document.dataSchemas.some((schema) =>
        schema.keys.some((key) => typeUsesFieldConstraints(key.type)),
    );
}

export const DATA_SCHEMA_OWNER_CAPABILITY = "catalog.data-schemas.owner";

export function supportsDataSchemaOwners(
    capabilities: readonly string[] | null | undefined,
): boolean {
    return capabilities?.includes(DATA_SCHEMA_OWNER_CAPABILITY) === true;
}

/** Old strict decoders reject an `owner` property on data schemas. */
export function usesDataSchemaOwners(
    document: Pick<ProjectDocument, "dataSchemas">,
): boolean {
    return document.dataSchemas.some((schema) =>
        Object.hasOwn(schema, "owner"),
    );
}

export const CATALOG_SOURCE_LAYOUT_CAPABILITY = "catalog.source-layout";

export function supportsCatalogSourceLayout(
    capabilities: readonly string[] | null | undefined,
): boolean {
    return capabilities?.includes(CATALOG_SOURCE_LAYOUT_CAPABILITY) === true;
}

/** Old strict decoders reject a document-level `sourceLayout`. */
export function usesCatalogSourceLayout(
    document: Pick<ProjectDocument, "sourceLayout">,
): boolean {
    return document.sourceLayout !== undefined;
}

export const THEME_SELECTORS_CAPABILITY = "presentation.theme-selectors";

export function supportsThemeSelectors(
    capabilities: readonly string[] | null | undefined,
): boolean {
    return capabilities?.includes(THEME_SELECTORS_CAPABILITY) === true;
}

/** Old strict decoders reject a `themeSelectors` property, even an empty one. */
export function usesThemeSelectors(
    document: Pick<ProjectDocument, "themeSelectors">,
): boolean {
    return Object.hasOwn(document, "themeSelectors");
}

export const RESOURCE_PACK_DELIVERY_CAPABILITY =
    "assets.resource-pack-bindings.delivery";

export function supportsResourcePackDelivery(
    capabilities: readonly string[] | null | undefined,
): boolean {
    return capabilities?.includes(RESOURCE_PACK_DELIVERY_CAPABILITY) === true;
}

/** Old strict decoders reject a binding `delivery` property, even VERIFIED. */
export function usesResourcePackDelivery(
    document: Pick<ProjectDocument, "resourcePackBindings">,
): boolean {
    return document.resourcePackBindings.some((binding) =>
        Object.hasOwn(binding, "delivery"),
    );
}

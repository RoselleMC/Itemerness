import { afterEach, describe, expect, it } from "vitest";
import { previewViewerSchema } from "@itemerness/protocol";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import { itemViewer, useEditorStore } from "../src/state/store.js";
import {
    MAX_SHOWN_FLAGS,
    normalizeShownFlag,
    shownFlagIssue,
    withShownFlags,
} from "../src/state/shownFlags.js";
import { copyItemDocument } from "../src/state/itemCreation.js";

afterEach(() => useEditorStore.getState().setDocument(baselineDocument));

describe("shown flag editing", () => {
    it("normalizes shorthand ids and validates without a component vocabulary", () => {
        expect(normalizeShownFlag(" enchantments ")).toBe(
            "minecraft:enchantments",
        );
        expect(normalizeShownFlag("example:future")).toBe("example:future");
        expect(shownFlagIssue([], "example:future")).toBeNull();
        expect(shownFlagIssue([], "minecraft:Bad")).toBe("invalid");
        expect(shownFlagIssue([], "minecraft:lore")).toBe("owned");
        expect(shownFlagIssue(["example:a"], "example:a")).toBe("duplicate");
        expect(
            shownFlagIssue(
                Array.from(
                    { length: MAX_SHOWN_FLAGS },
                    (_, index) => `example:c${index}`,
                ),
                "example:next",
            ),
        ).toBe("limit");
    });

    it("removes the property when the list becomes empty", () => {
        const presentation = baselineDocument.items[0]!.presentation;
        const shown = withShownFlags(presentation, ["minecraft:enchantments"]);
        expect(shown.shownFlags).toEqual(["minecraft:enchantments"]);
        expect(Object.hasOwn(withShownFlags(shown, []), "shownFlags")).toBe(
            false,
        );
    });

    it("duplicated items keep an independent copy of the list", () => {
        const source = structuredClone(baselineDocument);
        source.items[0] = {
            ...source.items[0]!,
            presentation: withShownFlags(source.items[0]!.presentation, [
                "minecraft:enchantments",
            ]),
        };
        const copied = copyItemDocument(source, source.items[0]!, "copy");
        const copy = copied.items.find((item) => item.id === "copy")!;
        expect(copy.presentation.shownFlags).toEqual([
            "minecraft:enchantments",
        ]);
        expect(copy.presentation.shownFlags).not.toBe(
            source.items[0]!.presentation.shownFlags,
        );
    });
});

describe("item-effective preview viewer", () => {
    const viewer = previewViewerSchema.parse({
        locale: "en_us",
        managesVanillaTooltipLines: true,
    });

    it("defaults the persona to managed lines because rendered items hide vanilla lines", () => {
        expect(useEditorStore.getState().managesVanillaTooltipLines).toBe(true);
    });

    it("keeps managed lines only while the item shows no vanilla component", () => {
        expect(itemViewer(viewer, undefined)).toBe(viewer);
        expect(itemViewer(viewer, [])).toBe(viewer);
        expect(
            itemViewer(viewer, ["minecraft:enchantments"])
                .managesVanillaTooltipLines,
        ).toBe(false);
        const unmanaged = { ...viewer, managesVanillaTooltipLines: false };
        expect(itemViewer(unmanaged, ["minecraft:enchantments"])).toBe(
            unmanaged,
        );
    });
});

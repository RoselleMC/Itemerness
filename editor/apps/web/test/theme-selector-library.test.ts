import { describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    contentHash,
    projectDocumentSchema,
    type ProjectDocument,
    type ThemeSelectorNode,
} from "@itemerness/protocol";
import {
    newThemeSelector,
    reachableThemes,
    removeThemeSelector,
    renameThemeSelector,
    representativeTheme,
    themeSelectorIdError,
    themeSelectorReferences,
    withThemeSelectors,
} from "../src/state/themeSelectorLibrary.js";
import {
    newTheme,
    removeThemeLayout,
    renameThemeLayout,
    themeLayoutIdError,
    themeLayoutReferences,
} from "../src/state/themeLayoutLibrary.js";
import { canvasThemeMismatches } from "../src/features/inspector/layoutEditing.js";

const selector: ThemeSelectorNode = {
    uuid: "8c7c4b1e-6a7e-4a55-9b8e-2f3c0b6d5a10",
    id: "example:charge-frame",
    cases: [
        {
            condition: {
                operator: "EXISTS",
                left: { kind: "data", key: "example:charges" },
                right: null,
            },
            theme: "itemerness:ember",
        },
    ],
    defaultTheme: "itemerness:default",
};

function withSelector(): ProjectDocument {
    const document = withThemeSelectors(structuredClone(baselineDocument), [
        selector,
    ]);
    document.items[0]!.presentation.theme = selector.id;
    return document;
}

describe("theme selector library", () => {
    it("keeps the field absent rather than empty", () => {
        const document = structuredClone(baselineDocument);
        const hash = contentHash(document);
        const added = withThemeSelectors(document, [selector]);
        expect(added.themeSelectors).toEqual([selector]);
        const removed = withThemeSelectors(added, []);
        expect(Object.hasOwn(removed, "themeSelectors")).toBe(false);
        expect(contentHash(removed)).toBe(hash);
    });

    it("creates and duplicates selectors with fresh ids in the shared theme id space", () => {
        const document = withSelector();
        const created = newThemeSelector(document)!;
        expect(created.cases).toEqual([]);
        expect(created.defaultTheme).toBe(document.themes[0]!.id);
        const copy = newThemeSelector(document, selector)!;
        expect(copy.uuid).not.toBe(selector.uuid);
        expect(copy.id).toBe("example:charge-frame-copy");
        expect(copy.cases).toEqual(selector.cases);
        expect(
            projectDocumentSchema.safeParse(
                withThemeSelectors(document, [selector, created, copy]),
            ).success,
        ).toBe(true);
        expect(
            themeSelectorIdError(document, created.uuid, "itemerness:default"),
        ).toBe("duplicateId");
        expect(
            themeLayoutIdError(
                document,
                "themes",
                document.themes[0]!.uuid,
                selector.id,
            ),
        ).toBe("duplicateId");
        expect(
            newTheme(
                withThemeSelectors(document, [
                    { ...selector, id: "itemerness:new-theme" },
                ]),
            ).id,
        ).not.toBe("itemerness:new-theme");
    });

    it("tracks references in both directions and refuses unsafe deletion", () => {
        const document = withSelector();
        expect(themeSelectorReferences(document, selector.id)).toEqual([
            "itemerness:travel-token",
        ]);
        expect(
            themeLayoutReferences(document, "themes", "itemerness:ember"),
        ).toContain(selector.id);
        expect(removeThemeSelector(document, selector.uuid)).toBe(document);
        const ember = document.themes.find(
            (theme) => theme.id === "itemerness:ember",
        )!;
        expect(removeThemeLayout(document, "themes", ember.uuid)).toBe(
            document,
        );
        const unbound = structuredClone(document);
        unbound.items[0]!.presentation.theme = "itemerness:vanilla-frame";
        expect(
            Object.hasOwn(
                removeThemeSelector(unbound, selector.uuid),
                "themeSelectors",
            ),
        ).toBe(false);
    });

    it("renames selectors and themes together with every reference", () => {
        const document = {
            ...withSelector(),
            schemaVersion: 2 as const,
            defaultTheme: selector.id,
        };
        const renamed = renameThemeSelector(
            document,
            selector.uuid,
            "example:quality-frame",
        );
        expect(renamed.themeSelectors![0]!.id).toBe("example:quality-frame");
        expect(renamed.items[0]!.presentation.theme).toBe(
            "example:quality-frame",
        );
        expect(renamed.defaultTheme).toBe("example:quality-frame");
        const ember = document.themes.find(
            (theme) => theme.id === "itemerness:ember",
        )!;
        const themeRenamed = renameThemeLayout(
            document,
            "themes",
            ember.uuid,
            "itemerness:cinder",
        );
        expect(themeRenamed.themeSelectors![0]!.cases[0]!.theme).toBe(
            "itemerness:cinder",
        );
        const fallback = document.themes.find(
            (theme) => theme.id === "itemerness:default",
        )!;
        expect(
            renameThemeLayout(
                document,
                "themes",
                fallback.uuid,
                "itemerness:plain-text",
            ).themeSelectors![0]!.defaultTheme,
        ).toBe("itemerness:plain-text");
    });

    it("exposes every theme a binding can reach for per-theme checks", () => {
        const document = withSelector();
        expect(
            reachableThemes(document, selector.id).map((theme) => theme.id),
        ).toEqual(["itemerness:ember", "itemerness:default"]);
        expect(representativeTheme(document, selector.id)?.id).toBe(
            "itemerness:default",
        );
        const canvas = document.layouts.find(
            (layout) => layout.kind === "canvas",
        )!;
        const mismatched = withThemeSelectors(structuredClone(document), [
            {
                ...selector,
                cases: [
                    {
                        ...selector.cases[0]!,
                        theme: "itemerness:aurora-canvas",
                    },
                ],
            },
        ]);
        const survey = mismatched.items.find(
            (item) => item.id === "survey-codex",
        )!;
        survey.presentation.theme = selector.id;
        const aurora = mismatched.themes.find(
            (theme) => theme.id === "itemerness:aurora-canvas",
        )!;
        aurora.canvas!.widthPixels += 1;
        expect(
            canvasThemeMismatches(
                mismatched,
                canvas as Parameters<typeof canvasThemeMismatches>[1],
            ).map((theme) => theme.id),
        ).toContain("itemerness:aurora-canvas");
    });
});

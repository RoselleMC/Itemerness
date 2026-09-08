import { describe, expect, it } from "vitest";
import { baselineDocument } from "@itemerness/protocol/fixtures/baseline.js";
import {
    formatNodeSchema,
    localeSchema,
    messageKeySchema,
    presentationBlockSchema,
    viewerFactNodeSchema,
} from "@itemerness/protocol";
import {
    addLocale,
    canSetFallback,
    hasDynamicMessageReference,
    localeInUse,
    messageInUse,
    removeLocale,
    removeMessage,
    renameLocale,
    renameMessage,
} from "../src/features/locales/localeEditing.js";
import { useEditorStore } from "../src/state/store.js";

describe("locale and message authoring", () => {
    it("uses the production locale and message identifier rules", () => {
        for (const code of ["en_us", "zh_cn", "en_us_posix"])
            expect(localeSchema.safeParse(code).success).toBe(true);
        for (const code of ["en", "EN_us", "english_us", "en_123"])
            expect(localeSchema.safeParse(code).success).toBe(false);
        for (const key of ["item.name", "0-test_key"])
            expect(messageKeySchema.safeParse(key).success).toBe(true);
        for (const key of ["UPPER", "_prefix", "a:b"])
            expect(messageKeySchema.safeParse(key).success).toBe(false);
    });
    it("adds empty languages with a known fallback and duplicates independent translations", () => {
        const document = structuredClone(baselineDocument);
        const added = addLocale(document, "fr_fr");
        expect(added.locales.at(-1)).toMatchObject({
            locale: "fr_fr",
            fallback: document.defaultLocale,
            messages: {},
        });
        const duplicated = addLocale(
            document,
            "de_de",
            document.locales[0]!.uuid,
        );
        expect(duplicated.locales.at(-1)!.messages).toEqual(
            document.locales[0]!.messages,
        );
        expect(duplicated.locales.at(-1)!.messages).not.toBe(
            document.locales[0]!.messages,
        );
        expect(duplicated.locales.at(-1)!.uuid).not.toBe(
            document.locales[0]!.uuid,
        );
        expect(addLocale(document, document.defaultLocale)).toBe(document);
    });
    it("renames default, fallback and typed locale facts in one undoable transaction", () => {
        const document = addLocale(structuredClone(baselineDocument), "fr_fr");
        document.viewerFacts.push(
            viewerFactNodeSchema.parse({
                uuid: crypto.randomUUID(),
                id: "test:language",
                type: "LOCALE",
                providers: ["locale"],
                defaultValue: { kind: "string", value: "en_us" },
                previewValue: { kind: "string", value: "en_us" },
            }),
        );
        const state = () => useEditorStore.getState();
        state().resetDraft();
        state().setDocument(document);
        state().updateDocument((document) =>
            renameLocale(
                document,
                document.locales.find((entry) => entry.locale === "en_us")!
                    .uuid,
                "en_gb",
            ),
        );
        expect(state().document.defaultLocale).toBe("en_gb");
        expect(state().document.locales.at(-1)!.fallback).toBe("en_gb");
        expect(state().document.viewerFacts.at(-1)).toMatchObject({
            defaultValue: { kind: "string", value: "en_gb" },
            previewValue: { kind: "string", value: "en_gb" },
        });
        state().undo();
        expect(state().document).toEqual(document);
    });
    it("rejects fallback cycles and protects default, fallback and fact targets from deletion", () => {
        const document = addLocale(structuredClone(baselineDocument), "fr_fr");
        const en = document.locales.find((entry) => entry.locale === "en_us")!;
        const fr = document.locales.at(-1)!;
        expect(canSetFallback(document, en.uuid, "fr_fr")).toBe(false);
        expect(canSetFallback(document, fr.uuid, "fr_fr")).toBe(false);
        expect(canSetFallback(document, fr.uuid, "unknown")).toBe(false);
        expect(canSetFallback(document, fr.uuid, null)).toBe(true);
        expect(removeLocale(document, en.uuid)).toBe(document);
        expect(removeLocale(document, fr.uuid).locales).not.toContainEqual(fr);
        document.viewerFacts.push(
            viewerFactNodeSchema.parse({
                uuid: crypto.randomUUID(),
                id: "test:language",
                type: "LOCALE",
                providers: ["locale"],
                nullable: true,
                previewValue: { kind: "string", value: "fr_fr" },
            }),
        );
        expect(localeInUse(document, "fr_fr")).toBe(true);
        expect(removeLocale(document, fr.uuid)).toBe(document);
    });
    it("renames every static reference and preserves absent versus empty translations", () => {
        const document = structuredClone(baselineDocument);
        const item = document.items[0]!;
        item.presentation.nameMessage = "test.old";
        item.presentation.blocks = [
            presentationBlockSchema.parse({
                uuid: crypto.randomUUID(),
                type: "conditional",
                condition: {
                    operator: "EXISTS",
                    left: {
                        kind: "literal",
                        value: { kind: "boolean", value: true },
                    },
                },
                thenBlocks: [
                    {
                        uuid: crypto.randomUUID(),
                        type: "field",
                        labelMessage: "test.old",
                        data: "example:charges",
                    },
                ],
                otherwiseBlocks: [
                    {
                        uuid: crypto.randomUUID(),
                        type: "repeat",
                        data: "example:contents",
                        maximumElements: 2,
                        template: {
                            labelMessage: "test.old",
                            missingMessage: "test.old",
                            valuePath: "value",
                        },
                    },
                ],
            }),
        ];
        document.formats.push(
            formatNodeSchema.parse({
                uuid: crypto.randomUUID(),
                id: "test:boolean",
                kind: "boolean",
                trueMessage: "test.old",
                falseMessage: "test.old",
            }),
        );
        document.locales[0]!.messages["test.old"] = "";
        const renamed = renameMessage(document, "test.old", "test.new");
        expect(JSON.stringify(renamed)).not.toContain('"test.old"');
        expect(renamed.locales[0]!.messages["test.new"]).toBe("");
        expect(Object.hasOwn(renamed.locales[1]!.messages, "test.new")).toBe(
            false,
        );
        expect(messageInUse(renamed, "test.new")).toBe(true);
        expect(removeMessage(renamed, "test.new")).toBe(renamed);
        expect(renameMessage(renamed, "test.new", "BAD")).toBe(renamed);
    });
    it("protects dynamic patterns without matching unrelated message keys", () => {
        const document = structuredClone(baselineDocument);
        document.formats.push(
            formatNodeSchema.parse({
                uuid: crypto.randomUUID(),
                id: "test:enum",
                kind: "namespacedKey",
                mode: "MESSAGE",
                messagePattern: "material.{namespace}.{path}",
            }),
        );
        document.locales[0]!.messages["material.minecraft.stone"] = "Stone";
        expect(
            hasDynamicMessageReference(document, "material.minecraft.stone"),
        ).toBe(true);
        expect(
            hasDynamicMessageReference(document, "materialXminecraftXstone"),
        ).toBe(false);
        expect(
            renameMessage(document, "material.minecraft.stone", "new.stone"),
        ).toBe(document);
        expect(removeMessage(document, "material.minecraft.stone")).toBe(
            document,
        );
        document.locales[0]!.messages["unused.key"] = "Unused";
        expect(
            removeMessage(document, "unused.key").locales[0]!.messages,
        ).not.toHaveProperty("unused.key");
    });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentHash, projectDocumentSchema } from "../src/index.js";

const raw: unknown = JSON.parse(
    readFileSync(
        new URL("../fixtures/catalog-boundary-golden.json", import.meta.url),
        "utf8",
    ),
);

describe("actual YAML loader boundary contract", () => {
    it("accepts the JVM reader document without changing bytes or values", () => {
        const parsed = projectDocumentSchema.parse(raw);
        expect(parsed).toEqual(raw);
        expect(contentHash(parsed)).toBe(contentHash(raw));
        expect(parsed.fonts).toHaveLength(129);
        const schema = parsed.dataSchemas.find(
            (schema) => schema.id === "boundary:many-keys",
        )!;
        expect(schema.keys).toHaveLength(513);
        const compound = schema.keys.find(
            (key) => key.id === "boundary:key-0",
        )!.type;
        expect(compound.kind).toBe("compound");
        if (compound.kind === "compound") {
            expect(compound.fields).toHaveLength(257);
            expect(
                compound.fields!.some((field) => field.name === "\uFEFF"),
            ).toBe(true);
        }
        expect(parsed.glyphs.some((glyph) => glyph.id.length > 300)).toBe(true);
        const english = parsed.locales.find(
            (locale) => locale.locale === "en_us",
        )!;
        expect(english.messages["boundary.ascii"]).toHaveLength(8193);
        expect([...english.messages["boundary.supplementary"]!]).toHaveLength(
            16384,
        );
        expect(
            parsed.resourcePackBindings.find(
                (binding) => binding.id === "boundary:enabled",
            )!.sha1,
        ).toBe("ABCDEF0123456789ABCDEF0123456789ABCDEF01");
        expect(
            parsed.resourcePackBindings.find(
                (binding) => binding.id === "boundary:disabled",
            )!.sha1,
        ).toBe("replace with a real hash");
        expect(
            parsed.bitmaps.find(
                (bitmap) => bitmap.id === "boundary.empty-baseline",
            )!.baselineVariant,
        ).toBe("");
        const literals = parsed.items
            .find((item) => item.id === "itemerness:travel-token")!
            .presentation.blocks.filter((block) => block.type === "conditional")
            .map((block) => block.condition.left)
            .filter((reference) => reference.kind === "literal")
            .map((reference) => reference.value);
        expect(
            literals.some(
                (value) =>
                    value.kind === "string" && value.value.length === 65537,
            ),
        ).toBe(true);
        expect(
            literals.some(
                (value) =>
                    value.kind === "list" && value.values.length === 4097,
            ),
        ).toBe(true);
        expect(
            literals.some((value) => {
                let depth = 0;
                while (value.kind === "list" && value.values.length === 1) {
                    depth += 1;
                    value = value.values[0]!;
                }
                return depth === 17;
            }),
        ).toBe(true);
    });

    it("retains production code-point, enabled hash, fact-count, and Int limits", () => {
        const document = projectDocumentSchema.parse(raw);
        document.locales.find((locale) => locale.locale === "en_us")!.messages[
            "boundary.supplementary"
        ] += "a";
        expect(projectDocumentSchema.safeParse(document).success).toBe(false);
        const enabled = projectDocumentSchema.parse(raw);
        enabled.resourcePackBindings.find(
            (binding) => binding.id === "boundary:disabled",
        )!.enabled = true;
        expect(projectDocumentSchema.safeParse(enabled).success).toBe(false);
        const facts = projectDocumentSchema.parse(raw);
        facts.viewerFacts = Array.from({ length: 257 }, () =>
            structuredClone(facts.viewerFacts[0]!),
        );
        expect(projectDocumentSchema.safeParse(facts).success).toBe(false);
        const numeric = projectDocumentSchema.parse(raw);
        const layout = numeric.layouts.find((value) => value.kind === "flow")!;
        if (layout.kind !== "flow") throw new Error("Expected flow layout");
        layout.fieldIconGapPixels = 2147483647;
        expect(projectDocumentSchema.safeParse(numeric).success).toBe(true);
        layout.fieldIconGapPixels += 1;
        expect(projectDocumentSchema.safeParse(numeric).success).toBe(false);
    });
});

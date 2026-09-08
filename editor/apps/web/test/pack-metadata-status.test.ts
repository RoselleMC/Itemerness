import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { mountArchive } from "@itemerness/mc-assets";
import { PackMetadataStatus } from "../src/features/assets/PackMetadataStatus.js";
import en from "../src/i18n/locales/en-US/packMetadata.json";
import zh from "../src/i18n/locales/zh-CN/packMetadata.json";

async function renderMetadata(
    metadata: unknown,
    kind: "vanilla" | "resource-pack" = "resource-pack",
    lng = "en-US",
) {
    const pack = mountArchive(
        zipSync({
            "pack.mcmeta": new TextEncoder().encode(
                JSON.stringify({ pack: metadata }),
            ),
        }),
        { name: "fixture.zip", kind },
    );
    const i18n = createInstance();
    await i18n.init({
        lng,
        resources: {
            "en-US": { packMetadata: en },
            "zh-CN": { packMetadata: zh },
        },
        interpolation: { escapeValue: false },
    });
    return renderToStaticMarkup(
        createElement(
            I18nextProvider,
            { i18n },
            createElement(PackMetadataStatus, { pack }),
        ),
    );
}

describe("mounted pack metadata status", () => {
    it("describes mismatch without blocking local preview or claiming client validation", async () => {
        const markup = await renderMetadata({ pack_format: 75 });
        expect(markup).toContain('data-pack-format-status="outside"');
        expect(markup).toContain(
            "Declared format 75 does not include preview baseline Minecraft 26.1.2 (84.0)",
        );
        expect(markup).toContain("Source: pack_format");
        expect(markup).toContain(
            "Metadata only, not client compatibility verification. Local preview remains available.",
        );
        expect(markup).not.toContain("disabled");
    });

    it("distinguishes declared inclusion from verified compatibility", async () => {
        const markup = await renderMetadata({
            min_format: [84, 0],
            max_format: 84,
        });
        expect(markup).toContain('data-pack-format-status="included"');
        expect(markup).toContain("Declared format 84.0 - 84.* includes");
        expect(markup).toContain("Source: min_format/max_format");
        expect(markup).toContain("not client compatibility verification");
    });

    it("shows an explicit unknown state with the preview baseline", async () => {
        const markup = await renderMetadata({ min_format: 84 });
        expect(markup).toContain('data-pack-format-status="unknown"');
        expect(markup).toContain(
            "Unknown format declaration. Preview baseline: Minecraft 26.1.2 (84.0)",
        );
    });

    it("localizes declaration states and omits vanilla packs", async () => {
        expect(
            await renderMetadata({ pack_format: 75 }, "resource-pack", "zh-CN"),
        ).toContain("声明格式 75 不包含预览基线 Minecraft 26.1.2（84.0）");
        expect(await renderMetadata({ pack_format: 75 }, "vanilla")).toBe("");
    });
});

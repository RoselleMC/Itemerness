# Itemerness resource-pack layer

This directory contains the client assets referenced by Itemerness presentation manifests.

The active server merges the `assets/` directory into BetterHud's generated pack. Keep font
codepoints synchronized with `itemerness-bukkit/src/main/resources/assets/glyphs.yml`.

Run `node tools/generate-itemerness-spacing-font.mjs` after changing the signed spacing ranges.

#!/usr/bin/env python3
"""Emit the glyph / bitmap / theme YAML for the sliced Epic Tooltip frames.

`slice-epic-tooltip.py` writes the textures and a manifest; this turns that
manifest into the registry entries the plugin reads. Keeping it generated means
the 66 pieces cannot drift from the textures they describe.

Usage:
    python emit-frame-registry.py <manifest.json> <out-dir>

Writes `frame-glyphs.yml`, `frame-bitmaps.yml` and `quality-<tier>.yml`.
"""

from __future__ import annotations

import json
import os
import sys

TIERS = ["common", "uncommon", "rare", "unique", "legendary", "corruption"]
KERN = "frame.kern.minus-one"

# Palettes match the theme files already on the server; only the frame changes.
PALETTES = {
    "common": ("#d8d8e0", "#7a7a85", "#e8e8f0", "#9a9aa5"),
    "uncommon": ("#6ee87d", "#5a8f62", "#d8f5dc", "#8fbf97"),
    "rare": ("#6cb8ff", "#5a7d9f", "#d8ecff", "#8fadc9"),
    "unique": ("#6cb8ff", "#5a7d9f", "#d8ecff", "#8fadc9"),
    "legendary": ("#ffbb55", "#b3854a", "#ffe9c9", "#d9b98c"),
    "corruption": ("#c88cff", "#8a6a9f", "#eddcff", "#b09ac4"),
}

SOURCE_NOTE = {
    "common": "Epic Tooltip `normal`.",
    "uncommon": "Epic Tooltip `rare`.",
    "rare": "Epic Tooltip `unique`.",
    "unique": "Epic Tooltip `legendary`.",
    "legendary": "Epic Tooltip `mythic`.",
    "corruption": (
        "Epic Tooltip `legendary`, channel-rotated (R,G,B)->(G,B,R); the panel "
        "fill is rotated back to #140a18 so it does not read green."
    ),
}


def bounds(entry: dict) -> str:
    top = -entry["ascent"]
    bottom = entry["height"] - entry["ascent"]
    return f"{{left: 0, right: {entry['ink']}, top: {top}, bottom: {bottom}}}"


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    manifest = json.load(open(sys.argv[1], encoding="utf-8"))
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)

    ordered = [k for k in manifest if k != KERN]

    glyphs = [
        "  # Epic Tooltip frame pieces, cut by tools/slice-epic-tooltip.py.",
        "  # Advances are ink+1 because that is what Minecraft gives a bitmap glyph; the kern at the",
        "  # end of this block cancels that pixel so the pieces tile without a seam.",
    ]
    for key in ordered:
        entry = manifest[key]
        glyphs += [
            f"  {key}:",
            "    font: itemerness:frame",
            f"    codepoint: U+{entry['codepoint']:04X}",
            f"    bitmap: {key}",
            f"    advance-pixels: {entry['advance']}",
            f"    visual-bounds: {bounds(entry)}",
        ]
    kern = manifest[KERN]
    glyphs += [
        "",
        "  # Pulls the cursor back over the pixel Minecraft adds past a bitmap glyph's ink. Lives in",
        "  # itemerness:frame rather than itemerness:spacing so a frame row stays a single run.",
        f"  {KERN}:",
        "    font: itemerness:frame",
        f"    codepoint: U+{kern['codepoint']:04X}",
        f"    advance-pixels: {kern['advance']}",
        "    visual-bounds: {left: 0, right: 0, top: 0, bottom: 0}",
    ]

    bitmaps = [
        "  # Epic Tooltip frame pieces, cut by tools/slice-epic-tooltip.py.",
    ]
    for key in ordered:
        entry = manifest[key]
        bitmaps += [
            f"  {key}:",
            f"    texture: {entry['texture']}",
            f"    source-width-pixels: {entry['ink']}",
            f"    source-height-pixels: {entry['height']}",
            f"    render-width-pixels: {entry['ink']}",
            f"    render-height-pixels: {entry['height']}",
            f"    ascent-pixels: {entry['ascent']}",
            f"    visual-bounds: {bounds(entry)}",
        ]

    with open(os.path.join(out, "frame-glyphs.yml"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(glyphs) + "\n")
    with open(os.path.join(out, "frame-bitmaps.yml"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(bitmaps) + "\n")

    for tier in TIERS:
        name, label, value, description = PALETTES[tier]
        rows = []
        for row in ("top", "body", "bottom"):
            rows.append(f"      {row}:")
            rows.append(f"        left: frame.{tier}.{row}-left")
            rows.append(f"        fill: frame.{tier}.{row}-fill")
            if row != "body":
                rows.append(f"        center: frame.{tier}.{row}-center")
            rows.append(f"        right: frame.{tier}.{row}-right")
            rows.append(f"        kern: {KERN}")
        body = f"""# Rarity ladder: {tier}. Frame art: {SOURCE_NOTE[tier]}
# Pieces are cut by tools/slice-epic-tooltip.py and registered in assets/glyphs.yml.
schema-version: 1

themes:
  itemerness:quality-{tier}:
    renderer: segmented-frame
    requires-resource-pack: true
    requires-capabilities:
      - itemerness:segmented-frame-v1
      - itemerness:signed-advance-v1
    # The frame paints its own opaque panel, so an unmanaged lore line would land outside it.
    vanilla-tooltip-lines: require-managed
    fallback: itemerness:vanilla-frame
    # Blanks vanilla's background, which would otherwise show as a second border around the frame.
    tooltip-style: itemerness:transparent-canvas
    fonts:
      text: itemerness:body
      icons: itemerness:icons
      frame: itemerness:frame
      spacing: itemerness:spacing
    frame:
      width: layout
      # The widest fixed run is legendary's top row at 115px, so this clears every tier.
      minimum-width-pixels: 140
      maximum-width-pixels: 220
      left-padding-pixels: 8
      right-padding-pixels: 8
{chr(10).join(rows)}
      fill-mode: exact-pixel
      height-mode: repeat-for-rendered-lines
    wrapping:
      enforce-frame-width: true
      overflow: wrap
    styles:
      item-name:
        color: "{name}"
      label:
        color: "{label}"
      value:
        color: "{value}"
      requirement-met:
        color: "#8bd17c"
      requirement-unmet:
        color: "#ff6961"
      description:
        color: "{description}"
"""
        with open(
            os.path.join(out, f"quality-{tier}.yml"), "w", encoding="utf-8"
        ) as handle:
            handle.write(body)

    print(f"{len(ordered)} glyph/bitmap entries + {len(TIERS)} themes -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

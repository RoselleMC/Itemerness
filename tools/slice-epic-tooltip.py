#!/usr/bin/env python3
"""Slice the Epic Tooltip strips into SEGMENTED_FRAME pieces.

Epic ships each frame row as one fixed-width 161px bitmap glyph, which is why
its own docs cap a line at 25 characters. Cutting each strip into
`left / fill / center / fill / right` lets the frame track the text width
instead.

Each strip has the same shape: a corner cap, a band of identical columns, a
centre ornament, the same band again, and the mirrored corner cap. The tileable
band is found by taking the most common column type and keeping its two longest
runs; the centre ornament is whatever sits between them. `tooltip_middle` has no
ornament, so its second run is too short to qualify and it stays a three-piece
row.

Every cut is proven rather than trusted: the pieces are reassembled at the
source width and compared to the original pixel for pixel.

A Minecraft bitmap glyph always advances `inkWidth + 1`, so laying pieces
end to end leaves a 1px gap at every seam -- visible as a dashed break in the
frame's highlight line. Each piece is therefore followed by a -1px kern glyph,
emitted into the same `itemerness:frame` font as a `space` provider so a whole
frame row still collapses into a single styled run.

Usage:
    python slice-epic-tooltip.py <epic-source-dir> <resource-pack-assets-dir>

e.g. python slice-epic-tooltip.py \\
        "C:/Users/.../Epic Tooltip Resources Pack/assets/hunt/textures/epic_tooltip" \\
        G:/jar/Itemerness/resource-pack/assets/itemerness
"""

from __future__ import annotations

import json
import os
import sys

from epic_png import Rows, crop, read_png, write_png

# Our rarity ladder -> the Epic tier its artwork comes from. Read off pixels by
# `analyze-epic-tooltip.py`, not off the theme files' header comments.
TIERS = {
    "common": "normal",
    "uncommon": "rare",
    "rare": "unique",
    "unique": "legendary",
    "legendary": "mythic",
    "corruption": "legendary",  # plus the channel rotation below
}

# `corruption` is a recolour of the Epic legendary artwork: the author rotated
# every pixel's channels (R,G,B) -> (G,B,R). That also dragged the panel fill
# from #140a18 to #0a1814, tinting it green; the ladder's other five tiers all
# sit on #140a18, so the fill is rotated back.
PANEL_FILL = (0x14, 0x0A, 0x18)
ROTATED_PANEL_FILL = (0x0A, 0x18, 0x14)

# Rows come straight from Epic's `assets/minecraft/font/default.json`.
ROW_METRICS = {
    "top": {"ascent": 19, "height": 23},
    "body": {"ascent": 8, "height": 10},
    "bottom": {"ascent": 8, "height": 15},
}

# A run of the tileable column type shorter than this is ornament detail, not
# the second tileable band.
MINIMUM_BAND = 5

DRAWN_WIDTH = 161  # the strips are 255px wide; only x=0..160 is drawn


def rotate_channels(rows: Rows) -> Rows:
    output: Rows = []
    for row in rows:
        out = []
        for r, g, b, a in row:
            rotated = (g, b, r)
            if rotated == ROTATED_PANEL_FILL:
                rotated = PANEL_FILL
            out.append((*rotated, a))
        output.append(out)
    return output


def column_types(rows: Rows, width: int) -> list[tuple]:
    return [tuple(rows[y][x] for y in range(len(rows))) for x in range(width)]


def runs_of(cols: list[tuple], target: tuple) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    start = None
    for x, col in enumerate(cols):
        if col == target:
            if start is None:
                start = x
        elif start is not None:
            spans.append((start, x - 1))
            start = None
    if start is not None:
        spans.append((start, len(cols) - 1))
    return spans


def plan_cuts(rows: Rows) -> dict:
    """Works out the left / fill / center / right column spans for one strip."""
    cols = column_types(rows, DRAWN_WIDTH)
    counts: dict[tuple, int] = {}
    for col in cols:
        counts[col] = counts.get(col, 0) + 1
    band_column = max(counts, key=lambda c: counts[c])

    spans = runs_of(cols, band_column)
    spans.sort(key=lambda s: s[1] - s[0], reverse=True)
    first = spans[0]
    second = next(
        (s for s in spans[1:] if s[1] - s[0] + 1 >= MINIMUM_BAND), None
    )
    if second is None:
        left_band, right_band = first, first
    else:
        left_band, right_band = sorted([first, second])

    plan = {
        "left": (0, left_band[0] - 1),
        "fill": (left_band[0], left_band[0]),
        "right": (right_band[1] + 1, DRAWN_WIDTH - 1),
        "left_fill_count": left_band[1] - left_band[0] + 1,
    }
    if second is None:
        plan["center"] = None
        plan["right_fill_count"] = 0
    else:
        plan["center"] = (left_band[1] + 1, right_band[0] - 1)
        plan["right_fill_count"] = right_band[1] - right_band[0] + 1
    return plan


def verify(rows: Rows, plan: dict) -> None:
    """Reassembles the pieces and demands a pixel-for-pixel match."""
    pieces: list[Rows] = [crop(rows, *plan["left"])]
    fill = crop(rows, *plan["fill"])
    pieces += [fill] * plan["left_fill_count"]
    if plan["center"]:
        pieces.append(crop(rows, *plan["center"]))
        pieces += [fill] * plan["right_fill_count"]
    pieces.append(crop(rows, *plan["right"]))

    rebuilt = [[] for _ in rows]
    for piece in pieces:
        for y, row in enumerate(piece):
            rebuilt[y].extend(row)

    original = [row[:DRAWN_WIDTH] for row in rows]
    if rebuilt != original:
        width = len(rebuilt[0])
        raise SystemExit(
            f"reassembly mismatch: rebuilt {width}px vs source {DRAWN_WIDTH}px"
        )


def ink_width(piece: Rows) -> int:
    widest = 0
    for row in piece:
        for x, px in enumerate(row):
            if px[3]:
                widest = max(widest, x + 1)
    return widest


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    source, assets = sys.argv[1], sys.argv[2]
    texture_root = os.path.join(assets, "textures", "font", "frame")
    os.makedirs(texture_root, exist_ok=True)

    manifest: dict[str, dict] = {}
    providers: list[dict] = []
    # U+E110 onward; U+E101..U+E10C are the placeholder segment glyphs already
    # in glyphs.yml and U+E1FF is reserved below for the kern.
    codepoint = 0xE110

    for tier, epic in TIERS.items():
        rotate = tier == "corruption"
        for row_kind, filename in (
            ("top", f"tooltip_top-{epic}.png"),
            ("body", "tooltip_middle.png"),
            ("bottom", f"tooltip_bottom-{epic}.png"),
        ):
            rows = read_png(os.path.join(source, filename))
            if rotate:
                rows = rotate_channels(rows)
            plan = plan_cuts(rows)
            verify(rows, plan)

            metrics = ROW_METRICS[row_kind]
            for part in ("left", "fill", "center", "right"):
                span = plan[part]
                if span is None:
                    continue
                piece = crop(rows, *span)
                name = f"{row_kind}_{part}"
                relative = os.path.join(tier, f"{name}.png")
                path = os.path.join(texture_root, relative)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                write_png(path, piece)

                width = len(piece[0])
                ink = ink_width(piece)
                glyph_id = f"frame.{tier}.{row_kind}-{part}"
                manifest[glyph_id] = {
                    "codepoint": codepoint,
                    "texture": f"itemerness:font/frame/{tier}/{name}.png",
                    "width": width,
                    "ink": ink,
                    # Minecraft: floor(0.5 + ink * scale) + 1, scale = 1 here.
                    "advance": ink + 1,
                    "height": metrics["height"],
                    "ascent": metrics["ascent"],
                    "span": list(span),
                }
                providers.append(
                    {
                        "type": "bitmap",
                        "file": f"itemerness:font/frame/{tier}/{name}.png",
                        "ascent": metrics["ascent"],
                        "height": metrics["height"],
                        "chars": [chr(codepoint)],
                    }
                )
                codepoint += 1

            print(
                f"{tier:11} {row_kind:6} left=x{plan['left'][0]}-{plan['left'][1]}"
                f"  fill=x{plan['fill'][0]}"
                + (
                    f"  center=x{plan['center'][0]}-{plan['center'][1]}"
                    if plan["center"]
                    else "  center=-"
                )
                + f"  right=x{plan['right'][0]}-{plan['right'][1]}"
                f"  (bands {plan['left_fill_count']}+{plan['right_fill_count']})"
                "  rebuild=ok"
            )

    kern = 0xE1FF
    providers.append({"type": "space", "advances": {chr(kern): -1}})
    manifest["frame.kern.minus-one"] = {
        "codepoint": kern,
        "texture": None,
        "width": 0,
        "ink": 0,
        "advance": -1,
        "height": 0,
        "ascent": 0,
        "span": None,
    }

    font_dir = os.path.join(assets, "font")
    os.makedirs(font_dir, exist_ok=True)
    with open(os.path.join(font_dir, "frame.json"), "w", encoding="utf-8") as handle:
        # `ensure_ascii` keeps the private-use code points as \uXXXX escapes,
        # the way Epic's own `default.json` writes them.
        json.dump({"providers": providers}, handle, ensure_ascii=True, indent=4)
        handle.write("\n")

    with open(
        os.path.join(os.path.dirname(__file__), "epic-tooltip-manifest.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=4)
        handle.write("\n")

    print()
    print(f"{len(manifest) - 1} frame glyphs + 1 kern -> {font_dir}/frame.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

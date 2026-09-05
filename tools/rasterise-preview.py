#!/usr/bin/env python3
"""Rasterise a composed tooltip dump into a PNG so the frame can be eyeballed.

The unit tests can prove the rows all came out the same width; they cannot show
that the frame looks like a frame. This pastes the actual resource-pack pieces
at the advances the compositor chose, so a seam, a mis-centred ornament or a row
that overhangs its border is visible rather than inferred.

Text glyphs are drawn as translucent blocks the width of their advance: the
subject here is the frame, and rendering vanilla's font would need its atlas.

Usage:
    python rasterise-preview.py <preview-dump.json> <baseline.json> <pack-assets-dir> <out-dir>
"""

from __future__ import annotations

import json
import os
import sys

from epic_png import Rows, read_png, write_png

SCALE = 3
LINE_HEIGHT = 10
# The top row's glyphs have an ascent of 19 against a normal glyph's 8, so they reach 11px above
# their line; the margin has to clear that or the ornament looks cropped when it is not.
MARGIN = 22
TEXT_COLOUR = (255, 255, 255, 110)
BACKDROP = (26, 22, 34, 255)


def load_registry(baseline: dict) -> tuple[dict, dict, dict]:
    glyphs = {}
    for glyph in baseline["glyphs"]:
        glyphs[(glyph["font"], glyph["codePoint"])] = glyph
    bitmaps = {bitmap["id"]: bitmap for bitmap in baseline["bitmaps"]}
    spacing = baseline["spacing"]
    return glyphs, bitmaps, spacing


def spacing_advance(spacing: dict, font: str, code_point: int) -> int | None:
    if font != spacing["font"]:
        return None
    for key in ("negative", "positive"):
        rng = spacing[key]
        if rng["firstCodePoint"] <= code_point <= rng["lastCodePoint"]:
            return rng["minimumAdvancePixels"] + (
                code_point - rng["firstCodePoint"]
            )
    return None


def texture_path(pack: str, texture: str) -> str:
    # `itemerness:font/frame/common/top_left.png` -> <pack>/textures/font/frame/common/top_left.png
    _, path = texture.split(":", 1)
    return os.path.join(pack, "textures", *path.split("/"))


def blend(dst: Rows, src: Rows, x0: int, y0: int) -> None:
    for y, row in enumerate(src):
        ty = y0 + y
        if ty < 0 or ty >= len(dst):
            continue
        for x, (r, g, b, a) in enumerate(row):
            tx = x0 + x
            if a == 0 or tx < 0 or tx >= len(dst[0]):
                continue
            if a == 255:
                dst[ty][tx] = (r, g, b, 255)
            else:
                br, bg, bb, _ = dst[ty][tx]
                k = a / 255
                dst[ty][tx] = (
                    round(r * k + br * (1 - k)),
                    round(g * k + bg * (1 - k)),
                    round(b * k + bb * (1 - k)),
                    255,
                )


def fill_rect(dst: Rows, x0: int, y0: int, w: int, h: int, colour) -> None:
    blend(dst, [[colour] * w for _ in range(h)], x0, y0)


def draw_line(
    dst: Rows,
    line: dict,
    baseline_y: int,
    glyphs: dict,
    bitmaps: dict,
    spacing: dict,
    pack: str,
    cache: dict,
) -> None:
    cursor = MARGIN
    for run in line["runs"]:
        font = run["style"]["font"]
        if run["kind"] == "TEXT":
            # Vanilla's atlas is not loaded here, so text stands in as one block of its true width.
            width = run["widthPixels"]
            if width > 0:
                fill_rect(dst, cursor, baseline_y - 7, width, 7, TEXT_COLOUR)
            cursor += width
            continue
        for character in run["text"]:
            code_point = ord(character)
            advance = spacing_advance(spacing, font, code_point)
            if advance is not None:
                cursor += advance
                continue
            glyph = glyphs.get((font, code_point))
            if glyph is None:
                # Vanilla text: stand in with a block the width of one character.
                fill_rect(dst, cursor, baseline_y - 7, 5, 7, TEXT_COLOUR)
                cursor += 6
                continue
            bitmap = bitmaps.get(glyph["bitmap"]) if glyph["bitmap"] else None
            if bitmap is not None:
                path = texture_path(pack, bitmap["texture"])
                if path not in cache:
                    cache[path] = read_png(path)
                blend(dst, cache[path], cursor, baseline_y - bitmap["ascentPixels"])
            elif glyph["advancePixels"] > 0:
                fill_rect(
                    dst,
                    cursor,
                    baseline_y - 7,
                    max(1, int(glyph["advancePixels"]) - 1),
                    7,
                    TEXT_COLOUR,
                )
            cursor += int(glyph["advancePixels"])


def upscale(rows: Rows, factor: int) -> Rows:
    out: Rows = []
    for row in rows:
        wide = []
        for px in row:
            wide.extend([px] * factor)
        for _ in range(factor):
            out.append(list(wide))
    return out


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__)
        return 2
    dump = json.load(open(sys.argv[1], encoding="utf-8"))
    baseline = json.load(open(sys.argv[2], encoding="utf-8"))
    pack, out_dir = sys.argv[3], sys.argv[4]
    os.makedirs(out_dir, exist_ok=True)

    glyphs, bitmaps, spacing = load_registry(baseline)
    cache: dict[str, Rows] = {}

    for tier, preview in dump.items():
        lines = [preview["displayName"], *preview["lore"]]
        width = max(line["logicalWidthPixels"] for line in lines) + MARGIN * 2
        height = LINE_HEIGHT * len(lines) + MARGIN * 2 + 14
        canvas: Rows = [[BACKDROP] * width for _ in range(height)]

        for index, line in enumerate(lines):
            baseline_y = MARGIN + 8 + index * LINE_HEIGHT
            draw_line(
                canvas, line, baseline_y, glyphs, bitmaps, spacing, pack, cache
            )

        path = os.path.join(out_dir, f"{tier}.png")
        write_png(path, upscale(canvas, SCALE))
        widths = {line["logicalWidthPixels"] for line in preview["lore"]}
        print(
            f"{tier:11} {width}x{height} -> {path}"
            f"  lore-widths={sorted(widths)}"
            f"  renderer={preview['renderer']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

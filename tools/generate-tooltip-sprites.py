#!/usr/bin/env python3
"""Generate nine-slice tooltip sprites for Itemerness themes.

Emits `<style>_background.png` / `<style>_frame.png` plus their `.mcmeta`
descriptors into `assets/itemerness/textures/gui/sprites/tooltip/`.

Sprites are 16x16 with a nine-slice border of 4, matching vanilla's
`minecraft:tooltip/background` geometry so the client stretches them the same
way. Pillow is not available on the build host, so PNGs are encoded directly
with zlib + struct.

Usage:
    python generate-tooltip-sprites.py <output-dir>

`<output-dir>` is the directory that receives the PNG/.mcmeta pairs, e.g.
    G:/jar/Itemerness/resource-pack/assets/itemerness/textures/gui/sprites/tooltip
"""

from __future__ import annotations

import os
import struct
import sys
import zlib

SIZE = 16
BORDER = 4

MCMETA = (
    '{\n'
    '  "gui": {\n'
    '    "scaling": {\n'
    '      "type": "nine_slice",\n'
    '      "width": 16,\n'
    '      "height": 16,\n'
    '      "border": 4,\n'
    '      "stretch_inner": false\n'
    '    }\n'
    '  }\n'
    '}\n'
)

# style -> (bright border, dark border, panel fill)
# Colours track the `styles.item-name` accent of the matching theme file.
PALETTES = {
    "ember": ((0xFF, 0xCF, 0x7A), (0x8A, 0x5A, 0x22), (0x1A, 0x10, 0x08)),
    "quality-common": ((0xC8, 0xC8, 0xD0), (0x4A, 0x4A, 0x55), (0x10, 0x10, 0x14)),
    "quality-uncommon": ((0x55, 0xDD, 0x66), (0x1F, 0x5C, 0x28), (0x08, 0x16, 0x0A)),
    "quality-rare": ((0x55, 0xAA, 0xFF), (0x1D, 0x4A, 0x80), (0x08, 0x10, 0x1C)),
    "quality-epic": ((0xC0, 0x6C, 0xFF), (0x5A, 0x2A, 0x8A), (0x14, 0x0A, 0x1C)),
    "quality-legendary": ((0xFF, 0xAA, 0x33), (0x8A, 0x4F, 0x10), (0x1C, 0x10, 0x06)),
}

TRANSPARENT = (0, 0, 0, 0)

# Pixels clipped from each 4x4 corner block to round the panel off. Mirrored
# automatically onto the other three corners.
CORNER_CUT = {(0, 0), (0, 1), (1, 0)}

PANEL_ALPHA = 0xF0


def encode_png(width: int, height: int, rows: list[list[tuple[int, int, int, int]]]) -> bytes:
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0 (None)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def is_corner_cut(x: int, y: int) -> bool:
    """True when (x, y) falls in the rounded-off part of any corner block."""
    cx = x if x < BORDER else (SIZE - 1 - x if x >= SIZE - BORDER else None)
    cy = y if y < BORDER else (SIZE - 1 - y if y >= SIZE - BORDER else None)
    if cx is None or cy is None:
        return False
    return (cx, cy) in CORNER_CUT


def ring_depth(x: int, y: int) -> int:
    """Distance to the nearest edge, so 0 is the outermost ring."""
    return min(x, y, SIZE - 1 - x, SIZE - 1 - y)


def build_background(fill: tuple[int, int, int]) -> list[list[tuple[int, int, int, int]]]:
    r, g, b = fill
    rows = []
    for y in range(SIZE):
        row = []
        for x in range(SIZE):
            if is_corner_cut(x, y):
                row.append(TRANSPARENT)
            else:
                row.append((r, g, b, PANEL_ALPHA))
        rows.append(row)
    return rows


def build_frame(
    bright: tuple[int, int, int],
    dark: tuple[int, int, int],
) -> list[list[tuple[int, int, int, int]]]:
    br, bg, bb = bright
    dr, dg, db = dark
    rows = []
    for y in range(SIZE):
        row = []
        for x in range(SIZE):
            depth = ring_depth(x, y)
            if is_corner_cut(x, y):
                row.append(TRANSPARENT)
            elif depth == 0:
                # Outer hairline: darker, so the frame reads as engraved.
                row.append((dr, dg, db, 0xFF))
            elif depth == 1:
                # Inner hairline carries the accent colour.
                row.append((br, bg, bb, 0xFF))
            elif depth == 2 and (x < BORDER or x >= SIZE - BORDER) and (y < BORDER or y >= SIZE - BORDER):
                # Corner flourish: a bright pip tucked inside each corner block.
                row.append((br, bg, bb, 0xC0))
            else:
                row.append(TRANSPARENT)
        rows.append(row)
    return rows


def write(path: str, data: bytes) -> None:
    with open(path, "wb") as handle:
        handle.write(data)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)

    for style, (bright, dark, fill) in sorted(PALETTES.items()):
        for suffix, rows in (
            ("background", build_background(fill)),
            ("frame", build_frame(bright, dark)),
        ):
            png_path = os.path.join(out_dir, f"{style}_{suffix}.png")
            write(png_path, encode_png(SIZE, SIZE, rows))
            with open(png_path + ".mcmeta", "w", encoding="utf-8", newline="\n") as handle:
                handle.write(MCMETA)
            print(f"wrote {os.path.basename(png_path)} (+.mcmeta)")

    print(f"\n{len(PALETTES)} styles -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Generate the fully transparent `transparent-canvas` tooltip sprite.

Themes that draw their own panel -- the segmented Epic frames and the bitmap
canvas -- point `tooltip_style` at this sprite so vanilla paints no background
of its own. Without it vanilla's border sits four pixels outside the theme's
frame and reads as a second, unwanted border around it.

Pillow is not available on the build host, so the PNG is encoded with
zlib + struct, the same way `generate-tooltip-sprites.py` does it.

Usage:
    python generate-transparent-tooltip-sprite.py <sprite-dir>

e.g. python generate-transparent-tooltip-sprite.py \\
        G:/jar/Itemerness/resource-pack/assets/itemerness/textures/gui/sprites/tooltip
"""

from __future__ import annotations

import os
import sys

from epic_png import write_png

SIZE = 16

# `stretch` rather than `nine_slice`: there is nothing to preserve at the
# corners of an empty sprite, and stretching keeps it valid at any tooltip size.
MCMETA = (
    "{\n"
    '  "gui": {\n'
    '    "scaling": {\n'
    '      "type": "stretch"\n'
    "    }\n"
    "  }\n"
    "}\n"
)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    target = sys.argv[1]
    os.makedirs(target, exist_ok=True)

    rows = [[(0, 0, 0, 0)] * SIZE for _ in range(SIZE)]
    for part in ("background", "frame"):
        name = f"transparent-canvas_{part}.png"
        write_png(os.path.join(target, name), rows)
        with open(
            os.path.join(target, f"{name}.mcmeta"), "w", encoding="utf-8"
        ) as handle:
            handle.write(MCMETA)
        print(f"wrote {name} (+ .mcmeta)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

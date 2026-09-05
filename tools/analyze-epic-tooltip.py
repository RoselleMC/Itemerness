#!/usr/bin/env python3
"""Survey the Epic Tooltip source strips before slicing them.

Reports, per source image: its size, the extent of the drawn (non-transparent)
region, how many distinct column types the drawing has, and the widest run of
columns that repeat a single column type -- that run is the tileable band a
`SEGMENTED_FRAME` fill glyph is cut from.

Also fingerprints the sprites currently installed under the plugin's tooltip
sprite directory so the quality tier -> Epic tier mapping is read off pixels
rather than guessed from file-header comments.

Usage:
    python analyze-epic-tooltip.py <epic-source-dir> [installed-sprite-dir]
"""

from __future__ import annotations

import hashlib
import os
import sys

from epic_png import Rows, read_png


def columns(rows: Rows) -> list[tuple]:
    width = len(rows[0])
    return [tuple(rows[y][x] for y in range(len(rows))) for x in range(width)]


def drawn_extent(cols: list[tuple]) -> tuple[int, int]:
    """Returns the inclusive [first, last] column index that has any ink."""
    first = last = -1
    for x, col in enumerate(cols):
        if any(px[3] for px in col):
            if first < 0:
                first = x
            last = x
    return first, last


def widest_uniform_run(cols: list[tuple], lo: int, hi: int) -> tuple[int, int, tuple]:
    """Widest run in [lo, hi] where every column is identical."""
    best = (lo, lo - 1, cols[lo] if cols else ())
    start = lo
    for x in range(lo + 1, hi + 1):
        if cols[x] != cols[start]:
            if (x - 1) - start > best[1] - best[0]:
                best = (start, x - 1, cols[start])
            start = x
    if hi - start > best[1] - best[0]:
        best = (start, hi, cols[start])
    return best


def describe(path: str) -> None:
    name = os.path.basename(path)
    try:
        rows = read_png(path)
    except Exception as error:  # the pack ships a corrupt 1x1 `null.png`
        print(f"{name:32} unreadable: {error}")
        return
    cols = columns(rows)
    first, last = drawn_extent(cols)
    if first < 0:
        print(f"{name:32} {len(cols)}x{len(rows)}  (fully transparent)")
        return
    distinct = len({c for c in cols[first:last + 1]})
    run_lo, run_hi, _ = widest_uniform_run(cols, first, last)
    print(
        f"{name:32} {len(cols)}x{len(rows)}  ink x={first}..{last}"
        f"  distinct-cols={distinct}"
        f"  widest-uniform-run x={run_lo}..{run_hi} (w={run_hi - run_lo + 1})"
    )


def fingerprint(path: str) -> str | None:
    try:
        rows = read_png(path)
    except Exception:
        return None
    digest = hashlib.sha256()
    for row in rows:
        for px in row:
            digest.update(bytes(px))
    return f"{len(row)}x{len(rows)}:{digest.hexdigest()[:16]}"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    source = sys.argv[1]

    print("== Epic Tooltip source strips ==")
    for name in sorted(os.listdir(source)):
        if name.endswith(".png"):
            describe(os.path.join(source, name))

    if len(sys.argv) < 3:
        return 0

    print()
    print("== fingerprints: source ==")
    source_prints: dict[str, str] = {}
    for name in sorted(os.listdir(source)):
        if name.endswith(".png"):
            key = fingerprint(os.path.join(source, name))
            if key is None:
                continue
            source_prints[key] = name
            print(f"{name:32} {key}")

    installed = sys.argv[2]
    print()
    print("== fingerprints: installed sprites (match -> source) ==")
    for name in sorted(os.listdir(installed)):
        if not name.endswith(".png"):
            continue
        key = fingerprint(os.path.join(installed, name))
        if key is None:
            continue
        match = source_prints.get(key, "-- no exact match --")
        print(f"{name:38} {key}  {match}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

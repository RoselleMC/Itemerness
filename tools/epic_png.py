#!/usr/bin/env python3
"""Minimal PNG reader/writer for the Epic Tooltip slicing tools.

Pillow is not available on the build host (same constraint that shaped
`generate-tooltip-sprites.py`), so PNGs are decoded and encoded here with
zlib + struct only. Images are carried around as a list of rows of RGBA
tuples, which is what `generate-tooltip-sprites.py` already emits.
"""

from __future__ import annotations

import struct
import zlib

Pixel = tuple[int, int, int, int]
Rows = list[list[Pixel]]

_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def _unfilter(raw: bytes, width: int, height: int, bpp: int, stride: int) -> bytearray:
    out = bytearray(height * stride)
    pos = 0
    for y in range(height):
        filter_type = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        base = y * stride
        prior = out[base - stride:base] if y else bytes(stride)
        if filter_type == 0:
            pass
        elif filter_type == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                line[i] = (line[i] + prior[i]) & 0xFF
        elif filter_type == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prior[i]) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prior[i]
                c = prior[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        else:
            raise ValueError(f"unsupported PNG filter {filter_type}")
        out[base:base + stride] = line
    return out


def read_png(path: str) -> Rows:
    with open(path, "rb") as handle:
        data = handle.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")

    pos = 8
    idat = bytearray()
    palette: list[tuple[int, int, int]] = []
    trns: bytes = b""
    width = height = depth = color = 0
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if interlace:
                raise ValueError("interlaced PNGs are not supported")
        elif kind == b"PLTE":
            palette = [tuple(body[i:i + 3]) for i in range(0, len(body), 3)]
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break

    if color not in _CHANNELS:
        raise ValueError(f"unsupported PNG colour type {color}")
    channels = _CHANNELS[color]

    raw = zlib.decompress(bytes(idat))
    if depth == 8:
        stride = width * channels
        bpp = channels
    elif depth == 16:
        stride = width * channels * 2
        bpp = channels * 2
    elif depth in (1, 2, 4) and color in (0, 3):
        stride = (width * depth + 7) // 8
        bpp = 1
    else:
        raise ValueError(f"unsupported PNG bit depth {depth} for colour type {color}")

    flat = _unfilter(raw, width, height, bpp, stride)

    rows: Rows = []
    for y in range(height):
        base = y * stride
        row: list[Pixel] = []
        if depth in (1, 2, 4):
            mask = (1 << depth) - 1
            per_byte = 8 // depth
            for x in range(width):
                byte = flat[base + x // per_byte]
                shift = 8 - depth * (x % per_byte + 1)
                row.append(_expand(color, [(byte >> shift) & mask], palette, trns, depth))
        else:
            step = 2 if depth == 16 else 1
            for x in range(width):
                off = base + x * channels * step
                sample = [flat[off + i * step] for i in range(channels)]
                row.append(_expand(color, sample, palette, trns, 8))
        rows.append(row)
    return rows


def _expand(color: int, sample: list[int], palette, trns: bytes, depth: int) -> Pixel:
    if color == 0:
        v = sample[0] * 255 // ((1 << depth) - 1) if depth != 8 else sample[0]
        return (v, v, v, 255)
    if color == 2:
        return (sample[0], sample[1], sample[2], 255)
    if color == 3:
        index = sample[0]
        r, g, b = palette[index]
        a = trns[index] if index < len(trns) else 255
        return (r, g, b, a)
    if color == 4:
        return (sample[0], sample[0], sample[0], sample[1])
    return (sample[0], sample[1], sample[2], sample[3])


def encode_png(rows: Rows) -> bytes:
    height = len(rows)
    width = len(rows[0]) if height else 0
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0 (None)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + kind
            + body
            + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def write_png(path: str, rows: Rows) -> None:
    with open(path, "wb") as handle:
        handle.write(encode_png(rows))


def crop(rows: Rows, x0: int, x1: int) -> Rows:
    """Crops columns [x0, x1] inclusive."""
    return [row[x0:x1 + 1] for row in rows]

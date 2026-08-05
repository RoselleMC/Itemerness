#!/usr/bin/env python3
"""Generate the immutable Itemerness font-metrics artifact from Mojang inputs."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import zlib
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Iterable
from zipfile import ZipFile


MAGIC = b"ITMFONT\0"
ARTIFACT_SCHEMA = 1
HALF_PIXEL_SCALE = 2
FONT_TABLES = (
    ("minecraft:default", "builtin:minecraft-default-26.1.2", "minecraft:uniform"),
    ("minecraft:uniform", "builtin:minecraft-uniform-26.1.2", None),
)


@dataclass(frozen=True)
class Metric:
    advance: float
    bold: float
    has_ink: bool
    left: float = 0.0
    right: float = 0.0
    top: float = 0.0
    bottom: float = 0.0


@dataclass(frozen=True)
class PngImage:
    width: int
    height: int
    alpha_values: bytes

    def alpha(self, x: int, y: int) -> int:
        return self.alpha_values[y * self.width + x]


def sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


def require_sha1(label: str, data: bytes, expected: str) -> None:
    actual = sha1(data)
    if actual != expected:
        raise ValueError(f"{label} SHA-1 mismatch: expected {expected}, got {actual}")


def read_json(data: bytes, label: str) -> dict:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exception:
        raise ValueError(f"Invalid JSON in {label}") from exception
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object in {label}")
    return value


def unicode_scalars(value: str) -> list[int]:
    output: list[int] = []
    index = 0
    while index < len(value):
        code_point = ord(value[index])
        if 0xD800 <= code_point <= 0xDBFF:
            if index + 1 >= len(value):
                raise ValueError("Unpaired high surrogate in font character grid")
            low = ord(value[index + 1])
            if not 0xDC00 <= low <= 0xDFFF:
                raise ValueError("Unpaired high surrogate in font character grid")
            output.append(0x10000 + ((code_point - 0xD800) << 10) + (low - 0xDC00))
            index += 2
            continue
        if 0xDC00 <= code_point <= 0xDFFF:
            raise ValueError("Unpaired low surrogate in font character grid")
        output.append(code_point)
        index += 1
    return output


def paeth(a: int, b: int, c: int) -> int:
    prediction = a + b - c
    distance_a = abs(prediction - a)
    distance_b = abs(prediction - b)
    distance_c = abs(prediction - c)
    if distance_a <= distance_b and distance_a <= distance_c:
        return a
    if distance_b <= distance_c:
        return b
    return c


def decode_rgba_png(data: bytes, label: str) -> PngImage:
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError(f"Invalid PNG signature in {label}")
    position = 8
    width = height = depth = color_type = None
    compressed = bytearray()
    palette_alpha = b""
    saw_end = False
    while position < len(data):
        if position + 12 > len(data):
            raise ValueError(f"Truncated PNG chunk in {label}")
        length = struct.unpack_from(">I", data, position)[0]
        chunk_type = data[position + 4 : position + 8]
        chunk_start = position + 8
        chunk_end = chunk_start + length
        if chunk_end + 4 > len(data):
            raise ValueError(f"Truncated PNG payload in {label}")
        chunk = data[chunk_start:chunk_end]
        expected_crc = struct.unpack_from(">I", data, chunk_end)[0]
        actual_crc = zlib.crc32(chunk_type)
        actual_crc = zlib.crc32(chunk, actual_crc) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise ValueError(f"PNG CRC mismatch in {label}")
        if chunk_type == b"IHDR":
            if len(chunk) != 13:
                raise ValueError(f"Invalid PNG IHDR in {label}")
            width, height, depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            supported = (color_type == 6 and depth == 8) or (color_type == 3 and depth in (1, 2, 4, 8))
            if not supported or compression != 0 or filtering != 0 or interlace != 0:
                raise ValueError(f"Unsupported PNG encoding in {label}")
        elif chunk_type == b"tRNS":
            palette_alpha = chunk
        elif chunk_type == b"IDAT":
            compressed.extend(chunk)
        elif chunk_type == b"IEND":
            saw_end = True
            position = chunk_end + 4
            break
        position = chunk_end + 4
    if width is None or height is None or not saw_end or position != len(data):
        raise ValueError(f"Incomplete PNG in {label}")
    scanlines = zlib.decompress(bytes(compressed))
    bits_per_pixel = 32 if color_type == 6 else depth
    stride = (width * bits_per_pixel + 7) // 8
    if len(scanlines) != (stride + 1) * height:
        raise ValueError(f"Unexpected PNG scanline length in {label}")
    pixels = bytearray(stride * height)
    source = 0
    for y in range(height):
        filter_type = scanlines[source]
        source += 1
        if filter_type > 4:
            raise ValueError(f"Unsupported PNG filter in {label}")
        row_start = y * stride
        for x in range(stride):
            raw = scanlines[source]
            source += 1
            bytes_per_pixel = 4 if color_type == 6 else 1
            left = pixels[row_start + x - bytes_per_pixel] if x >= bytes_per_pixel else 0
            above = pixels[row_start + x - stride] if y > 0 else 0
            upper_left = (
                pixels[row_start + x - stride - bytes_per_pixel]
                if y > 0 and x >= bytes_per_pixel
                else 0
            )
            if filter_type == 0:
                value = raw
            elif filter_type == 1:
                value = raw + left
            elif filter_type == 2:
                value = raw + above
            elif filter_type == 3:
                value = raw + ((left + above) // 2)
            else:
                value = raw + paeth(left, above, upper_left)
            pixels[row_start + x] = value & 0xFF
    if color_type == 6:
        alpha_values = bytes(pixels[offset + 3] for offset in range(0, len(pixels), 4))
    else:
        mask = (1 << depth) - 1
        alphas = bytearray(width * height)
        for y in range(height):
            for x in range(width):
                bit_offset = x * depth
                byte_value = pixels[y * stride + bit_offset // 8]
                shift = 8 - depth - (bit_offset % 8)
                palette_index = (byte_value >> shift) & mask
                alphas[y * width + x] = palette_alpha[palette_index] if palette_index < len(palette_alpha) else 255
        alpha_values = bytes(alphas)
    return PngImage(width, height, alpha_values)


def ink_bounds(rows: Iterable[int], bit_width: int) -> tuple[int, int, int, int] | None:
    minimum_x = bit_width
    maximum_x = -1
    minimum_y = 16
    maximum_y = -1
    for y, row in enumerate(rows):
        if row == 0:
            continue
        minimum_y = min(minimum_y, y)
        maximum_y = max(maximum_y, y)
        minimum_x = min(minimum_x, bit_width - row.bit_length())
        maximum_x = max(maximum_x, bit_width - 1 - ((row & -row).bit_length() - 1))
    if maximum_x < 0:
        return None
    return minimum_x, maximum_x, minimum_y, maximum_y


def calculate_unihex_crop(rows: tuple[int, ...], bit_width: int) -> tuple[int, int]:
    bounds = ink_bounds(rows, bit_width)
    if bounds is None:
        return 0, bit_width
    return bounds[0], bounds[1]


def parse_unihex_archive(data: bytes, label: str) -> dict[int, tuple[tuple[int, ...], int]]:
    glyphs: dict[int, tuple[tuple[int, ...], int]] = {}
    with ZipFile(BytesIO(data)) as archive:
        hex_entries = sorted(name for name in archive.namelist() if name.endswith(".hex"))
        if not hex_entries:
            raise ValueError(f"No .hex file in {label}")
        for entry in hex_entries:
            for line_number, raw_line in enumerate(archive.read(entry).decode("ascii").splitlines(), start=1):
                if not raw_line or raw_line.startswith("#"):
                    continue
                try:
                    code_point_text, bitmap_text = raw_line.split(":", 1)
                    code_point = int(code_point_text, 16)
                except ValueError as exception:
                    raise ValueError(f"Invalid Unihex line {entry}:{line_number}") from exception
                if not 0 <= code_point <= 0x10FFFF or 0xD800 <= code_point <= 0xDFFF:
                    raise ValueError(f"Invalid Unihex code point at {entry}:{line_number}")
                if len(bitmap_text) not in (32, 64, 96, 128):
                    raise ValueError(f"Invalid Unihex bitmap width at {entry}:{line_number}")
                bit_width = len(bitmap_text) // 4
                row_digits = bit_width // 4
                try:
                    rows = tuple(
                        int(bitmap_text[offset : offset + row_digits], 16)
                        for offset in range(0, len(bitmap_text), row_digits)
                    )
                except ValueError as exception:
                    raise ValueError(f"Invalid Unihex bitmap at {entry}:{line_number}") from exception
                if len(rows) != 16 or code_point in glyphs:
                    raise ValueError(f"Duplicate or malformed Unihex glyph at {entry}:{line_number}")
                glyphs[code_point] = (rows, bit_width)
    return glyphs


def metric_from_unihex(
    rows: tuple[int, ...], bit_width: int, crop: tuple[int, int]
) -> Metric:
    left, right = crop
    if not 0 <= left <= right <= 31:
        raise ValueError(f"Invalid Unihex crop {crop} for {bit_width}-pixel glyph")
    width = right - left + 1
    advance = float(width // 2 + 1)
    visible_pixels = [
        (x, y)
        for y, row in enumerate(rows)
        for x in range(max(0, left), min(bit_width - 1, right) + 1)
        if row & (1 << (bit_width - 1 - x))
    ]
    if not visible_pixels:
        return Metric(advance=advance, bold=0.5, has_ink=False)
    xs = [pixel[0] for pixel in visible_pixels]
    ys = [pixel[1] for pixel in visible_pixels]
    return Metric(
        advance=advance,
        bold=0.5,
        has_ink=True,
        left=(min(xs) - left) / 2.0,
        right=(max(xs) - left + 1) / 2.0,
        top=-7.0 + min(ys) / 2.0,
        bottom=-7.0 + (max(ys) + 1) / 2.0,
    )


def load_non_jp_unifont(definition: dict, asset: callable) -> dict[int, Metric]:
    output: dict[int, Metric] = {}
    providers = definition.get("providers")
    if not isinstance(providers, list):
        raise ValueError("Unifont definition has no providers array")
    for provider in providers:
        if not isinstance(provider, dict) or provider.get("type") != "unihex":
            raise ValueError("Unsupported provider in vanilla unifont definition")
        filter_node = provider.get("filter", {})
        if filter_node and filter_node != {"jp": True}:
            raise ValueError("Unsupported vanilla unifont provider filter")
        if filter_node.get("jp") is True:
            continue
        resource = provider.get("hex_file")
        if not isinstance(resource, str):
            raise ValueError("Unifont provider has no hex_file")
        glyphs = parse_unihex_archive(asset(resource), resource)
        overrides: list[tuple[int, int, tuple[int, int]]] = []
        for override in provider.get("size_overrides", []):
            if not isinstance(override, dict):
                raise ValueError("Invalid Unihex size override")
            first = unicode_scalars(override["from"])
            last = unicode_scalars(override["to"])
            if len(first) != 1 or len(last) != 1:
                raise ValueError("Unihex size override bounds must be single scalars")
            overrides.append((first[0], last[0], (int(override["left"]), int(override["right"]))))
        for code_point, (rows, bit_width) in glyphs.items():
            crop = calculate_unihex_crop(rows, bit_width)
            for first, last, dimensions in overrides:
                if first <= code_point <= last:
                    crop = dimensions
                    break
            output[code_point] = metric_from_unihex(rows, bit_width, crop)
    return output


def bitmap_provider_metrics(provider: dict, texture: callable) -> dict[int, Metric]:
    resource = provider.get("file")
    rows = provider.get("chars")
    if not isinstance(resource, str) or not isinstance(rows, list) or not rows:
        raise ValueError("Invalid vanilla bitmap provider")
    codepoint_rows = [unicode_scalars(row) for row in rows]
    columns = len(codepoint_rows[0])
    if columns == 0 or any(len(row) != columns for row in codepoint_rows):
        raise ValueError(f"Non-rectangular character grid in {resource}")
    image = decode_rgba_png(texture(resource), resource)
    if image.width % columns or image.height % len(rows):
        raise ValueError(f"Texture dimensions do not match character grid in {resource}")
    cell_width = image.width // columns
    cell_height = image.height // len(rows)
    configured_height = int(provider.get("height", 8))
    ascent = int(provider["ascent"])
    scale = configured_height / cell_height
    output: dict[int, Metric] = {}
    for row_index, codepoints in enumerate(codepoint_rows):
        for column_index, code_point in enumerate(codepoints):
            if code_point == 0:
                continue
            xs: list[int] = []
            ys: list[int] = []
            origin_x = column_index * cell_width
            origin_y = row_index * cell_height
            for y in range(cell_height):
                for x in range(cell_width):
                    if image.alpha(origin_x + x, origin_y + y) != 0:
                        xs.append(x)
                        ys.append(y)
            actual_width = max(xs) + 1 if xs else 0
            advance = float(int(0.5 + actual_width * scale) + 1)
            if not xs:
                output[code_point] = Metric(advance=advance, bold=1.0, has_ink=False)
                continue
            output[code_point] = Metric(
                advance=advance,
                bold=1.0,
                has_ink=True,
                left=min(xs) * scale,
                right=(max(xs) + 1) * scale,
                top=-float(ascent) + min(ys) * scale,
                bottom=-float(ascent) + (max(ys) + 1) * scale,
            )
    return output


def load_space_metrics(definition: dict) -> dict[int, Metric]:
    output: dict[int, Metric] = {}
    for provider in definition.get("providers", []):
        if not isinstance(provider, dict) or provider.get("type") != "space":
            raise ValueError("Unsupported provider in vanilla space definition")
        advances = provider.get("advances")
        if not isinstance(advances, dict):
            raise ValueError("Space provider has no advances map")
        for character, advance in advances.items():
            codepoints = unicode_scalars(character)
            if len(codepoints) != 1:
                raise ValueError("Space provider keys must be one Unicode scalar")
            output.setdefault(
                codepoints[0],
                Metric(advance=float(advance), bold=1.0, has_ink=False),
            )
    return output


def put_first(target: dict[int, Metric], source: dict[int, Metric]) -> None:
    for code_point, metric in source.items():
        target.setdefault(code_point, metric)


def validate_font_roots(default: dict, uniform: dict) -> None:
    expected_default = [
        {"type": "reference", "id": "minecraft:include/space"},
        {
            "type": "reference",
            "id": "minecraft:include/default",
            "filter": {"uniform": False},
        },
        {"type": "reference", "id": "minecraft:include/unifont"},
    ]
    expected_uniform = [
        {"type": "reference", "id": "minecraft:include/space"},
        {"type": "reference", "id": "minecraft:include/unifont"},
    ]
    if default.get("providers") != expected_default:
        raise ValueError("Vanilla default font provider order does not match the 26.1.2 profile")
    if uniform.get("providers") != expected_uniform:
        raise ValueError("Vanilla uniform font provider order does not match the 26.1.2 profile")


def encode_string(value: str) -> bytes:
    data = value.encode("utf-8")
    if not 1 <= len(data) <= 255:
        raise ValueError(f"Artifact string length is outside 1..255: {value!r}")
    return bytes((len(data),)) + data


def encode_optional_string(value: str | None) -> bytes:
    if value is None:
        return b"\x00"
    return encode_string(value)


def half_pixel(value: float, label: str, signed: bool) -> int:
    scaled = value * HALF_PIXEL_SCALE
    rounded = round(scaled)
    if not math.isclose(scaled, rounded, rel_tol=0.0, abs_tol=1e-9):
        raise ValueError(f"{label} is not representable in half pixels: {value}")
    minimum, maximum = (-128, 127) if signed else (0, 255)
    if not minimum <= rounded <= maximum:
        raise ValueError(f"{label} is outside artifact range: {value}")
    return int(rounded)


def encode_metric(metric: Metric) -> bytes:
    if metric.has_ink:
        if metric.right < metric.left or metric.bottom < metric.top:
            raise ValueError(f"Invalid ink bounds: {metric}")
    elif any((metric.left, metric.right, metric.top, metric.bottom)):
        raise ValueError(f"Inkless metric has non-empty bounds: {metric}")
    return struct.pack(
        ">BBbbbbB",
        half_pixel(metric.advance, "advance", signed=False),
        half_pixel(metric.bold, "bold offset", signed=False),
        half_pixel(metric.left, "left bound", signed=True),
        half_pixel(metric.right, "right bound", signed=True),
        half_pixel(metric.top, "top bound", signed=True),
        half_pixel(metric.bottom, "bottom bound", signed=True),
        1 if metric.has_ink else 0,
    )


def encode_varuint(value: int) -> bytes:
    if value <= 0:
        raise ValueError(f"Artifact code-point delta must be positive: {value}")
    output = bytearray()
    while value:
        byte = value & 0x7F
        value >>= 7
        output.append(byte | (0x80 if value else 0))
    return bytes(output)


def encode_payload(tables: dict[str, dict[int, Metric]]) -> bytes:
    output = bytearray((len(FONT_TABLES),))
    missing = Metric(advance=6.0, bold=1.0, has_ink=True, left=0.0, right=5.0, top=-7.0, bottom=1.0)
    for font_id, revision, fallback in FONT_TABLES:
        glyphs = tables[font_id]
        output.extend(encode_string(font_id))
        output.extend(encode_string(revision))
        output.extend(encode_optional_string(fallback))
        output.extend(encode_metric(missing))
        output.extend(struct.pack(">I", len(glyphs)))
        previous = -1
        for code_point in sorted(glyphs):
            output.extend(encode_varuint(code_point - previous))
            output.extend(encode_metric(glyphs[code_point]))
            previous = code_point
    return bytes(output)


def canonical_source_sha1(resources: dict[str, bytes]) -> str:
    digest = hashlib.sha1()
    for name in sorted(resources):
        name_bytes = name.encode("utf-8")
        digest.update(struct.pack(">H", len(name_bytes)))
        digest.update(name_bytes)
        digest.update(bytes.fromhex(sha1(resources[name])))
    return digest.hexdigest()


def generate(arguments: argparse.Namespace) -> tuple[bytes, str, dict[str, int]]:
    manifest_bytes = arguments.manifest.read_bytes()
    manifest = read_json(manifest_bytes, str(arguments.manifest))
    if manifest.get("schemaVersion") != 1 or manifest.get("clientVersion") != "26.1.2":
        raise ValueError("Unsupported font source manifest")
    if manifest.get("fontOptions") != {"jp": False, "uniform": False}:
        raise ValueError("The source manifest must select the non-JP, non-uniform default profile")
    client_bytes = arguments.client_jar.read_bytes()
    index_bytes = arguments.asset_index.read_bytes()
    require_sha1("client JAR", client_bytes, manifest["client"]["sha1"])
    require_sha1("asset index", index_bytes, manifest["assetIndex"]["sha1"])
    asset_index = read_json(index_bytes, str(arguments.asset_index)).get("objects")
    if not isinstance(asset_index, dict):
        raise ValueError("Asset index has no objects map")

    sources: dict[str, bytes] = {}
    with ZipFile(BytesIO(client_bytes)) as client:
        for name, expected in manifest["clientResources"].items():
            try:
                data = client.read(name)
            except KeyError as exception:
                raise ValueError(f"Client JAR is missing {name}") from exception
            require_sha1(name, data, expected)
            sources[name] = data
    for name, expected in manifest["assetResources"].items():
        indexed = asset_index.get(name)
        if not isinstance(indexed, dict) or indexed.get("hash") != expected:
            raise ValueError(f"Asset index does not map {name} to {expected}")
        object_path = arguments.asset_objects / expected[:2] / expected
        if not object_path.is_file():
            raise ValueError(f"Missing Mojang asset object {object_path}")
        data = object_path.read_bytes()
        require_sha1(name, data, expected)
        sources[name] = data

    def client_resource(identifier: str) -> bytes:
        namespace, path = identifier.split(":", 1)
        name = f"assets/{namespace}/textures/{path}"
        try:
            return sources[name]
        except KeyError as exception:
            raise ValueError(f"Untracked client texture {name}") from exception

    def asset_resource(identifier: str) -> bytes:
        namespace, path = identifier.split(":", 1)
        name = f"{namespace}/{path}"
        try:
            return sources[name]
        except KeyError as exception:
            raise ValueError(f"Untracked asset resource {name}") from exception

    validate_font_roots(
        read_json(sources["assets/minecraft/font/default.json"], "minecraft:default"),
        read_json(sources["assets/minecraft/font/uniform.json"], "minecraft:uniform"),
    )
    space = load_space_metrics(read_json(sources["assets/minecraft/font/include/space.json"], "space.json"))
    classic: dict[int, Metric] = {}
    default_include = read_json(sources["assets/minecraft/font/include/default.json"], "default.json")
    for provider in default_include.get("providers", []):
        if not isinstance(provider, dict) or provider.get("type") != "bitmap":
            raise ValueError("Unsupported provider in vanilla default include")
        put_first(classic, bitmap_provider_metrics(provider, client_resource))
    unifont = load_non_jp_unifont(
        read_json(sources["minecraft/font/include/unifont.json"], "unifont.json"),
        asset_resource,
    )
    default_table: dict[int, Metric] = {}
    put_first(default_table, space)
    put_first(default_table, classic)
    uniform_table: dict[int, Metric] = {}
    put_first(uniform_table, space)
    put_first(uniform_table, unifont)
    tables = {
        "minecraft:default": default_table,
        "minecraft:uniform": uniform_table,
    }
    payload = encode_payload(tables)
    source_digest = canonical_source_sha1(sources)
    header = bytearray(MAGIC)
    header.extend(struct.pack(">H", ARTIFACT_SCHEMA))
    header.extend(encode_string(manifest["clientVersion"]))
    header.extend(bytes.fromhex(manifest["client"]["sha1"]))
    header.extend(bytes.fromhex(manifest["assetIndex"]["sha1"]))
    header.extend(bytes.fromhex(source_digest))
    header.extend(struct.pack(">I", len(payload)))
    header.extend(hashlib.sha256(payload).digest())
    return bytes(header) + payload, source_digest, {key: len(value) for key, value in tables.items()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    default_manifest = Path(__file__).with_name("26.1.2.sources.json")
    parser.add_argument("--manifest", type=Path, default=default_manifest)
    parser.add_argument("--client-jar", type=Path, required=True)
    parser.add_argument("--asset-index", type=Path, required=True)
    parser.add_argument("--asset-objects", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        artifact, source_digest, counts = generate(arguments)
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_bytes(artifact)
    except (OSError, ValueError) as exception:
        print(f"font metric generation failed: {exception}", file=sys.stderr)
        return 1
    print(f"wrote {arguments.output} ({len(artifact)} bytes)")
    print(f"source SHA-1: {source_digest}")
    for font_id, count in counts.items():
        print(f"{font_id}: {count} glyphs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

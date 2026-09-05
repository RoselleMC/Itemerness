#!/usr/bin/env python3
"""Add the quality-* tooltip themes to the editor's authoring document.

The plugin reads `plugins/Itemerness/themes/*.yml`; the editor keeps its own authoring document.
They do not sync, so a theme added to the server has to be added here too before it shows up in the
editor's theme picker.

Also repoints `resourcePackBindings` at the real pack — the shipped document carries an all-zero
placeholder with `enabled: false`, which leaves `itemerness:native-tooltip-style-v1` unsatisfied and
makes every NATIVE_TOOLTIP_STYLE theme fall back in preview.

Usage:
    python add-quality-themes.py <control-plane-base-url> <pack-id> <pack-sha1>
"""

from __future__ import annotations

import json
import sys
import urllib.request
import uuid

# Mirrors themes/quality-*.yml on the server so preview and runtime agree.
PALETTES = {
    "common": ("#d8d8e0", "#7a7a85", "#e8e8f0", "#9a9aa5"),
    "uncommon": ("#6ee87d", "#5a8f62", "#d8f5dc", "#8fbf97"),
    "rare": ("#6cb8ff", "#5a7d9f", "#d8ecff", "#8fadc9"),
    "epic": ("#c88cff", "#8a6a9f", "#eddcff", "#b09ac4"),
    "legendary": ("#ffbb55", "#b3854a", "#ffe9c9", "#d9b98c"),
}
MET = "#8bd17c"
UNMET = "#ff6961"


def style(color: str) -> dict:
    return {
        "color": color,
        "bold": False,
        "italic": False,
        "underlined": False,
        "strikethrough": False,
    }


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def put_json(url: str, payload: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    base, pack_id, pack_sha1 = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]

    snapshot = get_json(f"{base}/api/v1/document")
    document = snapshot["document"]
    expected_hash = snapshot["snapshotHash"]

    existing_themes = {t["id"] for t in document["themes"]}
    existing_styles = {s["id"] for s in document["tooltipStyles"]}
    added_themes, added_styles = [], []

    for tier, (name_c, label_c, value_c, desc_c) in PALETTES.items():
        key = f"itemerness:quality-{tier}"

        if key not in existing_styles:
            document["tooltipStyles"].append(
                {
                    "uuid": str(uuid.uuid4()),
                    "id": key,
                    "expectedBackgroundSprite": f"itemerness:tooltip/quality-{tier}_background",
                    "expectedFrameSprite": f"itemerness:tooltip/quality-{tier}_frame",
                    "scaling": "nine-slice",
                }
            )
            added_styles.append(key)

        if key not in existing_themes:
            document["themes"].append(
                {
                    "uuid": str(uuid.uuid4()),
                    "id": key,
                    "renderer": "NATIVE_TOOLTIP_STYLE",
                    "requiresResourcePack": True,
                    "requiredCapabilities": ["itemerness:native-tooltip-style-v1"],
                    "vanillaTooltipLines": "PRESERVE",
                    "fallback": "itemerness:vanilla-frame",
                    "fonts": {"text": "itemerness:body", "icons": "itemerness:icons"},
                    "styles": {
                        "item-name": style(name_c),
                        "label": style(label_c),
                        "value": style(value_c),
                        "requirement-met": style(MET),
                        "requirement-unmet": style(UNMET),
                        "description": style(desc_c),
                    },
                    "tooltipStyle": key,
                    "requireExactFontMetrics": False,
                    "content": {
                        "minimumWidthPixels": 140,
                        "maximumWidthPixels": 220,
                        "leftPaddingPixels": 8,
                        "rightPaddingPixels": 8,
                    },
                    "characterFrame": None,
                    "segmentedFrame": None,
                    "canvas": None,
                }
            )
            added_themes.append(key)

    rebound = []
    for binding in document["resourcePackBindings"]:
        if binding["assetProfile"] == "itemerness:example-pack-v1":
            binding["enabled"] = True
            binding["packId"] = pack_id
            binding["sha1"] = pack_sha1
            rebound.append(binding["id"])

    result = put_json(
        f"{base}/api/v1/document",
        {"document": document, "expectedHash": expected_hash},
    )

    print(f"added tooltipStyles : {added_styles or '(none, already present)'}")
    print(f"added themes        : {added_themes or '(none, already present)'}")
    print(f"rebound pack        : {rebound} -> {pack_id} / {pack_sha1}")
    print(f"revision            : {snapshot['revision']} -> {result.get('revision')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

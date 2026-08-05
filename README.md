# Itemerness

Itemerness is a viewer-aware item platform for the modern Bukkit ecosystem. The server keeps a small canonical item containing direct `minecraft:custom_data.itemerness` NBT, while an exact-version NMS adapter renders the display name, lore, locale, theme, and tooltip sent to each player.

The project targets Paper, Folia, and Canvas as first-class runtimes. It does not identify items from lore, does not use PacketEvents, and does not write authoritative data to PDC.

## Status

The plugin implementation for stages 0–3 is available for Minecraft `26.1.2` and Java `25`:

- atomic catalog loading, validation, publication, and rollback;
- canonical item creation, identification, typed data reads, and atomic edits;
- caller-bound Bukkit API with per-action and per-data-key grants;
- Paper lifecycle Brigadier commands and an internal PlaceholderAPI expansion;
- locale-aware rendering, formatters, conditions, repeats, nested items, pixel wrapping, and theme fallback;
- plain, resource-pack-free character frame, native tooltip style, segmented frame, and experimental bitmap-canvas renderers;
- exact `26.1.2` direct-NMS projection across the scanned packet, component, structured payload, NBT, and nested-item surfaces;
- bounded HashedStack, creative-mode, custom-action, refresh, and connection lifecycle state.

Bitmap output remains experimental. Automated tests and server smoke tests do not replace real-client verification of final pixels, GUI-scale behavior, or the complete manual inventory interaction matrix.

The final Craft Runner smoke matrix passed on Java 25.0.3 with Paper 26.1.2 build 74, Folia 26.1.2 build 8, and Canvas 26.1.2 build 876. All three loaded the exact NMS adapter in `STARTED` state, passed the independent API consumer, validated and published the catalog, and exposed the updated catalog revision through PlaceholderAPI. The Java 25 verification suite currently contains 469 passing tests, including 150 exact-NMS tests.

The web editor is not implemented. `editor.url` and `editor.token` are strict empty reservations for a separately planned project; setting either value currently rejects the configuration.

## Baseline

- Minecraft `26.1.2` only
- Java `25`
- Kotlin `2.4.0`
- Gradle Kotlin DSL
- `plugin.yml` with `folia-supported: true`

An unsupported Minecraft version fails during startup. New Minecraft ABIs require new adapter modules and their own carrier audit; adjacent versions are never guessed through a shared reflection layer.

## Modules

```text
itemerness-core -> itemerness-api
itemerness-projection-spi -> itemerness-api
itemerness-bukkit-spi -> itemerness-api, itemerness-projection-spi
itemerness-nms-26_1_2 -> itemerness-projection-spi, itemerness-bukkit-spi
itemerness-bukkit -> all runtime modules
```

- `itemerness-api` contains platform-neutral IDs, typed values, results, and bound domain contracts.
- `itemerness-core` contains catalog and presentation models that do not depend on Bukkit or NMS.
- `itemerness-projection-spi` contains immutable projection snapshots and adapter lifecycle contracts.
- `itemerness-bukkit-spi` isolates canonical Bukkit `ItemStack` access from the distribution module.
- `itemerness-nms-26_1_2` contains the exact-version ABI probe, packet projection, inbound restoration, and connection state.
- `itemerness-bukkit` contains catalog loading, Bukkit services, Brigadier, PlaceholderAPI, Folia-safe scheduling, resources, and the deployable JAR.

The NMS module is shaded into the Bukkit distribution. NMS, CraftBukkit, packet, channel, and mutable server types do not enter the public platform-neutral contracts.

## Build

Use a Java 25 runtime:

```bash
./gradlew check build
```

The deployable artifact is:

```text
itemerness-bukkit/build/libs/Itemerness.jar
```

The build verifies Kotlin/JVM tests, the shaded service boundaries, plugin metadata, bundled YAML/SNBT resources, Folia scheduling rules, compilation against the pinned Paper/Folia/Canvas APIs, the exact NMS ABI manifest, and scanned packet/component carrier coverage.

`tools/runtime-probe` is an independent disposable consumer used by the Craft Runner smoke matrix. It is not part of the plugin dependency graph or the shipped JAR.

## Configuration

`config.yml` contains only global catalog, pending-name, locale, presentation, and reserved editor settings. Content is separated by responsibility under:

```text
data-keys/  viewer-facts/  formats/  items/
layouts/    themes/        assets/   locales/
```

The five bundled item definitions are complete examples but are disabled by default. Enable or copy only the definitions you intend to use, then validate before publication:

```text
/itemerness reload check
/itemerness validate text
/itemerness reload
```

PDC may be declared per data key as a typed, read-only, lower-priority fallback. Canonical NBT and definition data always win, PDC never establishes managed identity, and Itemerness never writes authoritative values back to PDC.

The Chinese user guide, command reference, PlaceholderAPI routes, API examples, theme guidance, and compatibility notes are maintained in the [GitHub Wiki](https://github.com/RoselleMC/Itemerness/wiki).

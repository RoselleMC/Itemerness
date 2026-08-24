# Itemerness

Itemerness is a viewer-aware item platform for the modern Bukkit ecosystem. The server keeps a small canonical item containing direct `minecraft:custom_data.itemerness` NBT, while an exact-version NMS adapter renders the display name, lore, locale, theme, and tooltip sent to each player.

The project targets Paper, Folia, and Canvas as first-class runtimes. It does not identify items from lore, does not use PacketEvents, and does not write authoritative data to PDC.

## Status

The plugin implementation for stages 0-3 is available for Minecraft `26.1.2` and Java `25`:

- atomic catalog loading, validation, publication, and rollback;
- canonical item creation, identification, typed data reads, and atomic edits;
- caller-bound Bukkit API with per-action and per-data-key grants;
- Paper lifecycle Brigadier commands and an internal PlaceholderAPI expansion;
- locale-aware rendering, formatters, conditions, repeats, nested items, pixel wrapping, and theme fallback;
- plain, resource-pack-free character frame, native tooltip style, segmented frame, and experimental bitmap-canvas renderers;
- exact `26.1.2` direct-NMS projection across the scanned packet, component, structured payload, NBT, and nested-item surfaces;
- bounded HashedStack, creative-mode, custom-action, refresh, and connection lifecycle state.
- an optional outbound editor agent that compiles exact document snapshots for server-verified previews.

Bitmap output remains experimental. Automated tests and server smoke tests do not replace real-client verification of final pixels, GUI-scale behavior, or the complete manual inventory interaction matrix.

The Craft Runner smoke matrix covers Paper, Folia, and Canvas on Java 25. It verifies the exact NMS adapter, an independent API consumer, catalog publication, commands, and PlaceholderAPI. Local verification covers the JVM modules and the editor's protocol, renderer, browser workflow, and production bundles.

An initial self-hosted web editor is available under `editor/`. It loads and autosaves the authoring document, renders live local previews, mounts resource-pack assets in the browser, and can ask a paired server to compile the exact draft with the production Kotlin compiler. It does not yet provide authentication, persistence, publication, rollback, or multi-server rollout; the default deployment is therefore loopback-only.

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
itemerness-editor-protocol -> itemerness-core
itemerness-editor-agent -> itemerness-editor-protocol, itemerness-core
itemerness-bukkit -> all runtime modules
```

- `itemerness-api` contains platform-neutral IDs, typed values, results, and bound domain contracts.
- `itemerness-core` contains catalog and presentation models that do not depend on Bukkit or NMS.
- `itemerness-projection-spi` contains immutable projection snapshots and adapter lifecycle contracts.
- `itemerness-bukkit-spi` isolates canonical Bukkit `ItemStack` access from the distribution module.
- `itemerness-nms-26_1_2` contains the exact-version ABI probe, packet projection, inbound restoration, and connection state.
- `itemerness-editor-protocol` contains the managed-document codec and the JVM wire contract without Bukkit or NMS types.
- `itemerness-editor-agent` contains the outbound WebSocket state machine and the production preview compiler bridge.
- `itemerness-bukkit` contains catalog loading, Bukkit services, Brigadier, PlaceholderAPI, Folia-safe scheduling, the editor lifecycle bridge, resources, and the deployable JAR.

The TypeScript workspace under `editor/` contains the browser application, control plane, shared schemas, Minecraft asset readers, renderer, and deployment files. See [editor/README.md](editor/README.md) for its fidelity model and current operational limits.

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

`config.yml` contains global catalog, pending-name, locale, presentation, and optional editor pairing settings. Leave both `editor.url` and `editor.token` empty for a fully local installation. Set both to enable server-verified previews; pairing changes require a server restart. Content is separated by responsibility under:

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

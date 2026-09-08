# Itemerness

Itemerness is a viewer-aware item platform for the modern Bukkit ecosystem. The server keeps a small canonical item containing direct `minecraft:custom_data.itemerness` NBT, while an exact-version NMS adapter renders the display name, lore, locale, theme, and tooltip sent to each player.

The project targets Paper, Folia, and Canvas as first-class runtimes. It does not identify items from lore, does not use PacketEvents, and does not write authoritative data to PDC.

## Status

The plugin implementation for stages 0-3 covers the currently supported Minecraft version and Bukkit-platform combinations from `1.21.11` through `26.2`:

- atomic catalog loading, validation, publication, and rollback;
- canonical item creation, identification, typed data reads, and atomic edits;
- caller-bound Bukkit API with per-action and per-data-key grants;
- Paper lifecycle Brigadier commands and an internal PlaceholderAPI expansion;
- locale-aware rendering, formatters, conditions, repeats, nested items, pixel wrapping, and theme fallback;
- plain, resource-pack-free character frame, native tooltip style, segmented frame, and experimental bitmap-canvas renderers;
- exact direct-NMS projection for `1.21.11`, `26.1.1`, `26.1.2`, and `26.2` across the scanned packet, component, structured payload, NBT, and nested-item surfaces;
- bounded HashedStack, creative-mode, custom-action, refresh, and connection lifecycle state;
- an optional plugin API with configurable token authentication for persistent authoring drafts and server-verified previews.

Bitmap output remains experimental. Automated tests and server smoke tests do not replace real-client verification of final pixels, GUI-scale behavior, or the complete manual inventory interaction matrix.

The Craft Runner smoke matrix covers every currently available Paper, Folia, and Canvas combination in the supported range. Minecraft `1.21.11` runs on Java 21; `26.x` runs on Java 25. The matrix verifies the exact NMS adapter, an independent API consumer, catalog publication, commands, and PlaceholderAPI. Local verification covers the JVM modules and the editor's protocol, renderer, browser workflow, and production bundles.

A Tauri desktop editor for macOS and Windows is available under `editor/`. It connects directly to a plugin API address supplied by the user, negotiates protocol compatibility, autosaves authoring drafts, and requests production Kotlin previews. No separate editor backend is deployed. Its preview asset pipeline is pinned to `26.1.2`; other supported server versions expose draft capabilities without claiming exact previews. Publication, rollback, per-user permissions, and multi-server rollout are not implemented. Draft saves never activate the runtime catalog.

The editor starts empty and disabled until the connected plugin returns an authoring document.
It does not preload examples, restore cached drafts automatically, or seed an empty server. The
current API does not automatically convert local YAML into an authoring document.

## Baseline

- Supported releases: Minecraft `1.21.11`, `26.1.1`, `26.1.2`, and `26.2`; the support floor is `1.21.11`
- Java `21` for Minecraft `1.21.11`; Java `25` for Minecraft `26.x`
- Java `21` plugin bytecode, built with JDK `25`
- Kotlin `2.4.0`
- Gradle Kotlin DSL
- `plugin.yml` with `folia-supported: true`

An unsupported Minecraft version fails during startup. New Minecraft ABIs require new adapter modules and their own carrier audit; adjacent versions are never guessed through a shared reflection layer.

| Minecraft | Paper | Folia | Canvas | Runtime Java |
| --- | --- | --- | --- | --- |
| `1.21.11` | build 132 | build 14 | build 794 | 21 |
| `26.1` | unavailable upstream | unavailable upstream | unavailable upstream | 25 |
| `26.1.1` | build 29 alpha | unavailable upstream | unavailable upstream | 25 |
| `26.1.2` | build 74 | build 8 | build 876 | 25 |
| `26.2` | build 116 | build 6 beta | build 936 | 25 |

## Modules

```text
itemerness-core -> itemerness-api
itemerness-bukkit-api -> itemerness-api
itemerness-projection-spi -> itemerness-api
itemerness-bukkit-spi -> itemerness-api, itemerness-projection-spi
itemerness-nms-1_21_11 -> itemerness-projection-spi, itemerness-bukkit-spi
itemerness-nms-26_1_1 -> itemerness-projection-spi, itemerness-bukkit-spi
itemerness-nms-26_1_2 -> itemerness-projection-spi, itemerness-bukkit-spi
itemerness-nms-26_2 -> itemerness-projection-spi, itemerness-bukkit-spi
itemerness-editor-protocol -> itemerness-core
itemerness-editor-agent -> itemerness-editor-protocol, itemerness-core
itemerness-bukkit -> all runtime modules
```

- `itemerness-api` contains platform-neutral IDs, typed values, results, and bound domain contracts.
- `itemerness-bukkit-api` contains the public Bukkit service, item/slot contracts, and catalog publication event without platform implementation or NMS dependencies.
- `itemerness-core` contains catalog and presentation models that do not depend on Bukkit or NMS.
- `itemerness-projection-spi` contains immutable projection snapshots and adapter lifecycle contracts.
- `itemerness-bukkit-spi` isolates canonical Bukkit `ItemStack` access from the distribution module.
- `itemerness-nms-*` modules contain one exact-version ABI probe, packet projection, inbound restoration, and connection state implementation per supported Minecraft version.
- `itemerness-editor-protocol` contains the managed-document codec and the JVM wire contract without Bukkit or NMS types.
- `itemerness-editor-agent` retains its existing module name but now contains the inbound HTTP API, atomic authoring draft store, and production preview compiler bridge. The outbound WebSocket client has been removed.
- `itemerness-bukkit` contains catalog loading, Bukkit services, Brigadier, PlaceholderAPI, Folia-safe scheduling, the editor lifecycle bridge, resources, and the deployable JAR.

The workspace under `editor/` contains the shared React application, Tauri desktop host, protocol schemas, Minecraft asset readers, and renderer. See [editor/README.md](editor/README.md) for setup, API negotiation, and operational limits.

The NMS module is shaded into the Bukkit distribution. NMS, CraftBukkit, packet, channel, and mutable server types do not enter the public platform-neutral contracts.

## Bukkit API

Consumer plugins compile against `com.iroselle:itemerness-bukkit-api:<version>` and their own Paper
API dependency. Use `compileOnly`; do not shade or relocate Itemerness API classes into a consumer.
Declare an Itemerness plugin dependency and obtain `BukkitItemernessApi` from Bukkit's services
manager. Bind with the consumer's own plugin instance after its enable lifecycle has completed;
bindings retire when either plugin lifecycle ends. Live inventory edits use `editPlayerSlot` to
perform the complete transaction in the player's owning context.

Both API artifacts support explicit local publication for development:

```bash
./gradlew :itemerness-api:publishToMavenLocal :itemerness-bukkit-api:publishToMavenLocal
```

This does not publish to a remote repository or make Maven Local an implicit build dependency.
See [tools/runtime-probe/README.md](tools/runtime-probe/README.md) for an independent Java consumer
that can resolve either the published metadata or the two local API JARs.

`ItemernessCatalogPublishedEvent` announces successful runtime YAML reloads after commit, outside
the publication lock, in order on the global region scheduler. A consumer reads the current API
revision for startup and listens for later reloads. Listener failures do not roll back the catalog;
validation-only reloads, rejected candidates, and authoring draft saves emit no event. The global
callback does not own players, inventories, blocks, or regions: schedule that work in its owning
context and never wait for it inside the listener.

## Build

Build with JDK 25:

```bash
./gradlew check build
```

The deployable artifact is:

```text
itemerness-bukkit/build/libs/Itemerness.jar
```

The build verifies Kotlin/JVM tests, the shaded service boundaries, plugin metadata, bundled YAML/SNBT resources, Folia scheduling rules, compilation against the pinned Paper/Folia/Canvas APIs, the exact NMS ABI manifest, and scanned packet/component carrier coverage.

`tools/runtime-probe` is an independent disposable consumer used by the Craft Runner smoke matrix. It is not part of the plugin dependency graph or the shipped JAR.

## Downloads and Releases

Published builds are available from [GitHub Releases](https://github.com/RoselleMC/Itemerness/releases):
`Itemerness.jar`, portable macOS `.app.zip` files for Apple Silicon and Intel, a Windows x64 `.exe`,
and `SHA256SUMS`. macOS builds are ad-hoc signed, not notarized; Windows builds are unsigned and need WebView2.

The Build and Release workflow checks the plugin and editor and builds every distribution on main
pushes, pull requests, or manual runs. Ordinary runs retain downloads as workflow artifacts.
Only a main-branch push whose **head commit** contains an independent line such as
`Release: v0.1.0` publishes a release. Prerelease versions such as `Release: v0.2.0-rc.1`
produce GitHub prereleases. Pull requests and manual runs never publish.

Before a release, update `itemernessVersion` in `gradle.properties`, both editor package versions,
`Cargo.toml`, its package entry in `Cargo.lock`, and `tauri.conf.json` to the same version.
An optional `.github/releases/vVERSION.md` supplies release notes; otherwise GitHub generates them.
All checks and builds must succeed before publication. Assets are verified and uploaded to a draft
before it is made public; published versions are never overwritten on reruns.

## Commands

The player arguments in `give`, `inspect`, `data`, and `refresh` accept online player names
and native player selectors subject to their existing permissions. Other inputs retain the
server's native player-argument behavior; bare UUIDs are rejected by the pinned `26.1.2` parser.
Unquoted Unicode names
are accepted by the server, but vanilla clients still receive the native player grammar and
may highlight them as invalid. Quote a Unicode player name for native client parsing and
completion; subsequent item IDs, slots, data keys, and quantities remain separate typed arguments.

This changes command token parsing only, not login authentication, account-name policy, or
offline identity handling. Online lookup stays with Paper's native resolver; Itemerness does
not scan player profiles. Actions that access a target player's state still use that entity's
owning scheduler.

## Configuration

`config.yml` contains global catalog, pending-name, locale, presentation, and optional editor API settings. `editor.enabled` defaults to false. Enabling it opens the configured `editor.bind-host`/`editor.port` listener (default `0.0.0.0:18087`, all IPv4 interfaces). Connect the editor directly to `http://<server-ip>:18087`; HTTPS endpoints are also supported. An empty `editor.token` allows unauthenticated access; a nonempty token requires Bearer authentication. Anyone who can reach an unauthenticated listener can read and edit its drafts, so restrict network access. HTTP is unencrypted; use a TLS reverse proxy on untrusted networks. All API settings require a server restart, and existing explicit bind addresses are preserved on upgrade. The editor stores the address, not the token. Content is separated by responsibility under:

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

An item's `base.components` can explicitly clear material attributes and set actual enchantments:

```yaml
base:
  material: minecraft:diamond_sword
  components:
    minecraft:attribute_modifiers: []
    minecraft:enchantments:
      minecraft:sharpness: 3
      minecraft:mending: 1
```

`minecraft:attribute_modifiers` currently accepts only an empty list, not arbitrary modifiers.
`minecraft:enchantments` and `minecraft:stored_enchantments` accept up to 64 registered namespaced
enchantment keys with integer levels from 1 to 255; `{}` explicitly clears the component. Omitting
a component keeps the material default. The editor exposes the same overrides after negotiating
`catalog.base-components.attributes-enchantments`; it does not silently remove them for older peers.

PDC may be declared per data key as a typed, read-only, lower-priority fallback. Canonical NBT and definition data always win, PDC never establishes managed identity, and Itemerness never writes authoritative values back to PDC.

The Chinese user guide, command reference, PlaceholderAPI routes, API examples, theme guidance, and compatibility notes are maintained in the [GitHub Wiki](https://github.com/RoselleMC/Itemerness/wiki).

# Itemerness

Itemerness is a Bukkit-ecosystem item plugin built with Folia and Canvas compatibility as a hard requirement.

## Status

This repository is an initial architecture scaffold. The current JAR installs the streamlined configuration/example tree and registers the small read-only service; catalog loading, Brigadier commands, PlaceholderAPI expansion, direct NMS projection, and the deployable web editor are planned contracts, not implemented runtime features yet.

## Baseline

- Minecraft 26.1.2
- Java 25
- Gradle Kotlin DSL
- Kotlin 2.4.0
- Traditional `plugin.yml` with `folia-supported: true`

Minecraft 26.1.2 is the current common stable line across Paper, Folia, and Canvas. The platform module compiles its sources against all three pinned APIs during `check`.

## Modules

```text
itemerness-api <- itemerness-core <- itemerness-bukkit
```

- `itemerness-api` contains the public item contracts.
- `itemerness-core` contains platform-neutral, thread-safe implementations.
- `itemerness-bukkit` contains the Bukkit entrypoint and platform adapters, and produces the deployable plugin JAR.

Viewer-specific item projection will add `itemerness-projection-spi` and the direct, exact-version `itemerness-nms-26_1_2` adapter. The Bukkit distribution will depend on and shade the adapter; the adapter depends only on the NMS-free SPI/core, so the module graph stays acyclic. It will use Paper's supported development tooling and keep every NMS type out of the API, core, SPI, and common Bukkit signatures. PacketEvents is not part of the architecture. A new Minecraft ABI receives a new adapter module instead of compatibility guesses in common code.

## Build

```bash
./gradlew check
./gradlew build
```

The deployable artifact is written to:

```text
itemerness-bukkit/build/libs/Itemerness.jar
```

The build verifies the expanded plugin metadata, rejects legacy Bukkit scheduler usage, and recompiles the Bukkit implementation against the pinned Folia and Canvas APIs. Runtime-sensitive changes still need smoke tests on real Folia and Canvas servers.

## Configuration direction

`config.yml` is the only global runtime configuration. Catalog content remains split by domain under `items/`, `data-keys/`, `layouts/`, `themes/`, `assets/`, and `locales/`; API caller grants remain in `access.yml`. Packet policy, validation severity, diagnostics, PlaceholderAPI routing, and the Brigadier command tree are implementation contracts rather than separate configuration files.

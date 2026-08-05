# Itemerness

Itemerness is a Bukkit-ecosystem item plugin built with Folia and Canvas compatibility as a hard requirement.

## Status

This repository is in early development. The current JAR installs the streamlined configuration/example tree and registers the small read-only service. A direct-NBT projection SPI and the first exact-26.1.2 NMS vertical slice now compile and have unit coverage, but their runtime release gate remains closed until all required packet and inbound surfaces are implemented and tested. Catalog loading, Brigadier commands, PlaceholderAPI expansion, usable player projection, and the deployable web editor are not implemented runtime features yet.

## Baseline

- Minecraft 26.1.2
- Java 25
- Gradle Kotlin DSL
- Kotlin 2.4.0
- Traditional `plugin.yml` with `folia-supported: true`

Minecraft 26.1.2 is the current common stable line across Paper, Folia, and Canvas. The platform module compiles its sources against all three pinned APIs during `check`.

## Modules

```text
itemerness-core -> itemerness-api
itemerness-projection-spi -> itemerness-api
itemerness-nms-26_1_2 -> itemerness-projection-spi
itemerness-bukkit -> itemerness-core, itemerness-projection-spi, itemerness-nms-26_1_2
```

- `itemerness-api` contains the public item contracts.
- `itemerness-core` contains platform-neutral, thread-safe implementations.
- `itemerness-projection-spi` contains immutable, NMS-free projection snapshots and lifecycle contracts.
- `itemerness-nms-26_1_2` contains the exact-version direct-NMS adapter prototype.
- `itemerness-bukkit` contains the Bukkit entrypoint and platform adapters, and produces the deployable plugin JAR.

The Bukkit distribution shades the adapter while the adapter depends only on the NMS-free SPI/API contracts, so the module graph stays acyclic. It uses Paper's supported development tooling and keeps every NMS type out of the API, core, SPI, and common Bukkit signatures. PacketEvents is not part of the architecture. A new Minecraft ABI receives a new adapter module instead of compatibility guesses in common code.

## Build

```bash
./gradlew check
./gradlew build
```

The deployable artifact is written to:

```text
itemerness-bukkit/build/libs/Itemerness.jar
```

The build verifies the expanded plugin metadata, shaded NMS service descriptor and Mojang mapping namespace, rejects legacy Bukkit scheduler usage, and recompiles the Bukkit implementation against the pinned Folia and Canvas APIs. Runtime-sensitive changes still need smoke tests on real Folia and Canvas servers. The current projection release gate is deliberately disabled, so a successful build does not provide usable player projection.

## Configuration direction

`config.yml` is the only global runtime configuration. Catalog content remains split by domain under `items/`, `data-keys/`, `layouts/`, `themes/`, `assets/`, and `locales/`; API caller grants remain in `access.yml`. Packet policy, validation severity, diagnostics, PlaceholderAPI routing, and the Brigadier command tree are implementation contracts rather than separate configuration files.

# Itemerness runtime probe

This is a disposable, independent Bukkit plugin used only by the craftr smoke-test servers. It is
not included in the Itemerness module graph and does not call NMS.

Build Itemerness first, then invoke the root wrapper with this directory as an independent build:

```text
./gradlew -p tools/runtime-probe clean build
```

`itemernessJar` defaults to `itemerness-bukkit/build/libs/Itemerness.jar`; an explicit absolute
path may be supplied with `-PitemernessJar=...`. The output is
`tools/runtime-probe/build/libs/ItemernessRuntimeProbe.jar`.

The Bukkit plugin name is `ExampleConsumer`. It intentionally reuses the writer principal in the
bundled example data schema. No Bukkit permission node is required because the probe uses only the
public service API. Before startup, replace the server's `plugins/Itemerness/access.yml` and
`plugins/Itemerness/items/examples.yml` with the files in `fixture/`.

Exactly one terminal marker is logged per enable attempt:

- `ITEMERNESS_RUNTIME_PROBE_PASS` means the complete contract probe passed.
- `ITEMERNESS_RUNTIME_PROBE_FAIL` includes a compact failure reason.

The probe verifies service discovery, caller-classloader binding, borrowed-plugin rejection,
catalog visibility, canonical create/identify/read/edit behavior, both layers of data access
control, immutable source edits, and successful completion of a no-op player-slot
`CompletionStage`. The slot test uses an in-memory `Player`/`PlayerInventory` facade and therefore
does not require a connected Minecraft client.

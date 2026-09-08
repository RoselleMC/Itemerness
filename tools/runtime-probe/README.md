# Itemerness runtime probe

This is a disposable, independent Bukkit plugin used only by the craftr smoke-test servers. It is
not included in the Itemerness module graph and does not call NMS.

Build the two public API artifacts first, then invoke the root wrapper with this directory as an
independent build. The probe does not compile against the complete plugin or implementation modules:

```text
./gradlew :itemerness-api:jar :itemerness-bukkit-api:jar
./gradlew -p tools/runtime-probe clean build
```

The default `itemernessApiMode=files` uses the public JARs in each module's `build/libs`, with the
version read from the root `gradle.properties`. Override their paths with `-PitemernessApiJar=...`
and `-PitemernessBukkitApiJar=...`. It does not require Maven Local. After platform and stdlib
dependencies are cached, this mode also supports Gradle's `--offline` flag.

For an explicit Maven Local consumer check, publish both APIs and resolve the upper artifact's
transitive API dependency from its publication metadata:

```text
./gradlew :itemerness-api:publishToMavenLocal :itemerness-bukkit-api:publishToMavenLocal
./gradlew -p tools/runtime-probe clean build -PitemernessApiMode=mavenLocal
```

`-PitemernessVersion=...` selects another explicitly published version. Maven Local is enabled only
in that mode and only for `com.iroselle`; it is not an implicit source of platform dependencies.
All API dependencies are compileOnly. The build verifies that the resulting
`tools/runtime-probe/build/libs/ItemernessRuntimeProbe.jar` contains no API or implementation classes.

The Bukkit plugin name is `ExampleConsumer`. It intentionally reuses the writer principal in the
bundled example data schema. No Bukkit permission node is required because the probe uses only the
public service API. Use a dedicated, disposable Craft Runner test server with the files in
`fixture/` installed as `plugins/Itemerness/access.yml` and `plugins/Itemerness/items/examples.yml`.
Never replace an existing editor preview server's catalog, access policy, or authoring draft for
this probe. It does not publish fixtures or invoke reload itself.

Exactly one terminal marker is logged per enable attempt:

- `ITEMERNESS_RUNTIME_PROBE_PASS` means the complete contract probe passed.
- `ITEMERNESS_RUNTIME_PROBE_FAIL` includes a compact failure reason.

The probe verifies service discovery, caller-classloader binding, borrowed-plugin rejection,
catalog visibility, canonical create/identify/read/edit behavior, both layers of data access
control, immutable source edits, and successful completion of a no-op player-slot
`CompletionStage`. The slot test uses an in-memory `Player`/`PlayerInventory` facade and therefore
does not require a connected Minecraft client.

The independent Java consumer also registers `ItemernessCatalogPublishedEvent`. After an operator
explicitly performs a valid catalog reload, `ITEMERNESS_CATALOG_EVENT_PASS` records a strictly newer
revision, equality with the public API revision, and execution on the global scheduler. A contract
failure logs `ITEMERNESS_CATALOG_EVENT_FAIL`. Startup is checked by reading the API revision; no
startup event is expected. Validation-only reloads and draft saves must not produce event markers.

When the API exposes no enabled items, the probe reports `scope=empty-visible-catalog` and performs
only service discovery, caller binding, shared API/event classloader checks, and initial revision
reads. It does not create items, install fixtures, or report the fixture mutation checks as passed.
This branch can be used on an existing empty-catalog editor preview server without changing files.

For listener-failure isolation, the test plugin exposes `setCatalogEventFailureProbe(boolean)` for
an explicit Craft Runner debug call on the global context. While enabled, a LOWEST listener throws
the marked `ITEMERNESS_EXPECTED_CATALOG_LISTENER_FAILURE`; the MONITOR listener must still record
the event. `catalogProbeStatus()` exposes in-memory counters. Turn the switch off after the check.
Only send reload commands through Craft Runner's command operation, never through debug evaluation.

package com.iroselle.itemerness.bukkit.projection

import com.iroselle.itemerness.api.BooleanDataValue
import com.iroselle.itemerness.api.CompoundDataValue
import com.iroselle.itemerness.api.DecimalDataValue
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.IntegerDataValue
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.api.ListDataValue
import com.iroselle.itemerness.api.LongDataValue
import com.iroselle.itemerness.api.NamespacedKeyDataValue
import com.iroselle.itemerness.api.StringDataValue
import com.iroselle.itemerness.api.UuidDataValue
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogManager
import com.iroselle.itemerness.bukkit.catalog.RuntimeCatalogUpdate
import com.iroselle.itemerness.core.catalog.CanonicalItemInstance
import com.iroselle.itemerness.core.catalog.InstanceDataMutation
import com.iroselle.itemerness.projection.BooleanProjectionValue
import com.iroselle.itemerness.projection.CanonicalDataSchemaVersion
import com.iroselle.itemerness.projection.CanonicalDataSchemas
import com.iroselle.itemerness.projection.CanonicalItemFingerprint
import com.iroselle.itemerness.projection.CanonicalItemSnapshot
import com.iroselle.itemerness.projection.DecimalProjectionValue
import com.iroselle.itemerness.projection.IntegerProjectionValue
import com.iroselle.itemerness.projection.KeyProjectionValue
import com.iroselle.itemerness.projection.ListProjectionValue
import com.iroselle.itemerness.projection.LocaleId
import com.iroselle.itemerness.projection.LongProjectionValue
import com.iroselle.itemerness.projection.ProjectionCompound
import com.iroselle.itemerness.projection.ProjectionFallbackReason
import com.iroselle.itemerness.projection.ProjectionRequest
import com.iroselle.itemerness.projection.ProjectionResult
import com.iroselle.itemerness.projection.ProjectionValue
import com.iroselle.itemerness.projection.StringProjectionValue
import com.iroselle.itemerness.projection.UuidProjectionValue
import com.iroselle.itemerness.projection.ViewerFact
import com.iroselle.itemerness.projection.ViewerProjectionSnapshot
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class ProjectionStateStoreTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `asset profile binding requires both the exact pack id and sha1`() {
        installBundledResources()
        val assets = directory.resolve("assets/bitmaps.yml")
        Files.writeString(assets, Files.readString(assets).replace("enabled: false", "enabled: true"))
        val runtime = (RuntimeCatalogManager(directory, "26.1.2").reload() as RuntimeCatalogUpdate.Published).active
        val store = ProjectionStateStore()
        store.publishCatalog(runtime, runtime.presentation)
        val packId = UUID.fromString("00000000-0000-0000-0000-000000000001")
        val expected = ItemKey.parse("itemerness:example-pack-v1")

        assertEquals(expected, store.matchAssetProfile(runtime.domain.revision, packId, "0".repeat(39) + "1"))
        assertEquals(expected, store.matchAssetProfile(runtime.domain.revision, packId, "0".repeat(39) + "1".uppercase()))
        assertNull(store.matchAssetProfile(runtime.domain.revision, packId, "f".repeat(40)))
        assertNull(store.matchAssetProfile(runtime.domain.revision, UUID.randomUUID(), "0".repeat(39) + "1"))
    }

    @Test
    fun `same canonical instance renders independently for two viewer locales`() {
        installBundledResources()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(itemFile, Files.readString(itemFile).replaceFirst("enabled: false", "enabled: true"))
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val update = manager.reload()
        require(update is RuntimeCatalogUpdate.Published) { update.diagnostics.joinToString() }
        val runtime = update.active
        val itemKey = ItemKey.parse("itemerness:travel-token")
        val instance = runtime.domain.createInstance(itemKey)
        val sourceData = instance.data.toMap()
        val canonical = canonical(runtime.settings.pendingName(itemKey), instance)
        val store = ProjectionStateStore()
        store.publishCatalog(runtime, runtime.presentation)

        val englishId = UUID.fromString("f47c0e13-741f-4d08-9b60-90a55085fed7")
        val chineseId = UUID.fromString("40df9fc2-b5bb-40c7-b958-16a853f4ac39")
        store.publishViewer(viewer(englishId, "en_us"))
        store.publishViewer(viewer(chineseId, "zh_cn"))

        val english = store.render(englishId, canonical) as ProjectionResult.Rendered
        val chinese = store.render(chineseId, canonical) as ProjectionResult.Rendered
        assertSame(english, store.render(englishId, canonical))
        val englishName = english.display.displayName.runs.joinToString("") { it.text }
        val chineseName = chinese.display.displayName.runs.joinToString("") { it.text }

        assertEquals("Harbor Travel Token", englishName)
        assertEquals("港口旅行凭证", chineseName)
        assertEquals(ItemKey.parse("minecraft:paper"), english.display.itemModel)
        assertNotEquals(english.display.lore, chinese.display.lore)
        assertEquals(sourceData, instance.data, "Projection must not mutate its canonical source")
        assertEquals(
            NamespacedKeyDataValue(ItemKey.parse("example:harbor")),
            instance.data[DataKey.parse("example:region")],
        )
        assertEquals(IntegerDataValue(3), instance.data[DataKey.parse("example:charges")])
        assertTrue(instance.data[DataKey.parse("itemerness:created-at")] is LongDataValue)

        store.publishViewer(viewer(englishId, "en_us", revision = 2))
        assertNotSame(english, store.render(englishId, canonical))
    }

    @Test
    fun `publication keeps old viewer contexts usable until that viewer is recaptured`() {
        installBundledResources()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val first = manager.reload() as RuntimeCatalogUpdate.Published
        val store = ProjectionStateStore()
        val viewerId = UUID.fromString("cfbc9bc6-dcf1-42b5-8358-857aa39ba13a")
        store.publishCatalog(first.active, first.active.presentation)
        store.publishViewer(viewer(viewerId, "en_us"))
        val inFlight = requireNotNull(store.acquire(viewerId))

        val second = manager.reload() as RuntimeCatalogUpdate.Published
        store.publishCatalog(second.active, second.active.presentation)

        assertEquals(1, inFlight.generation.catalogRevision)
        assertEquals(1, requireNotNull(store.acquire(viewerId)).generation.catalogRevision)
        assertTrue(inFlight.viewer === store.viewer(viewerId))
        store.publishViewer(viewer(viewerId, "en_us", revision = 2, catalogRevision = 2))
        assertEquals(2, requireNotNull(store.acquire(viewerId)).generation.catalogRevision)
    }

    @Test
    fun `rapid reloads preserve a lagging viewer and an acquired catalog handle survives retirement`() {
        installBundledResources()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(itemFile, Files.readString(itemFile).replaceFirst("enabled: false", "enabled: true"))
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val first = manager.reload() as RuntimeCatalogUpdate.Published
        val itemKey = ItemKey.parse("itemerness:travel-token")
        val canonical = canonical(
            first.active.settings.pendingName(itemKey),
            first.active.domain.createInstance(itemKey),
        )
        val viewerId = UUID.fromString("cfbc9bc6-dcf1-42b5-8358-857aa39ba13c")
        val store = ProjectionStateStore()
        store.publishCatalog(first.active, first.active.presentation)
        store.publishViewer(viewer(viewerId, "en_us", catalogRevision = 1))
        val acquiredAtOne = requireNotNull(store.acquire(viewerId))

        val second = manager.reload() as RuntimeCatalogUpdate.Published
        store.publishCatalog(second.active, second.active.presentation)
        val third = manager.reload() as RuntimeCatalogUpdate.Published
        store.publishCatalog(third.active, third.active.presentation)

        assertEquals(1, requireNotNull(store.acquire(viewerId)).generation.catalogRevision)
        assertTrue(store.project(ProjectionRequest(canonical, acquiredAtOne)) is ProjectionResult.Rendered)

        store.publishViewer(viewer(viewerId, "en_us", revision = 2, catalogRevision = 3))
        val fourth = manager.reload() as RuntimeCatalogUpdate.Published
        store.publishCatalog(fourth.active, fourth.active.presentation)

        assertEquals(3, requireNotNull(store.acquire(viewerId)).generation.catalogRevision)
        assertTrue(
            store.project(ProjectionRequest(canonical, acquiredAtOne)) is ProjectionResult.Rendered,
            "The opaque handle must retain the exact catalog for an already-acquired packet",
        )
    }

    @Test
    fun `viewer capture retains its catalog across four rapid revisions`() {
        installBundledResources()
        val assets = directory.resolve("assets/bitmaps.yml")
        Files.writeString(assets, Files.readString(assets).replace("enabled: false", "enabled: true"))
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(
            itemFile,
            Files.readString(itemFile).replace(
                "  travel-token:\n    enabled: false",
                "  travel-token:\n    enabled: true",
            ),
        )
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val first = manager.reload() as RuntimeCatalogUpdate.Published
        val store = ProjectionStateStore()
        val viewerId = UUID.fromString("cfbc9bc6-dcf1-42b5-8358-857aa39ba13d")
        store.publishCatalog(first.active, first.active.presentation)
        store.publishViewer(viewer(viewerId, "en_us", catalogRevision = 1))

        val second = manager.reload() as RuntimeCatalogUpdate.Published
        store.publishCatalog(second.active, second.active.presentation)
        val retainedAtTwo = requireNotNull(store.catalogHandle(2))
        val profile = ItemKey.parse("itemerness:example-pack-v1")
        val capturedViewer = viewer(
            viewerId,
            "en_us",
            revision = 2,
            catalogRevision = 2,
            assetProfile = profile,
            capabilities = store.capabilities(retainedAtTwo, profile),
        )
        val itemKey = ItemKey.parse("itemerness:travel-token")
        val capturedCanonical = canonical(
            second.active.settings.pendingName(itemKey),
            second.active.domain.createInstance(itemKey),
        )

        val third = manager.reload() as RuntimeCatalogUpdate.Published
        store.publishCatalog(third.active, third.active.presentation)
        val fourth = manager.reload() as RuntimeCatalogUpdate.Published
        store.publishCatalog(fourth.active, fourth.active.presentation)

        assertEquals(1, requireNotNull(store.acquire(viewerId)).generation.catalogRevision)
        assertNull(store.catalogHandle(2), "Revision two should have left the bounded lookup map")
        val packId = UUID.fromString("00000000-0000-0000-0000-000000000001")
        val sha1 = "0".repeat(39) + "1"
        assertNull(store.matchAssetProfile(2, packId, sha1))
        assertTrue(store.capabilities(2, profile).isEmpty())
        assertTrue(store.formatValue(2, IntegerDataValue(3), ItemKey.parse("itemerness:integer"), "en_us").isFailure)
        assertTrue(store.render(capturedViewer, capturedCanonical) is ProjectionResult.Fallback)

        assertEquals(profile, store.matchAssetProfile(retainedAtTwo, packId, sha1))
        assertTrue(ItemKey.parse("itemerness:bitmap-canvas-v1") in store.capabilities(retainedAtTwo, profile))
        assertTrue(
            store.formatValue(
                retainedAtTwo,
                IntegerDataValue(3),
                ItemKey.parse("itemerness:integer"),
                "en_us",
            ).isSuccess,
        )
        assertTrue(store.render(capturedViewer, capturedCanonical, retainedAtTwo) is ProjectionResult.Rendered)

        store.publishViewer(
            capturedViewer,
            retainedAtTwo,
        )

        assertEquals(
            2,
            requireNotNull(store.acquire(viewerId)).generation.catalogRevision,
            "A capture that began at revision two must publish with that exact retained catalog",
        )

        val foreignStore = ProjectionStateStore().also { state ->
            state.publishCatalog(second.active, second.active.presentation)
        }
        val foreignHandle = requireNotNull(foreignStore.catalogHandle(2))
        assertThrows(IllegalArgumentException::class.java) {
            store.capabilities(foreignHandle, profile)
        }
    }

    @Test
    fun `prepared catalog publication is invisible until commit and can restore its exact predecessor`() {
        installBundledResources()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val first = manager.reload() as RuntimeCatalogUpdate.Published
        val second = manager.reload() as RuntimeCatalogUpdate.Published
        val viewerId = UUID.fromString("cfbc9bc6-dcf1-42b5-8358-857aa39ba13b")
        val store = ProjectionStateStore()
        store.publishCatalog(first.active, first.active.presentation)
        store.publishViewer(viewer(viewerId, "en_us", catalogRevision = 1))

        val prepared = store.prepareCatalog(second.active, second.active.presentation)
        assertEquals(1, requireNotNull(store.acquire(viewerId)).generation.catalogRevision)

        prepared.commit()
        assertEquals(
            1,
            requireNotNull(store.acquire(viewerId)).generation.catalogRevision,
            "A viewer must stay wholly on its old catalog until its new snapshot is ready",
        )

        prepared.rollback()
        assertEquals(1, requireNotNull(store.acquire(viewerId)).generation.catalogRevision)
        prepared.rollback()
        assertThrows(IllegalStateException::class.java, prepared::commit)
    }

    @Test
    fun `absent viewer theme uses item theme while an explicit override wins`() {
        installBundledResources()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(
            itemFile,
            Files.readString(itemFile).replace(
                "  ember-blade:\n    enabled: false",
                "  ember-blade:\n    enabled: true",
            ),
        )
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val update = manager.reload() as RuntimeCatalogUpdate.Published
        val runtime = update.active
        val itemKey = ItemKey.parse("itemerness:ember-blade")
        val definition = requireNotNull(runtime.domain.findItem(itemKey))
        val canonical = canonical(
            runtime.settings.pendingName(itemKey),
            runtime.domain.createInstance(itemKey),
            definition.material,
        )
        val store = ProjectionStateStore()
        val viewerId = UUID.fromString("cfbc9bc6-dcf1-42b5-8358-857aa39ba14a")
        val assetProfile = ItemKey.parse("itemerness:example-pack-v1")
        val facts = listOf(
            ViewerFact(
                ItemKey.parse("itemerness:resource-pack-ready"),
                BooleanProjectionValue(true),
            ),
        )
        store.publishCatalog(runtime, runtime.presentation)

        store.publishViewer(
            viewer(
                viewerId,
                "en_us",
                theme = null,
                assetProfile = assetProfile,
                capabilities = store.capabilities(runtime.domain.revision, assetProfile),
                facts = facts,
            ),
        )
        val itemTheme = store.render(viewerId, canonical) as ProjectionResult.Rendered
        store.publishViewer(
            viewer(
                viewerId,
                "en_us",
                revision = 2,
                theme = ItemKey.parse("itemerness:default"),
                assetProfile = assetProfile,
                capabilities = store.capabilities(runtime.domain.revision, assetProfile),
                facts = facts,
            ),
        )
        val override = store.render(viewerId, canonical) as ProjectionResult.Rendered

        assertEquals(ItemKey.parse("itemerness:ember"), itemTheme.display.tooltipStyle)
        assertEquals(null, override.display.tooltipStyle)
    }

    @Test
    fun `projection uses declared PDC only after canonical and definition data`() {
        installBundledResources()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(
            itemFile,
            Files.readString(itemFile).replace(
                "  ember-blade:\n    enabled: false",
                "  ember-blade:\n    enabled: true",
            ),
        )
        val runtime = (RuntimeCatalogManager(directory, "26.1.2").reload() as RuntimeCatalogUpdate.Published).active
        val itemKey = ItemKey.parse("itemerness:ember-blade")
        val quality = DataKey.parse("example:quality")
        val withoutCanonicalQuality = runtime.domain.editInstance(
            runtime.domain.createInstance(itemKey),
            listOf(InstanceDataMutation.Remove(quality)),
        )
        val fallback = ProjectionCompound(
            listOf(
                ProjectionCompound.Entry(
                    quality.toString(),
                    KeyProjectionValue(ItemKey.parse("example:rare")),
                ),
            ),
        )
        val definition = requireNotNull(runtime.domain.findItem(itemKey))
        val store = ProjectionStateStore()
        val viewerId = UUID.fromString("cfbc9bc6-dcf1-42b5-8358-857aa39ba14b")
        store.publishCatalog(runtime, runtime.presentation)
        store.publishViewer(viewer(viewerId, "en_us"))
        val retainedPlan = store.acquire(requireNotNull(store.acquire(viewerId)))
        assertEquals(quality, retainedPlan.entries.single().dataKey)
        assertEquals(ItemKey.parse("legacyitems:quality"), retainedPlan.entries.single().pdcKey)
        assertEquals(setOf(itemKey), retainedPlan.entries.single().itemKeys)

        val renderedFallback = store.render(
            viewerId,
            canonical(
                runtime.settings.pendingName(itemKey),
                withoutCanonicalQuality,
                definition.material,
                pdcFallbackData = fallback,
            ),
        ) as ProjectionResult.Rendered
        val fallbackLore = renderedFallback.display.lore.joinToString("\n") { line ->
            line.runs.joinToString("") { run -> run.text }
        }
        assertTrue("Rare" in fallbackLore)

        val canonicalWins = runtime.domain.editInstance(
            withoutCanonicalQuality,
            listOf(
                InstanceDataMutation.Set(
                    quality,
                    NamespacedKeyDataValue(ItemKey.parse("example:uncommon")),
                ),
            ),
        )
        val renderedCanonical = store.render(
            viewerId,
            canonical(
                runtime.settings.pendingName(itemKey),
                canonicalWins,
                definition.material,
                pdcFallbackData = fallback,
            ),
        ) as ProjectionResult.Rendered
        val canonicalLore = renderedCanonical.display.lore.joinToString("\n") { line ->
            line.runs.joinToString("") { run -> run.text }
        }
        assertTrue("Uncommon" in canonicalLore)
        assertFalse("Rare" in canonicalLore)

        val invalid = store.render(
            viewerId,
            canonical(
                runtime.settings.pendingName(itemKey),
                withoutCanonicalQuality,
                definition.material,
                pdcFallbackData = ProjectionCompound(
                    listOf(
                        ProjectionCompound.Entry(
                            quality.toString(),
                            KeyProjectionValue(ItemKey.parse("example:not-allowed")),
                        ),
                    ),
                ),
            ),
        ) as ProjectionResult.Fallback
        assertEquals(ProjectionFallbackReason.INVALID_CANONICAL_DATA, invalid.reason)
    }

    @Test
    fun `physical stack capability gates managed-only themes`() {
        installBundledResources()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(
            itemFile,
            Files.readString(itemFile).replace(
                "  framed-relic:\n    enabled: false",
                "  framed-relic:\n    enabled: true",
            ),
        )
        val update = RuntimeCatalogManager(directory, "26.1.2").reload() as RuntimeCatalogUpdate.Published
        val runtime = update.active
        val itemKey = ItemKey.parse("itemerness:framed-relic")
        val definition = requireNotNull(runtime.domain.findItem(itemKey))
        val instance = runtime.domain.createInstance(itemKey)
        val safe = canonical(
            runtime.settings.pendingName(itemKey),
            instance,
            definition.material,
            canManageVanillaTooltipLines = true,
        )
        val unsafe = canonical(
            runtime.settings.pendingName(itemKey),
            instance,
            definition.material,
            canManageVanillaTooltipLines = false,
        )
        val store = ProjectionStateStore()
        val viewerId = UUID.fromString("cfbc9bc6-dcf1-42b5-8358-857aa39ba15a")
        val assetProfile = ItemKey.parse("itemerness:example-pack-v1")
        store.publishCatalog(runtime, runtime.presentation)
        store.publishViewer(
            viewer(
                viewerId,
                "en_us",
                assetProfile = assetProfile,
                capabilities = store.capabilities(runtime.domain.revision, assetProfile),
                facts = listOf(
                    ViewerFact(
                        ItemKey.parse("itemerness:resource-pack-ready"),
                        BooleanProjectionValue(true),
                    ),
                ),
            ),
        )

        val managed = store.render(viewerId, safe) as ProjectionResult.Rendered
        val preserved = store.render(viewerId, unsafe) as ProjectionResult.Rendered

        assertTrue(managed.display.managesVanillaTooltipLines)
        assertFalse(preserved.display.managesVanillaTooltipLines)
        assertNotEquals(managed.display.lore, preserved.display.lore)
    }

    @Test
    fun `stale viewer publication cannot replace a newer immutable snapshot`() {
        val store = ProjectionStateStore()
        val viewerId = UUID.fromString("de90d7f2-2c02-4db0-a859-cdc96130c951")
        val newest = viewer(viewerId, "zh_cn", revision = 7)

        store.publishViewer(newest)
        store.publishViewer(viewer(viewerId, "en_us", revision = 6))

        assertSame(newest, store.viewer(viewerId))
    }

    @Test
    fun `clear is terminal and prevents queued catalog viewer and cache resurrection`() {
        installBundledResources()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(itemFile, Files.readString(itemFile).replaceFirst("enabled: false", "enabled: true"))
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val first = manager.reload() as RuntimeCatalogUpdate.Published
        val second = manager.reload() as RuntimeCatalogUpdate.Published
        val itemKey = ItemKey.parse("itemerness:travel-token")
        val canonical = canonical(
            first.active.settings.pendingName(itemKey),
            first.active.domain.createInstance(itemKey),
        )
        val viewerId = UUID.fromString("f5e7fa87-d25b-4bb5-99a6-b36d0a50d638")
        val store = ProjectionStateStore()
        store.publishCatalog(first.active, first.active.presentation)
        store.publishViewer(viewer(viewerId, "en_us"))
        val inFlight = requireNotNull(store.acquire(viewerId))
        assertTrue(store.project(ProjectionRequest(canonical, inFlight)) is ProjectionResult.Rendered)
        assertTrue(projectionCacheSize(store) > 0)

        val executor = Executors.newSingleThreadExecutor()
        val attempted = CountDownLatch(1)
        try {
            val queuedPublication = synchronized(store) {
                val future = executor.submit {
                    attempted.countDown()
                    store.publishCatalog(second.active, second.active.presentation)
                }
                assertTrue(attempted.await(5, TimeUnit.SECONDS))
                store.clear()
                future
            }

            val publicationFailure = assertThrows(ExecutionException::class.java) {
                queuedPublication.get(5, TimeUnit.SECONDS)
            }
            assertTrue(publicationFailure.cause is IllegalStateException)
        } finally {
            executor.shutdownNow()
        }

        store.clear()
        assertNull(store.viewer(viewerId))
        assertNull(store.acquire(viewerId))
        assertEquals(0, projectionCacheSize(store))
        assertEquals(
            ProjectionResult.Fallback(ProjectionFallbackReason.RENDERING_FAILED),
            store.project(ProjectionRequest(canonical, inFlight)),
        )
        assertEquals(0, projectionCacheSize(store), "A stale in-flight context must not repopulate the cache")
        assertThrows(IllegalStateException::class.java) {
            store.publishCatalog(second.active, second.active.presentation)
        }
        assertThrows(IllegalStateException::class.java) {
            store.publishViewer(viewer(viewerId, "zh_cn", revision = 2, catalogRevision = 2))
        }
    }

    @Test
    fun `nested catalog contents render localized child summaries`() {
        installBundledResources()
        val itemFile = directory.resolve("items/examples.yml")
        Files.writeString(
            itemFile,
            Files.readString(itemFile)
                .replace(
                    "  travel-token:\n    enabled: false",
                    "  travel-token:\n    enabled: true",
                )
                .replace(
                    "  nested-satchel:\n    enabled: false",
                    "  nested-satchel:\n    enabled: true",
                ),
        )
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val update = manager.reload() as RuntimeCatalogUpdate.Published
        val runtime = update.active
        val itemKey = ItemKey.parse("itemerness:nested-satchel")
        val definition = requireNotNull(runtime.domain.findItem(itemKey))
        val canonical = canonical(
            runtime.settings.pendingName(itemKey),
            runtime.domain.createInstance(itemKey),
            definition.material,
        )
        val store = ProjectionStateStore()
        val viewerId = UUID.fromString("453d7eae-9b12-4aef-b3e1-e3c88d66d061")
        store.publishCatalog(runtime, runtime.presentation)
        store.publishViewer(viewer(viewerId, "zh_cn"))

        val rendered = store.render(viewerId, canonical) as ProjectionResult.Rendered
        val lore = rendered.display.lore.joinToString("\n") { line ->
            line.runs.joinToString("") { run -> run.text }
        }

        assertTrue("港口旅行凭证 ×2" in lore)
        assertEquals(ItemKey.parse("minecraft:bundle"), rendered.display.itemModel)
    }

    private fun canonical(
        pendingName: String,
        instance: CanonicalItemInstance,
        material: ItemKey = ItemKey.parse("minecraft:paper"),
        canManageVanillaTooltipLines: Boolean = false,
        pdcFallbackData: ProjectionCompound = ProjectionCompound(),
    ): CanonicalItemSnapshot =
        CanonicalItemSnapshot(
            itemKey = instance.itemKey,
            materialKey = material,
            count = 1,
            pendingName = pendingName,
            createdAgainstRevision = instance.createdAgainstRevision,
            instanceRevision = instance.instanceRevision,
            dataSchemas = CanonicalDataSchemas(
                instance.schemaVersions.map { (key, version) -> CanonicalDataSchemaVersion(key, version) },
            ),
            instanceId = instance.instanceId,
            data = ProjectionCompound(
                instance.data.entries.map { (key, value) -> ProjectionCompound.Entry(key.toString(), value.project()) },
            ),
            fingerprint = CanonicalItemFingerprint(
                java.security.MessageDigest.getInstance("SHA-256").digest(
                    listOf(
                        instance.itemKey,
                        instance.instanceRevision,
                        instance.data,
                        pdcFallbackData,
                        canManageVanillaTooltipLines,
                    ).joinToString("|").toByteArray(Charsets.UTF_8),
                ),
            ),
            canManageVanillaTooltipLines = canManageVanillaTooltipLines,
            pdcFallbackData = pdcFallbackData,
        )

    private fun viewer(
        id: UUID,
        locale: String,
        revision: Long = 1,
        catalogRevision: Long = 1,
        theme: ItemKey? = null,
        assetProfile: ItemKey = ItemKey.parse("itemerness:vanilla"),
        capabilities: Collection<ItemKey> = emptyList(),
        facts: Collection<ViewerFact> = emptyList(),
    ): ViewerProjectionSnapshot = ViewerProjectionSnapshot(
        viewerId = id,
        revision = revision,
        catalogRevision = catalogRevision,
        locale = LocaleId(locale),
        theme = theme,
        assetProfile = assetProfile,
        capabilities = capabilities,
        facts = facts,
    )

    private fun ItemDataValue.project(): ProjectionValue = when (this) {
        is BooleanDataValue -> BooleanProjectionValue(value)
        is IntegerDataValue -> IntegerProjectionValue(value)
        is LongDataValue -> LongProjectionValue(value)
        is DecimalDataValue -> DecimalProjectionValue(java.math.BigDecimal.valueOf(value))
        is StringDataValue -> StringProjectionValue(value)
        is UuidDataValue -> UuidProjectionValue(value)
        is NamespacedKeyDataValue -> KeyProjectionValue(value)
        is ListDataValue -> ListProjectionValue(values.map { value -> value.project() })
        is CompoundDataValue -> ProjectionCompound(
            entries.entries.map { (key, value) -> ProjectionCompound.Entry(key, value.project()) },
        )
    }

    private fun installBundledResources() {
        copyResource("config.yml")
        val paths = checkNotNull(javaClass.classLoader.getResourceAsStream("itemerness-resources.txt"))
            .bufferedReader(Charsets.UTF_8)
            .useLines { lines ->
                lines.map(String::trim).filter { it.isNotEmpty() && !it.startsWith('#') }.toList()
            }
        paths.forEach(::copyResource)
    }

    private fun copyResource(path: String) {
        val destination = directory.resolve(path)
        Files.createDirectories(destination.parent)
        checkNotNull(javaClass.classLoader.getResourceAsStream(path)).use { input ->
            Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private fun projectionCacheSize(store: ProjectionStateStore): Int {
        val field = ProjectionStateStore::class.java.getDeclaredField("renderCache")
        field.isAccessible = true
        val cache = field.get(store) as Map<*, *>
        return synchronized(cache) { cache.size }
    }
}

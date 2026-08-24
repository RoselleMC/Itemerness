package com.iroselle.itemerness.bukkit.catalog

import com.iroselle.itemerness.bukkit.projection.ProjectionStateStore
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class RuntimeCatalogManagerTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `publishes one complete initial runtime snapshot`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")

        val update = manager.reload()

        assertTrue(update is RuntimeCatalogUpdate.Published)
        assertEquals(1, manager.catalogRevision)
        assertEquals(12, manager.dataKeys().size)
        assertEquals(listOf("en_us", "zh_cn"), manager.locales().sorted())
        assertTrue(manager.items().isEmpty())
        assertSame(update.active, manager.snapshot())
    }

    @Test
    fun `invalid reload preserves the complete active snapshot and revision`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        manager.reload()
        val before = manager.snapshot()
        Files.writeString(directory.resolve("items/examples.yml"), "schema-version: 1\nnamespace: itemerness\nitems: [invalid]\n")

        val update = manager.reload()

        assertTrue(update is RuntimeCatalogUpdate.Rejected)
        assertSame(before, manager.snapshot())
        assertSame(before, update.active)
        assertEquals(1, manager.catalogRevision)
    }

    @Test
    fun `invalid writer policy reload fails closed without replacing the active snapshot`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)
        val before = requireNotNull(manager.snapshot())
        val schema = directory.resolve("data-keys/common.yml")
        Files.writeString(
            schema,
            Files.readString(schema).replaceFirst("- plugin:ExampleConsumer", "- 'plugin:'"),
            Charsets.UTF_8,
        )

        val update = manager.reload()

        assertTrue(update is RuntimeCatalogUpdate.Rejected)
        assertSame(before, update.active)
        assertSame(before, manager.snapshot())
        assertEquals(1, manager.catalogRevision)
        assertTrue(update.diagnostics.single().message.contains("Malformed plugin write principal"))
    }

    @Test
    fun `check-only compile does not publish or advance revision`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        manager.reload()
        val before = manager.snapshot()

        val update = manager.reload(checkOnly = true)

        assertTrue(update is RuntimeCatalogUpdate.Validated)
        assertSame(before, manager.snapshot())
        assertEquals(1, manager.catalogRevision)
    }

    @Test
    fun `clearing the manager is terminal and a later reload cannot revive it`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)

        manager.clear()
        val update = manager.reload()

        assertTrue(update is RuntimeCatalogUpdate.Rejected)
        assertEquals(null, manager.snapshot())
        assertEquals(0, manager.catalogRevision)
        assertTrue(update.diagnostics.single().message.contains("closed"))
    }

    @Test
    fun `presentation data references are checked against each resolved item schema atomically`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)
        val before = manager.snapshot()
        rewriteItems { source ->
            source
                .replaceFirst("enabled: false", "enabled: true")
                .replaceFirst("data: example:region", "data: example:not-declared")
        }

        val first = manager.reload()
        val second = manager.reload()

        assertTrue(first is RuntimeCatalogUpdate.Rejected)
        assertTrue(second is RuntimeCatalogUpdate.Rejected)
        assertSame(before, manager.snapshot())
        assertSame(before, first.active)
        assertEquals(first.diagnostics, second.diagnostics, "Cross-domain diagnostics must be deterministic")
        assertTrue(
            first.diagnostics.any { diagnostic ->
                diagnostic.code == com.iroselle.itemerness.core.catalog.CatalogDiagnosticCode.MISSING_REFERENCE &&
                    diagnostic.path == "presentation.items.itemerness:travel-token.blocks[0].data" &&
                    diagnostic.message.contains("example:not-declared")
            },
            first.diagnostics.toString(),
        )
        assertEquals(1, manager.catalogRevision)
    }

    @Test
    fun `disabled shipped items remain part of strict cross-domain validation`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)
        val before = manager.snapshot()
        rewriteItems { source ->
            source.replaceFirst("data: example:attack-damage", "data: example:not-declared")
        }

        val update = manager.reload()

        assertTrue(update is RuntimeCatalogUpdate.Rejected)
        assertSame(before, manager.snapshot())
        assertTrue(
            update.diagnostics.any { diagnostic ->
                diagnostic.path == "presentation.items.itemerness:ember-blade.blocks[0].data" &&
                    diagnostic.message.contains("example:not-declared")
            },
            update.diagnostics.toString(),
        )
    }

    @Test
    fun `incompatible formatters and non-item materials cannot publish a partial runtime`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)
        val initial = manager.snapshot()
        rewriteItems { source ->
            source
                .replaceFirst("enabled: false", "enabled: true")
                .replaceFirst("format: itemerness:key-message", "format: itemerness:integer")
        }

        val formatterFailure = manager.reload()

        assertTrue(formatterFailure is RuntimeCatalogUpdate.Rejected)
        assertSame(initial, manager.snapshot())
        assertTrue(
            formatterFailure.diagnostics.any { diagnostic ->
                diagnostic.path == "presentation.items.itemerness:travel-token.blocks[0].format" &&
                    diagnostic.message.contains("incompatible")
            },
            formatterFailure.diagnostics.toString(),
        )

        rewriteItems { source ->
            source
                .replaceFirst("format: itemerness:integer", "format: itemerness:key-message")
                .replaceFirst("material: minecraft:paper", "material: minecraft:not_a_real_item")
        }
        val materialFailure = manager.reload()

        assertTrue(materialFailure is RuntimeCatalogUpdate.Rejected)
        assertSame(initial, manager.snapshot())
        assertTrue(
            materialFailure.diagnostics.any { diagnostic ->
                diagnostic.path == "items[0].material" && diagnostic.message.contains("not_a_real_item")
            },
            materialFailure.diagnostics.toString(),
        )
    }

    @Test
    fun `placeholder formatters are checked against their data schema types`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)
        val before = manager.snapshot()
        val path = directory.resolve("data-keys/common.yml")
        Files.writeString(
            path,
            Files.readString(path).replaceFirst(
                "formatter: itemerness:key-message",
                "formatter: itemerness:integer",
            ),
            Charsets.UTF_8,
        )

        val update = manager.reload()

        assertTrue(update is RuntimeCatalogUpdate.Rejected)
        assertSame(before, manager.snapshot())
        assertTrue(
            update.diagnostics.any { diagnostic ->
                diagnostic.path == "data-keys.example:quality.placeholder-api.formatter" &&
                    diagnostic.message.contains("namespaced-key")
            },
            update.diagnostics.toString(),
        )
    }

    @Test
    fun `owner-only read policy cannot publish without a runtime ownership resolver`() {
        installBundledDomain()
        val path = directory.resolve("data-keys/common.yml")
        Files.writeString(
            path,
            Files.readString(path).replaceFirst("read: internal", "read: owner-only"),
            Charsets.UTF_8,
        )

        val update = RuntimeCatalogManager(directory, "26.1.2").reload()

        assertTrue(update is RuntimeCatalogUpdate.Rejected)
        assertTrue(
            update.diagnostics.any { diagnostic ->
                diagnostic.path.endsWith("access.read") && diagnostic.message.contains("ownership resolver")
            },
            update.diagnostics.toString(),
        )
    }

    @Test
    fun `complex values cannot be declared as PDC fallbacks`() {
        installBundledDomain()
        val path = directory.resolve("data-keys/common.yml")
        val source = Files.readString(path)
        val metadata = source.indexOf("  example:metadata:")
        require(metadata >= 0)
        Files.writeString(
            path,
            source.substring(0, metadata) + source.substring(metadata).replaceFirst(
                "    read-sources:\n      - canonical-nbt",
                "    read-sources:\n      - canonical-nbt\n      - pdc:\n          key: legacyitems:metadata\n" +
                    "          mode: fallback-read-only",
            ),
            Charsets.UTF_8,
        )

        val update = RuntimeCatalogManager(directory, "26.1.2").reload()

        assertTrue(update is RuntimeCatalogUpdate.Rejected)
        assertTrue(
            update.diagnostics.any { diagnostic ->
                diagnostic.message.contains("complex data key example:metadata") &&
                    diagnostic.message.contains("not supported")
            },
            update.diagnostics.toString(),
        )
    }

    @Test
    fun `one physical PDC key cannot declare conflicting scalar types`() {
        installBundledDomain()
        val path = directory.resolve("data-keys/common.yml")
        val source = Files.readString(path)
        val attackDamage = source.indexOf("  example:attack-damage:")
        require(attackDamage >= 0)
        Files.writeString(
            path,
            source.substring(0, attackDamage) + source.substring(attackDamage).replaceFirst(
                "    read-sources:\n      - canonical-nbt",
                "    read-sources:\n      - canonical-nbt\n      - pdc:\n" +
                    "          key: legacyitems:quality\n          mode: fallback-read-only",
            ),
            Charsets.UTF_8,
        )

        val update = RuntimeCatalogManager(directory, "26.1.2").reload()

        assertTrue(update is RuntimeCatalogUpdate.Rejected)
        assertTrue(
            update.diagnostics.any { diagnostic ->
                diagnostic.message.contains("Physical PDC key legacyitems:quality") &&
                    diagnostic.message.contains("conflicting scalar types") &&
                    diagnostic.message.contains("decimal") &&
                    diagnostic.message.contains("namespaced-key")
            },
            update.diagnostics.toString(),
        )
    }

    @Test
    fun `configured presentation defaults must resolve even when every item is explicit`() {
        installBundledDomain()
        val config = directory.resolve("config.yml")
        Files.writeString(
            config,
            Files.readString(config).replace(
                "default-theme: itemerness:default",
                "default-theme: itemerness:missing",
            ),
            Charsets.UTF_8,
        )

        val update = RuntimeCatalogManager(directory, "26.1.2").reload()

        assertTrue(update is RuntimeCatalogUpdate.Rejected)
        assertTrue(
            update.diagnostics.any { diagnostic ->
                diagnostic.path == "config.presentation.default-theme" &&
                    diagnostic.message.contains("itemerness:missing")
            },
            update.diagnostics.toString(),
        )
    }

    @Test
    fun `a valid cross-domain update publishes one new complete snapshot`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)
        val before = manager.snapshot()
        rewriteItems { source -> source.replaceFirst("enabled: false", "enabled: true") }

        val update = manager.reload()

        assertTrue(update is RuntimeCatalogUpdate.Published, update.diagnostics.toString())
        val published = update as RuntimeCatalogUpdate.Published
        assertNotSame(before, manager.snapshot())
        assertSame(published.active, manager.snapshot())
        assertEquals(2, published.active.domain.revision)
        assertEquals(published.active.domain.revision, published.active.presentation.revision)
        assertTrue(published.active.domain.findItem(com.iroselle.itemerness.api.ItemKey.parse("itemerness:travel-token")) != null)
        assertTrue(published.active.presentation.items.containsKey(com.iroselle.itemerness.api.ItemKey.parse("itemerness:travel-token")))
    }

    @Test
    fun `failed downstream commit rolls back before the api catalog can advance`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)
        val before = requireNotNull(manager.snapshot())
        rewriteItems { source -> source.replaceFirst("enabled: false", "enabled: true") }
        val prepared = manager.prepareReload() as RuntimeCatalogUpdate.Prepared
        var projectedRevision = before.domain.revision

        val update = manager.publish(
            prepared,
            RuntimeCatalogPublication { candidate ->
                object : PreparedRuntimeCatalogPublication {
                    override fun commit() {
                        projectedRevision = candidate.domain.revision
                        error("deterministic downstream failure")
                    }

                    override fun rollback() {
                        projectedRevision = before.domain.revision
                    }
                }
            },
        )

        assertTrue(update is RuntimeCatalogUpdate.PublicationFailed)
        assertSame(before, manager.snapshot())
        assertSame(before, update.active)
        assertEquals(1, manager.catalogRevision)
        assertEquals(1, projectedRevision)
    }

    @Test
    fun `nonfatal error after projection commit rolls back and leaves the revision reusable`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val projection = ProjectionStateStore()
        fun publication(commitFailure: Throwable? = null) = RuntimeCatalogPublication { candidate ->
            val preparedProjection = projection.prepareCatalog(candidate, candidate.presentation)
            object : PreparedRuntimeCatalogPublication {
                override fun commit() {
                    preparedProjection.commit()
                    commitFailure?.let { throw it }
                }

                override fun rollback() {
                    preparedProjection.rollback()
                }
            }
        }

        val initial = manager.publish(
            manager.prepareReload() as RuntimeCatalogUpdate.Prepared,
            publication(),
        ) as RuntimeCatalogUpdate.Published
        val failure = LinkageError("incompatible downstream publication")

        val failed = manager.publish(
            manager.prepareReload() as RuntimeCatalogUpdate.Prepared,
            publication(failure),
        ) as RuntimeCatalogUpdate.PublicationFailed

        assertSame(failure, failed.failure)
        assertSame(initial.active, failed.active)
        assertSame(initial.active, manager.snapshot())
        assertEquals(1, manager.catalogRevision)
        assertTrue(projection.catalogHandle(1) != null)
        assertNull(projection.catalogHandle(2))

        val retry = manager.publish(
            manager.prepareReload() as RuntimeCatalogUpdate.Prepared,
            publication(),
        ) as RuntimeCatalogUpdate.Published

        assertEquals(2, retry.active.domain.revision)
        assertSame(retry.active, manager.snapshot())
        assertTrue(projection.catalogHandle(2) != null)
    }

    @Test
    fun `nonfatal preparation error preserves the old snapshot and leaves the revision reusable`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val initial = manager.reload() as RuntimeCatalogUpdate.Published
        val failure = LinkageError("incompatible publication preparation")

        val failed = manager.publish(
            manager.prepareReload() as RuntimeCatalogUpdate.Prepared,
            RuntimeCatalogPublication { throw failure },
        ) as RuntimeCatalogUpdate.PublicationFailed

        assertSame(failure, failed.failure)
        assertSame(initial.active, failed.active)
        assertSame(initial.active, manager.snapshot())

        val retry = manager.reload() as RuntimeCatalogUpdate.Published
        assertEquals(2, retry.active.domain.revision)
    }

    @Test
    fun `nonfatal rollback error is reported only after downstream state is restored`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val initial = manager.reload() as RuntimeCatalogUpdate.Published
        val commitFailure = IllegalStateException("downstream commit failed")
        val rollbackFailure = LinkageError("rollback observer failed")
        var downstreamRevision = initial.active.domain.revision

        val failed = manager.publish(
            manager.prepareReload() as RuntimeCatalogUpdate.Prepared,
            RuntimeCatalogPublication { candidate ->
                object : PreparedRuntimeCatalogPublication {
                    override fun commit() {
                        downstreamRevision = candidate.domain.revision
                        throw commitFailure
                    }

                    override fun rollback() {
                        downstreamRevision = initial.active.domain.revision
                        throw rollbackFailure
                    }
                }
            },
        ) as RuntimeCatalogUpdate.PublicationFailed

        assertSame(commitFailure, failed.failure)
        assertSame(rollbackFailure, failed.failure.suppressed.single())
        assertSame(initial.active, manager.snapshot())
        assertEquals(initial.active.domain.revision, downstreamRevision)
    }

    @Test
    fun `fatal commit error is rethrown only after downstream rollback`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        val initial = manager.reload() as RuntimeCatalogUpdate.Published
        val fatal = object : VirtualMachineError("fatal downstream commit") {}
        var downstreamRevision = initial.active.domain.revision

        val thrown = assertThrows(VirtualMachineError::class.java) {
            manager.publish(
                manager.prepareReload() as RuntimeCatalogUpdate.Prepared,
                RuntimeCatalogPublication { candidate ->
                    object : PreparedRuntimeCatalogPublication {
                        override fun commit() {
                            downstreamRevision = candidate.domain.revision
                            throw fatal
                        }

                        override fun rollback() {
                            downstreamRevision = initial.active.domain.revision
                        }
                    }
                },
            )
        }

        assertSame(fatal, thrown)
        assertSame(initial.active, manager.snapshot())
        assertEquals(initial.active.domain.revision, downstreamRevision)
    }

    @Test
    fun `post-commit nonfatal listener error reports a warning without splitting revisions`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)
        val prepared = manager.prepareReload() as RuntimeCatalogUpdate.Prepared
        var projectedRevision = 1L

        val update = manager.publish(
            prepared,
            RuntimeCatalogPublication { candidate ->
                object : PreparedRuntimeCatalogPublication {
                    override fun commit() {
                        projectedRevision = candidate.domain.revision
                    }

                    override fun rollback() {
                        projectedRevision = 1
                    }

                    override fun complete() {
                        throw LinkageError("listener failed after commit")
                    }
                }
            },
        ) as RuntimeCatalogUpdate.Published

        assertEquals(2, update.active.domain.revision)
        assertEquals(2, manager.catalogRevision)
        assertEquals(2, projectedRevision)
        assertEquals(1, update.completionFailures.size)
    }

    @Test
    fun `a prepared reload is a one-shot publication token`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)
        val prepared = manager.prepareReload() as RuntimeCatalogUpdate.Prepared

        val first = manager.publish(prepared)
        val replay = manager.publish(prepared)

        assertTrue(first is RuntimeCatalogUpdate.Published)
        assertTrue(replay is RuntimeCatalogUpdate.Superseded)
        assertEquals(2, manager.catalogRevision)
    }

    @Test
    fun `coherent snapshot acquisition cannot mix old runtime with committed downstream state`() {
        installBundledDomain()
        val manager = RuntimeCatalogManager(directory, "26.1.2")
        assertTrue(manager.reload() is RuntimeCatalogUpdate.Published)
        val prepared = manager.prepareReload() as RuntimeCatalogUpdate.Prepared
        val downstreamRevision = AtomicLong(1)
        val downstreamCommitted = CountDownLatch(1)
        val releaseCommit = CountDownLatch(1)
        val readerStarted = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val publication = executor.submit<RuntimeCatalogUpdate> {
                manager.publish(
                    prepared,
                    RuntimeCatalogPublication { candidate ->
                        object : PreparedRuntimeCatalogPublication {
                            override fun commit() {
                                downstreamRevision.set(candidate.domain.revision)
                                downstreamCommitted.countDown()
                                check(releaseCommit.await(5, TimeUnit.SECONDS))
                            }

                            override fun rollback() {
                                downstreamRevision.set(1)
                            }
                        }
                    },
                )
            }
            assertTrue(downstreamCommitted.await(5, TimeUnit.SECONDS))

            val captured = executor.submit<Pair<Long, Long>?> {
                readerStarted.countDown()
                manager.withCurrentSnapshot { runtime ->
                    runtime.domain.revision to downstreamRevision.get()
                }
            }
            assertTrue(readerStarted.await(5, TimeUnit.SECONDS))
            assertFalse(
                captured.isDone,
                "A capture must wait while downstream state is newer than the active runtime",
            )

            releaseCommit.countDown()
            assertTrue(publication.get(5, TimeUnit.SECONDS) is RuntimeCatalogUpdate.Published)
            assertEquals(2L to 2L, captured.get(5, TimeUnit.SECONDS))
        } finally {
            releaseCommit.countDown()
            executor.shutdownNow()
        }
    }

    private fun rewriteItems(transform: (String) -> String) {
        val path = directory.resolve("items/examples.yml")
        Files.writeString(path, transform(Files.readString(path)), Charsets.UTF_8)
    }

    private fun installBundledDomain() {
        copyResource("config.yml")
        val resources = checkNotNull(javaClass.classLoader.getResourceAsStream("itemerness-resources.txt"))
            .bufferedReader(Charsets.UTF_8)
            .useLines { lines ->
                lines.map(String::trim)
                    .filter { it.isNotEmpty() && !it.startsWith('#') }
                    .toList()
            }
        resources.forEach(::copyResource)
    }

    private fun copyResource(path: String) {
        val destination = directory.resolve(path)
        Files.createDirectories(destination.parent)
        checkNotNull(javaClass.classLoader.getResourceAsStream(path)).use { input ->
            Files.copy(input, destination, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

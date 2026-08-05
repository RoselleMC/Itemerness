package com.iroselle.itemerness.projection

import com.iroselle.itemerness.api.ItemKey
import java.util.UUID
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ProjectionContractsTest {
    @Test
    fun `projector receives immutable canonical and viewer input`() {
        val viewer = ViewerProjectionSnapshot(
            viewerId = UUID.fromString("b3efd69a-ef71-4c1e-9e09-927f3d440311"),
            revision = 7,
            locale = LocaleId("en_us"),
            theme = ItemKey.parse("itemerness:default"),
            assetProfile = null,
        )
        val canonical = CanonicalItemSnapshot(
            itemKey = ItemKey.parse("itemerness:ember_blade"),
            materialKey = ItemKey.parse("minecraft:netherite_sword"),
            count = 1,
            pendingName = "[itemerness:ember_blade]",
            createdAgainstRevision = 3,
            dataSchemas = CanonicalDataSchemas(
                listOf(CanonicalDataSchemaVersion(ItemKey.parse("itemerness:common"), 1)),
            ),
            instanceId = null,
            data = ProjectionCompound(),
            fingerprint = CanonicalItemFingerprint(byteArrayOf(1)),
        )
        val expected = RenderedDisplay(
            displayName = RenderedText.plain("Ember Blade"),
            lore = listOf(RenderedText.plain("A canonical projection")),
        )
        val projector = ItemProjector { request ->
            assertEquals(canonical, request.canonical)
            assertEquals(viewer, request.context.viewer)
            ProjectionResult.Rendered(expected)
        }

        val result = projector.project(
            ProjectionRequest(
                canonical = canonical,
                context = ProjectionContext(viewer, ProjectionGeneration(3, 8)),
            ),
        )

        assertEquals(ProjectionResult.Rendered(expected), result)
    }

    @Test
    fun `rendered display defensively copies lore`() {
        val lore = mutableListOf(RenderedText.plain("First line"))
        val display = RenderedDisplay(RenderedText.plain("Name"), lore)

        lore.clear()

        assertEquals(listOf(RenderedText.plain("First line")), display.lore)
    }

    @Test
    fun `rendered text keeps one tooltip line per value`() {
        assertThrows(IllegalArgumentException::class.java) {
            RenderedText.plain("first\nsecond")
        }
    }

    @Test
    fun `rendered output rejects protocol-scale overflow`() {
        assertThrows(IllegalArgumentException::class.java) {
            RenderedText.plain("x".repeat(8_193))
        }
        assertThrows(IllegalArgumentException::class.java) {
            RenderedDisplay(
                displayName = RenderedText.plain("Name"),
                lore = List(257) { RenderedText.plain("line") },
            )
        }
    }

    @Test
    fun `version and generation reject invalid values`() {
        assertThrows(IllegalArgumentException::class.java) { MinecraftVersion("latest") }
        assertThrows(IllegalArgumentException::class.java) { ProjectionGeneration(-1, 0) }
        assertThrows(IllegalArgumentException::class.java) { ProjectionGeneration(0, -1) }
    }
}

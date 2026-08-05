package com.iroselle.itemerness.projection

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ProjectionValueTest {
    @Test
    fun `compound and list values defensively copy their inputs`() {
        val listSource = mutableListOf<ProjectionValue>(StringProjectionValue("rare"))
        val list = ListProjectionValue(listSource)
        val entrySource = mutableListOf(
            ProjectionCompound.Entry("example:quality", list),
        )
        val compound = ProjectionCompound(entrySource)

        listSource += IntegerProjectionValue(2)
        entrySource.clear()

        assertEquals(listOf(StringProjectionValue("rare")), list.values)
        assertEquals(list, compound["example:quality"])
    }

    @Test
    fun `nested compounds support ordinary field names`() {
        val socket = ProjectionCompound(
            listOf(
                ProjectionCompound.Entry("type", StringProjectionValue("ruby")),
                ProjectionCompound.Entry("accepted", BooleanProjectionValue(true)),
                ProjectionCompound.Entry("inserted", IntegerProjectionValue(2)),
            ),
        )
        val root = ProjectionCompound(
            listOf(
                ProjectionCompound.Entry("example:sockets", ListProjectionValue(listOf(socket))),
            ),
        )

        val sockets = root["example:sockets"] as ListProjectionValue
        val projectedSocket = sockets.values.single() as ProjectionCompound

        assertEquals(StringProjectionValue("ruby"), projectedSocket["type"])
        assertEquals(BooleanProjectionValue(true), projectedSocket["accepted"])
        assertEquals(IntegerProjectionValue(2), projectedSocket["inserted"])
    }

    @Test
    fun `compound rejects duplicate keys`() {
        assertThrows(IllegalArgumentException::class.java) {
            ProjectionCompound(
                listOf(
                    ProjectionCompound.Entry("example:quality", StringProjectionValue("rare")),
                    ProjectionCompound.Entry("example:quality", StringProjectionValue("common")),
                ),
            )
        }
    }

    @Test
    fun `compound equality follows map semantics rather than input order`() {
        val first = ProjectionCompound(
            listOf(
                ProjectionCompound.Entry("z", IntegerProjectionValue(1)),
                ProjectionCompound.Entry("a", IntegerProjectionValue(2)),
            ),
        )
        val second = ProjectionCompound(first.entries.reversed())

        assertEquals(first, second)
    }

    @Test
    fun `compound rejects blank oversized and control character keys`() {
        listOf("", "   ", "bad\u0000key", "x".repeat(129)).forEach { key ->
            assertThrows(IllegalArgumentException::class.java) {
                ProjectionCompound.Entry(key, StringProjectionValue("value"))
            }
        }
    }
}

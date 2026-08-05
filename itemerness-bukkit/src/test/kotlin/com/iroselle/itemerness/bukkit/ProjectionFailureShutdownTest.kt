package com.iroselle.itemerness.bukkit

import com.iroselle.itemerness.projection.ProjectionFailure
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ProjectionFailureShutdownTest {
    @Test
    fun `terminal failure schedules exactly one global disable`() {
        var active = true
        var reported = 0
        var disabled = 0
        val tasks = ArrayDeque<() -> Unit>()
        val shutdown = ProjectionFailureShutdown(
            runtimeCurrent = { active },
            scheduleGlobal = { task -> tasks.addLast(task); true },
            report = { reported++ },
            disable = { disabled++ },
        )

        assertTrue(shutdown.offer(failure("first")))
        assertTrue(shutdown.offer(failure("second")))
        assertEquals(1, reported)
        assertEquals(1, tasks.size)

        tasks.removeFirst().invoke()
        assertEquals(1, disabled)
        active = false
        assertFalse(shutdown.offer(failure("retired")))
    }

    @Test
    fun `scheduler rejection stays latched and does not disable inline`() {
        var attempts = 0
        var disabled = 0
        val shutdown = ProjectionFailureShutdown(
            runtimeCurrent = { true },
            scheduleGlobal = { attempts++; false },
            report = {},
            disable = { disabled++ },
        )

        assertFalse(shutdown.offer(failure("rejected")))
        assertFalse(shutdown.offer(failure("duplicate")))
        assertEquals(1, attempts)
        assertEquals(0, disabled)
    }

    @Test
    fun `report linkage failure rejects shutdown without pretending it was scheduled`() {
        var reports = 0
        var schedules = 0
        val shutdown = ProjectionFailureShutdown(
            runtimeCurrent = { true },
            scheduleGlobal = { schedules++; true },
            report = {
                reports++
                throw LinkageError("broken logger boundary")
            },
            disable = {},
        )

        assertFalse(shutdown.offer(failure("report")))
        assertFalse(shutdown.offer(failure("duplicate")))
        assertEquals(1, reports)
        assertEquals(0, schedules)
    }

    @Test
    fun `scheduler linkage failure rejects shutdown and remains latched`() {
        var reports = 0
        var schedules = 0
        val shutdown = ProjectionFailureShutdown(
            runtimeCurrent = { true },
            scheduleGlobal = {
                schedules++
                throw LinkageError("broken scheduler boundary")
            },
            report = { reports++ },
            disable = {},
        )

        assertFalse(shutdown.offer(failure("schedule")))
        assertFalse(shutdown.offer(failure("duplicate")))
        assertEquals(1, reports)
        assertEquals(1, schedules)
    }

    private fun failure(operation: String) = ProjectionFailure(operation, IllegalStateException(operation))
}

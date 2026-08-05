package com.iroselle.itemerness.bukkit

import com.iroselle.itemerness.projection.ProjectionFailure
import com.iroselle.itemerness.projection.ProjectionFailureSink
import java.util.concurrent.atomic.AtomicReference

/** Moves a terminal adapter callback onto the platform global lifecycle context exactly once. */
internal class ProjectionFailureShutdown(
    private val runtimeCurrent: () -> Boolean,
    private val scheduleGlobal: (() -> Unit) -> Boolean,
    private val report: (ProjectionFailure) -> Unit,
    private val disable: () -> Unit,
) : ProjectionFailureSink {
    private val state = AtomicReference(State.NEW)

    override fun offer(failure: ProjectionFailure): Boolean {
        if (!runtimeCurrent()) return false
        if (!state.compareAndSet(State.NEW, State.SCHEDULING)) {
            // SCHEDULING is not success: report or scheduler publication can still fail. A
            // concurrent caller may only observe true after the global task was actually accepted.
            return state.get() == State.SCHEDULED
        }

        try {
            report(failure)
        } catch (reportFailure: Throwable) {
            state.set(State.REJECTED)
            reportFailure.rethrowIfFatalShutdownFailure()
            return false
        }
        val scheduled = try {
            scheduleGlobal {
                if (runtimeCurrent()) disable()
            }
        } catch (scheduleFailure: Throwable) {
            state.set(State.REJECTED)
            scheduleFailure.rethrowIfFatalShutdownFailure()
            false
        }
        // A rejection cannot make the adapter healthy again. Keep the latch set so concurrent
        // event loops cannot create an unbounded retry storm while the adapter remains poisoned.
        state.set(if (scheduled) State.SCHEDULED else State.REJECTED)
        return scheduled
    }

    private enum class State { NEW, SCHEDULING, SCHEDULED, REJECTED }
}

@Suppress("DEPRECATION")
private fun Throwable.rethrowIfFatalShutdownFailure() {
    when (this) {
        is VirtualMachineError -> throw this
        is ThreadDeath -> throw this
    }
}

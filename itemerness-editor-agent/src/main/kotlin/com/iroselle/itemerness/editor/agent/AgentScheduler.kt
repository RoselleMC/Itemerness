package com.iroselle.itemerness.editor.agent

/** Platform-owned asynchronous scheduling used by the agent state machine. */
interface AgentScheduler {
    fun execute(action: () -> Unit): Boolean

    fun schedule(delayMillis: Long, action: () -> Unit): AgentTask?

    fun repeat(initialDelayMillis: Long, periodMillis: Long, action: () -> Unit): AgentTask?
}

fun interface AgentTask {
    fun cancel()
}

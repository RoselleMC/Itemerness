package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.bukkit.FoliaScheduler
import com.iroselle.itemerness.editor.agent.AgentScheduler
import com.iroselle.itemerness.editor.agent.AgentTask
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

internal class FoliaAgentScheduler(
    private val scheduler: FoliaScheduler,
) : AgentScheduler {
    override fun execute(action: () -> Unit): Boolean = scheduler.tryRunAsync(action)

    override fun schedule(delayMillis: Long, action: () -> Unit): AgentTask? =
        scheduler.tryRunAsyncDelayed(delayMillis, action)?.let { task -> AgentTask(task::cancel) }

    override fun repeat(initialDelayMillis: Long, periodMillis: Long, action: () -> Unit): AgentTask? =
        scheduler.tryRepeatAsync(initialDelayMillis, periodMillis, action)?.let { task -> AgentTask(task::cancel) }
}

internal class FoliaAsyncExecutor(
    private val scheduler: FoliaScheduler,
) : Executor {
    override fun execute(command: Runnable) {
        if (!scheduler.tryRunAsync(command::run)) {
            throw RejectedExecutionException("Itemerness async scheduler rejected editor work")
        }
    }
}

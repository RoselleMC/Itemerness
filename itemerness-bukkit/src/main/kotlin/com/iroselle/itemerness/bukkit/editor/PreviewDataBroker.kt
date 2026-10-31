package com.iroselle.itemerness.bukkit.editor

import com.iroselle.itemerness.api.ApiCallResult
import com.iroselle.itemerness.api.ApiDenialReason
import com.iroselle.itemerness.api.DataKey
import com.iroselle.itemerness.api.ItemDataValue
import com.iroselle.itemerness.api.ItemDefinition
import com.iroselle.itemerness.api.PreviewDataRequest
import com.iroselle.itemerness.api.PreviewItem
import com.iroselle.itemerness.bukkit.access.AccessPolicy
import com.iroselle.itemerness.bukkit.access.DataAccessAuthorizer
import com.iroselle.itemerness.bukkit.access.DataAccessRuleIndex
import com.iroselle.itemerness.bukkit.api.PreviewProviderRegistry
import com.iroselle.itemerness.bukkit.catalog.LoadedCatalogSource
import com.iroselle.itemerness.core.catalog.DataScope
import com.iroselle.itemerness.editor.agent.PreviewDataItem
import com.iroselle.itemerness.editor.agent.PreviewDataSource
import com.iroselle.itemerness.editor.agent.PreviewParameters
import com.iroselle.itemerness.editor.agent.ProvidedPreviewData
import com.iroselle.itemerness.editor.agent.ProviderScenarios
import com.iroselle.itemerness.editor.agent.ScenarioSelection
import org.bukkit.plugin.Plugin
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ExecutionException
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

/**
 * Calls registered preview data providers for editor previews.
 *
 * Provider code is third-party code, so it runs on its own small pool with a deadline rather than
 * on the API worker, and its output is checked with the same data key rules as `editDomainInstance`:
 * the draft's `access.write` must name the provider's plugin and `access.yml` must grant `edit-data`.
 * Nothing here touches Bukkit world state; the only Bukkit type is the owning plugin identity used
 * for `internal` keys.
 */
internal class PreviewDataBroker(
    private val ownerPlugin: Plugin,
    private val registry: PreviewProviderRegistry,
    private val accessPolicy: () -> AccessPolicy,
    private val timeoutMillis: Long = TIMEOUT_MILLIS,
) : PreviewDataSource, AutoCloseable {
    private val threads = AtomicInteger()
    private val executor = ThreadPoolExecutor(WORKERS, WORKERS, 30, TimeUnit.SECONDS, ArrayBlockingQueue(QUEUE)) { task ->
        Thread(task, "Itemerness preview provider ${threads.incrementAndGet()}").apply { isDaemon = true }
    }.apply { allowCoreThreadTimeOut(true) }

    private class Failure(val code: String, detail: String) : RuntimeException(detail)

    override fun scenarios(item: PreviewDataItem): List<ProviderScenarios> {
        val rules = rules(item) ?: return registry.active().map {
            ProviderScenarios.Failed(it.caller.pluginName, "ACCESS_RULES_UNAVAILABLE", ACCESS_RULES_DETAIL)
        }
        return registry.active().map { entry ->
            try {
                val (revision, scenarios) = call { entry.provider.revision to entry.provider.scenarios(view(item, entry, rules)) }
                require(revision.isNotBlank() && revision.length <= 256) { "The provider revision must be 1-256 characters" }
                ProviderScenarios.Offered(entry.caller.pluginName, revision, scenarios.take(MAX_SCENARIOS))
            } catch (failure: Failure) {
                ProviderScenarios.Failed(entry.caller.pluginName, failure.code, failure.message.orEmpty())
            } catch (failure: IllegalArgumentException) {
                ProviderScenarios.Failed(entry.caller.pluginName, "FAILED", failure.message.orEmpty())
            }
        }
    }

    override fun provide(item: PreviewDataItem, selection: ScenarioSelection): ProvidedPreviewData {
        fun failed(code: String, detail: String, revision: String? = null) =
            ProvidedPreviewData.Failed(selection.plugin, selection.scenario, revision, code, detail)
        val entry = registry.find(selection.plugin)
            ?: return failed("PROVIDER_UNAVAILABLE", "${selection.plugin} has no active preview data provider")
        val rules = rules(item) ?: return failed("ACCESS_RULES_UNAVAILABLE", ACCESS_RULES_DETAIL)
        var revision: String? = null
        val result = try {
            call {
                revision = entry.provider.revision
                val view = view(item, entry, rules)
                val scenario = entry.provider.scenarios(view).firstOrNull { it.id == selection.scenario }
                    ?: throw Failure("SCENARIO_UNKNOWN", "${selection.plugin} does not offer scenario ${selection.scenario} for this item")
                val parameters = try {
                    PreviewParameters.decode(scenario.parameters, selection.parameters)
                } catch (invalid: IllegalArgumentException) {
                    throw Failure("PARAMETERS_INVALID", invalid.message.orEmpty())
                }
                entry.provider.provide(PreviewDataRequest(view, scenario.id, parameters, item.locale))
            }
        } catch (failure: Failure) {
            return failed(failure.code, failure.message.orEmpty(), revision)
        }
        if (result.values.size > PreviewParameters.MAXIMUM_VALUES) {
            return failed("OUTPUT_TOO_LARGE", "The provider returned ${result.values.size} values; at most ${PreviewParameters.MAXIMUM_VALUES} are accepted", revision)
        }
        val authorizer = DataAccessAuthorizer(ownerPlugin, accessPolicy(), rules)
        result.values.keys.forEach { key ->
            val decision = authorizer.authorizeInstanceWrite(entry.caller, item.itemKey, key)
            if (decision is ApiCallResult.Denied) return failed("KEY_NOT_WRITABLE", "$key: ${decision.detail}", revision)
        }
        return ProvidedPreviewData.Applied(selection.plugin, selection.scenario, checkNotNull(revision), result.values, result.messages)
    }

    /** Access rules come from the draft, so a key added in the editor is judged by its draft declaration. */
    private fun rules(item: PreviewDataItem): DataAccessRuleIndex? = try {
        DataAccessRuleIndex.from(LoadedCatalogSource(item.decoded.catalog, item.decoded.runtimeIntegrations(), emptyMap()))
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun view(item: PreviewDataItem, entry: PreviewProviderRegistry.Entry, rules: DataAccessRuleIndex): PreviewItem {
        val authorizer = DataAccessAuthorizer(ownerPlugin, accessPolicy(), rules)
        return object : PreviewItem {
            override val definition: ItemDefinition = item.definition

            override fun readData(key: DataKey): ApiCallResult<ItemDataValue?> {
                val decision = authorizer.authorizeRead(entry.caller, item.itemKey, key)
                if (decision is ApiCallResult.Denied) return decision
                if (rules[key]?.scope != DataScope.DEFINITION) {
                    return ApiCallResult.Denied(ApiDenialReason.DATA_KEY_READ_DENIED, "Preview providers read definition-scope data only")
                }
                return ApiCallResult.Success(item.definitionData[key])
            }
        }
    }

    private fun <T> call(action: () -> T): T {
        val future = try {
            executor.submit<T>(action)
        } catch (_: RejectedExecutionException) {
            throw Failure("PROVIDER_BUSY", "Preview providers are busy; try again")
        }
        return try {
            future.get(timeoutMillis, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            future.cancel(true)
            throw Failure("TIMEOUT", "The provider did not answer within $timeoutMillis ms")
        } catch (failure: ExecutionException) {
            val cause = failure.cause ?: failure
            if (cause is VirtualMachineError) throw cause
            if (cause is Failure) throw cause
            // Only the type and message cross the boundary; stack traces stay out of the editor.
            throw Failure("FAILED", "${cause.javaClass.simpleName}: ${cause.message.orEmpty()}".take(512))
        } catch (_: InterruptedException) {
            future.cancel(true)
            Thread.currentThread().interrupt()
            throw Failure("FAILED", "The preview request was interrupted")
        }
    }

    override fun close() {
        executor.shutdownNow()
    }

    private companion object {
        const val TIMEOUT_MILLIS = 250L
        const val WORKERS = 2
        const val QUEUE = 8
        const val MAX_SCENARIOS = 32
        const val ACCESS_RULES_DETAIL = "Preview providers need data key access rules; upgrade the document to format 2"
    }
}

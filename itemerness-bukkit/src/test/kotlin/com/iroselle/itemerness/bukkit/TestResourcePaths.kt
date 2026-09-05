package com.iroselle.itemerness.bukkit

/** Protocol fixtures intentionally excluded from Itemerness's production first-run resources. */
internal object TestResourcePaths {
    private val REPLACED_PRODUCTION_RESOURCES = setOf(
        "data-keys/storage.yml",
        "viewer-facts/runtime.yml",
    )

    val FIXTURES = listOf(
        "data-keys/common.yml",
        "viewer-facts/common.yml",
        "items/examples.yml",
    )

    fun withProduction(resources: List<String>): List<String> =
        resources.filterNot(REPLACED_PRODUCTION_RESOURCES::contains) + FIXTURES
}

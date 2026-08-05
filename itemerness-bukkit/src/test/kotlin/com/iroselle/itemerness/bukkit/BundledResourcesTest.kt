package com.iroselle.itemerness.bukkit

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class BundledResourcesTest {
    @TempDir
    lateinit var directory: Path

    @Test
    fun `installs new paths without reviving a recorded deletion`() {
        val copied = mutableListOf<String>()
        val copy: (String) -> Unit = { path ->
            val destination = directory.resolve(path)
            Files.createDirectories(destination.parent)
            Files.writeString(destination, path)
            copied += path
        }
        val exists: (String) -> Boolean = { path -> Files.exists(directory.resolve(path)) }

        var state = BundledResources.installIndexedResources(
            paths = listOf("themes/default.yml", "examples/item.yml"),
            recorded = emptySet(),
            exists = exists,
            copy = copy,
        )
        assertEquals(listOf("themes/default.yml", "examples/item.yml"), copied)

        Files.delete(directory.resolve("examples/item.yml"))
        copied.clear()
        state = BundledResources.installIndexedResources(
            paths = listOf("themes/default.yml", "examples/item.yml", "layouts/new.yml"),
            recorded = state,
            exists = exists,
            copy = copy,
        )

        assertEquals(listOf("layouts/new.yml"), copied)
        assertFalse(Files.exists(directory.resolve("examples/item.yml")))
        assertTrue(Files.exists(directory.resolve("layouts/new.yml")))
        assertEquals(
            setOf("themes/default.yml", "examples/item.yml", "layouts/new.yml"),
            state,
        )
    }

    @Test
    fun `records a pre-existing path without overwriting it`() {
        val path = directory.resolve("locales/en_us.yml")
        Files.createDirectories(path.parent)
        Files.writeString(path, "user content")
        val copied = mutableListOf<String>()

        val state = BundledResources.installIndexedResources(
            paths = listOf("locales/en_us.yml"),
            recorded = emptySet(),
            exists = { resource -> Files.exists(directory.resolve(resource)) },
            copy = copied::add,
        )

        assertTrue(copied.isEmpty())
        assertEquals("user content", Files.readString(path))
        assertEquals(setOf("locales/en_us.yml"), state)
    }
}

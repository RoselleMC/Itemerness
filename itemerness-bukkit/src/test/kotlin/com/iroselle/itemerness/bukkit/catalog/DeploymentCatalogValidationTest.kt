package com.iroselle.itemerness.bukkit.catalog

import com.iroselle.itemerness.api.ItemKey
import com.iroselle.itemerness.bukkit.presentation.BuiltinFontMetricsLoader
import com.iroselle.itemerness.bukkit.presentation.PresentationSourceLoader
import com.iroselle.itemerness.core.catalog.CatalogCompiler
import java.nio.file.Path
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertAll

class DeploymentCatalogValidationTest {
    @Test
    fun `external deployment directory compiles when configured`() {
        val configuredRoot = System.getProperty("itemerness.validationRoot").orEmpty()
        assumeTrue(configuredRoot.isNotBlank(), "No external Itemerness deployment directory was configured")

        val root = Path.of(configuredRoot)
        val catalog = CatalogSourceLoader().load(root)
        val catalogCompilation = CatalogCompiler().compile(catalog.source)
        val presentation = PresentationSourceLoader(
            BuiltinFontMetricsLoader.bundled(
                System.getProperty("itemerness.validationMinecraftVersion", "1.21.11"),
            ),
        ).loadAndCompile(
            root = root,
            catalog = catalog,
            defaultLocale = System.getProperty("itemerness.validationLocale", "en_us"),
            defaultLayout = ItemKey.parse(
                System.getProperty("itemerness.validationLayout", "itemerness:plain"),
            ),
            defaultTheme = ItemKey.parse(
                System.getProperty("itemerness.validationTheme", "itemerness:default"),
            ),
        )

        assertAll(
            {
                assertTrue(
                    catalogCompilation.successful,
                    catalogCompilation.diagnostics.joinToString(),
                )
            },
            {
                assertTrue(
                    presentation.compilation.successful,
                    presentation.compilation.diagnostics.joinToString(),
                )
            },
        )
    }
}

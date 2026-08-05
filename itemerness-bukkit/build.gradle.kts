import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar
import java.util.jar.JarFile

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.shadow)
}

val minecraftApiVersion = libs.versions.paper.get().substringBefore(".build.")

dependencies {
    implementation(project(":itemerness-core"))
    implementation(libs.kotlin.stdlib)
    compileOnly(libs.paper.api)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.snakeyaml)
    testRuntimeOnly(libs.junit.platform.launcher)
}

kotlin {
    val mainSources = sourceSets.getByName("main").kotlin.srcDirs

    target.compilations.create("foliaCompatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(libs.kotlin.stdlib)
                compileOnly(libs.folia.api)
            }
        }
    }

    target.compilations.create("canvasCompatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(libs.kotlin.stdlib)
                compileOnly(libs.canvas.api)
            }
        }
    }
}

sourceSets.named("foliaCompatibility") {
    java.srcDir("src/main/java")
}

sourceSets.named("canvasCompatibility") {
    java.srcDir("src/main/java")
}

tasks.processResources {
    val properties = mapOf(
        "version" to project.version.toString(),
        "apiVersion" to minecraftApiVersion,
    )

    inputs.properties(properties)
    filteringCharset = "UTF-8"

    filesMatching("plugin.yml") {
        expand(properties)
    }
}

tasks.jar {
    enabled = false
}

tasks.named<ShadowJar>("shadowJar") {
    archiveFileName.set("Itemerness.jar")
    archiveClassifier.set("")
    mergeServiceFiles()
}

val checkFoliaUnsafeScheduling by tasks.registering {
    group = "verification"
    description = "Rejects scheduling APIs that assume one Bukkit main thread."

    val sourceFiles = files(
        fileTree("src/main/kotlin") {
            include("**/*.kt")
        },
        fileTree("src/main/java") {
            include("**/*.java")
        },
    )
    inputs.files(sourceFiles)

    doLast {
        val forbidden = listOf(
            "org.bukkit.scheduler",
            "Bukkit.getScheduler(",
            "Bukkit.getScheduler()",
            ".getScheduler().runTask",
            ".scheduler.runTask",
        )
        val violations = sourceFiles.files.flatMap { source ->
            val relativePath = source.relativeTo(projectDir).invariantSeparatorsPath
            source.readLines().flatMapIndexed { index, line ->
                forbidden.filter(line::contains).map { token ->
                    "$relativePath:${index + 1}: forbidden '$token'"
                }
            }
        }
        check(violations.isEmpty()) {
            "Legacy scheduler usage is incompatible with Folia/Canvas:\n${violations.joinToString("\n")}"
        }
    }
}

val verifyPluginJar by tasks.registering {
    group = "verification"
    description = "Checks the deployable JAR and expanded plugin metadata."
    dependsOn(tasks.named("shadowJar"))

    val pluginJar = tasks.named<ShadowJar>("shadowJar").flatMap { it.archiveFile }
    inputs.file(pluginJar)

    doLast {
        JarFile(pluginJar.get().asFile).use { jar ->
            val metadataEntry = checkNotNull(jar.getJarEntry("plugin.yml")) {
                "Itemerness.jar does not contain plugin.yml"
            }
            val metadata = jar.getInputStream(metadataEntry).bufferedReader(Charsets.UTF_8).use { it.readText() }

            check("folia-supported: true" in metadata) {
                "plugin.yml must declare folia-supported: true"
            }
            check("api-version: '$minecraftApiVersion'" in metadata) {
                "plugin.yml must target the configured common platform line"
            }
            check("${'$'}{" !in metadata) {
                "plugin.yml contains an unexpanded Gradle placeholder"
            }
            check(jar.getJarEntry("com/iroselle/itemerness/bukkit/ItemernessPlugin.class") != null) {
                "Itemerness.jar does not contain the Bukkit entrypoint"
            }
            check(jar.getJarEntry("com/iroselle/itemerness/api/ItemernessApi.class") != null) {
                "Itemerness.jar does not contain the public API"
            }
            check(jar.getJarEntry("config.yml") != null) {
                "Itemerness.jar does not contain the default user configuration"
            }
            val resourceIndex = checkNotNull(jar.getJarEntry("itemerness-resources.txt")) {
                "Itemerness.jar does not contain the bundled resource index"
            }
            val resourcePaths = jar.getInputStream(resourceIndex)
                .bufferedReader(Charsets.UTF_8)
                .use { reader ->
                    reader.readLines()
                        .map(String::trim)
                        .filter { it.isNotEmpty() && !it.startsWith("#") }
                }
            resourcePaths.forEach { path ->
                check(jar.getJarEntry(path) != null) {
                    "Itemerness.jar does not contain bundled resource: $path"
                }
            }
            check(jar.getJarEntry("META-INF/itemerness/nms/26.1.2/surfaces.yml") != null) {
                "Itemerness.jar does not contain the NMS coverage manifest"
            }
        }
    }
}

tasks.check {
    dependsOn(
        "foliaCompatibilityClasses",
        "canvasCompatibilityClasses",
        checkFoliaUnsafeScheduling,
        verifyPluginJar,
    )
}

tasks.assemble {
    dependsOn(tasks.named("shadowJar"))
}

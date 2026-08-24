import com.github.jengelman.gradle.plugins.shadow.tasks.ShadowJar
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.util.jar.JarFile

fun readBooleanClassConstant(classBytes: ByteArray, fieldName: String): Boolean {
    DataInputStream(ByteArrayInputStream(classBytes)).use { input ->
        check(input.readInt() == 0xCAFEBABE.toInt()) { "Invalid JVM class file" }
        input.readUnsignedShort()
        input.readUnsignedShort()
        val constants = arrayOfNulls<Any>(input.readUnsignedShort())
        var index = 1
        while (index < constants.size) {
            when (val tag = input.readUnsignedByte()) {
                1 -> constants[index] = input.readUTF()
                3 -> constants[index] = input.readInt()
                4 -> input.readInt()
                5, 6 -> {
                    input.readLong()
                    index++
                }
                7, 8, 16, 19, 20 -> input.readUnsignedShort()
                9, 10, 11, 12, 17, 18 -> {
                    input.readUnsignedShort()
                    input.readUnsignedShort()
                }
                15 -> {
                    input.readUnsignedByte()
                    input.readUnsignedShort()
                }
                else -> error("Unsupported JVM constant-pool tag: $tag")
            }
            index++
        }
        input.readUnsignedShort()
        input.readUnsignedShort()
        input.readUnsignedShort()
        repeat(input.readUnsignedShort()) { input.readUnsignedShort() }
        repeat(input.readUnsignedShort()) {
            input.readUnsignedShort()
            val name = constants[input.readUnsignedShort()] as String
            input.readUnsignedShort()
            repeat(input.readUnsignedShort()) {
                val attributeName = constants[input.readUnsignedShort()] as String
                val length = input.readInt()
                if (name == fieldName && attributeName == "ConstantValue") {
                    check(length == 2) { "Malformed ConstantValue attribute for $fieldName" }
                    return (constants[input.readUnsignedShort()] as Int) != 0
                }
                input.skipNBytes(length.toLong())
            }
        }
    }
    error("Missing boolean class constant: $fieldName")
}

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.shadow)
}

val minecraftApiVersion = "1.21.11"
val exactNmsAdapters = linkedMapOf(
    "1.21.11" to "1_21_11",
    "26.1.1" to "26_1_1",
    "26.1.2" to "26_1_2",
    "26.2" to "26_2",
)

dependencies {
    implementation(project(":itemerness-core"))
    implementation(project(":itemerness-projection-spi"))
    implementation(project(":itemerness-bukkit-spi"))
    implementation(project(":itemerness-editor-agent"))
    runtimeOnly(project(":itemerness-nms-1_21_11"))
    runtimeOnly(project(":itemerness-nms-26_1_1"))
    runtimeOnly(project(":itemerness-nms-26_1_2"))
    runtimeOnly(project(":itemerness-nms-26_2"))
    implementation(libs.kotlin.stdlib)
    implementation(libs.snakeyaml)
    compileOnly(libs.paper.api)
    compileOnly(libs.placeholderapi)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.snakeyaml)
    testImplementation(libs.paper.api)
    testRuntimeOnly(libs.junit.platform.launcher)
}

kotlin {
    val mainSources = sourceSets.getByName("main").kotlin.srcDirs

    target.compilations.create("foliaCompatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(project(":itemerness-projection-spi"))
                implementation(project(":itemerness-bukkit-spi"))
                implementation(project(":itemerness-editor-agent"))
                implementation(libs.kotlin.stdlib)
                implementation(libs.snakeyaml)
                compileOnly(libs.folia.api)
                compileOnly(libs.placeholderapi)
            }
        }
    }

    target.compilations.create("canvasCompatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(project(":itemerness-projection-spi"))
                implementation(project(":itemerness-bukkit-spi"))
                implementation(project(":itemerness-editor-agent"))
                implementation(libs.kotlin.stdlib)
                implementation(libs.snakeyaml)
                compileOnly(libs.canvas.api)
                compileOnly(libs.placeholderapi)
            }
        }
    }

    target.compilations.create("paper2612Compatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(project(":itemerness-projection-spi"))
                implementation(project(":itemerness-bukkit-spi"))
                implementation(project(":itemerness-editor-agent"))
                implementation(libs.kotlin.stdlib)
                implementation(libs.snakeyaml)
                compileOnly(libs.paper2612.api)
                compileOnly(libs.placeholderapi)
            }
        }
    }

    target.compilations.create("paper2611Compatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(project(":itemerness-projection-spi"))
                implementation(project(":itemerness-bukkit-spi"))
                implementation(project(":itemerness-editor-agent"))
                implementation(libs.kotlin.stdlib)
                implementation(libs.snakeyaml)
                compileOnly(libs.paper2611.api)
                compileOnly(libs.placeholderapi)
            }
        }
    }

    target.compilations.create("folia2612Compatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(project(":itemerness-projection-spi"))
                implementation(project(":itemerness-bukkit-spi"))
                implementation(project(":itemerness-editor-agent"))
                implementation(libs.kotlin.stdlib)
                implementation(libs.snakeyaml)
                compileOnly(libs.folia2612.api)
                compileOnly(libs.placeholderapi)
            }
        }
    }

    target.compilations.create("canvas2612Compatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(project(":itemerness-projection-spi"))
                implementation(project(":itemerness-bukkit-spi"))
                implementation(project(":itemerness-editor-agent"))
                implementation(libs.kotlin.stdlib)
                implementation(libs.snakeyaml)
                compileOnly(libs.canvas2612.api)
                compileOnly(libs.placeholderapi)
            }
        }
    }

    target.compilations.create("paper262Compatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(project(":itemerness-projection-spi"))
                implementation(project(":itemerness-bukkit-spi"))
                implementation(project(":itemerness-editor-agent"))
                implementation(libs.kotlin.stdlib)
                implementation(libs.snakeyaml)
                compileOnly(libs.paper262.api)
                compileOnly(libs.placeholderapi)
            }
        }
    }

    target.compilations.create("folia262Compatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(project(":itemerness-projection-spi"))
                implementation(project(":itemerness-bukkit-spi"))
                implementation(project(":itemerness-editor-agent"))
                implementation(libs.kotlin.stdlib)
                implementation(libs.snakeyaml)
                compileOnly(libs.folia262.api)
                compileOnly(libs.placeholderapi)
            }
        }
    }

    target.compilations.create("canvas262Compatibility") {
        defaultSourceSet {
            kotlin.srcDirs(mainSources)
            dependencies {
                implementation(project(":itemerness-core"))
                implementation(project(":itemerness-projection-spi"))
                implementation(project(":itemerness-bukkit-spi"))
                implementation(project(":itemerness-editor-agent"))
                implementation(libs.kotlin.stdlib)
                implementation(libs.snakeyaml)
                compileOnly(libs.canvas262.api)
                compileOnly(libs.placeholderapi)
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

listOf(
    "paper2611Compatibility",
    "paper2612Compatibility",
    "folia2612Compatibility",
    "canvas2612Compatibility",
    "paper262Compatibility",
    "folia262Compatibility",
    "canvas262Compatibility",
).forEach { sourceSetName ->
    sourceSets.named(sourceSetName) {
        java.srcDir("src/main/java")
    }
}

configurations.configureEach {
    if (
        isCanBeResolved &&
        (name.contains("2611Compatibility") || name.contains("2612Compatibility") || name.contains("262Compatibility"))
    ) {
        attributes.attribute(
            org.gradle.api.attributes.java.TargetJvmVersion.TARGET_JVM_VERSION_ATTRIBUTE,
            25,
        )
    }
}

tasks.named("check") {
    dependsOn(
        "compileFoliaCompatibilityKotlin",
        "compileCanvasCompatibilityKotlin",
        "compilePaper2611CompatibilityKotlin",
        "compilePaper2612CompatibilityKotlin",
        "compileFolia2612CompatibilityKotlin",
        "compileCanvas2612CompatibilityKotlin",
        "compilePaper262CompatibilityKotlin",
        "compileFolia262CompatibilityKotlin",
        "compileCanvas262CompatibilityKotlin",
    )
}

tasks.test {
    // The managed-document test compiles the same golden fixture the browser edits.
    systemProperty(
        "itemerness.editorFixtures",
        rootProject.layout.projectDirectory.dir("editor/packages/protocol/fixtures").asFile.absolutePath,
    )
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
    manifest.attributes(
        "paperweight-mappings-namespace" to "mojang",
    )
}

tasks.named<ShadowJar>("shadowJar") {
    archiveFileName.set("Itemerness.jar")
    archiveClassifier.set("")
    duplicatesStrategy = DuplicatesStrategy.INCLUDE
    mergeServiceFiles()
    relocate("org.yaml.snakeyaml", "com.iroselle.itemerness.libs.snakeyaml")
    manifest.attributes(
        "paperweight-mappings-namespace" to "mojang",
    )
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
            exactNmsAdapters.keys.forEach { minecraftVersion ->
                check(
                    jar.getJarEntry(
                        "META-INF/itemerness/font-metrics/minecraft-$minecraftVersion.ifm",
                    ) != null,
                ) {
                    "Itemerness.jar does not contain the exact $minecraftVersion font metrics artifact"
                }
            }
            check(jar.getJarEntry("com/iroselle/itemerness/api/ItemernessApi.class") != null) {
                "Itemerness.jar does not contain the public API"
            }
            check(
                jar.getJarEntry(
                    "com/iroselle/itemerness/bukkit/placeholder/ItemernessPlaceholderExpansion.class",
                ) != null,
            ) {
                "Itemerness.jar does not contain the built-in PlaceholderAPI expansion"
            }
            check(jar.entries().asSequence().none { entry ->
                entry.name.startsWith("me/clip/placeholderapi/")
            }) {
                "Itemerness.jar must not bundle PlaceholderAPI"
            }
            check(jar.getJarEntry("com/iroselle/itemerness/projection/ProjectionAdapter.class") != null) {
                "Itemerness.jar does not contain the projection SPI"
            }
            check(jar.getJarEntry("com/iroselle/itemerness/bukkit/spi/BukkitCanonicalItemBridge.class") != null) {
                "Itemerness.jar does not contain the Bukkit canonical bridge SPI"
            }
            val bridgeService = checkNotNull(
                jar.getJarEntry(
                    "META-INF/services/com.iroselle.itemerness.bukkit.spi.BukkitCanonicalItemBridgeFactory",
                ),
            ) {
                "Itemerness.jar does not contain the canonical bridge service descriptor"
            }
            val bridgeProviders = jar.getInputStream(bridgeService)
                .bufferedReader(Charsets.UTF_8)
                .use { reader -> reader.readLines().map(String::trim).filter(String::isNotEmpty) }
            val expectedBridgeProviders = exactNmsAdapters.values.mapTo(linkedSetOf()) { packageVersion ->
                "com.iroselle.itemerness.nms.v$packageVersion.NmsBukkitCanonicalItemBridgeFactory"
            }
            check(bridgeProviders.toSet() == expectedBridgeProviders) {
                "Itemerness.jar canonical bridge providers do not match the supported version matrix: $bridgeProviders"
            }
            val projectionService = checkNotNull(
                jar.getJarEntry(
                    "META-INF/services/com.iroselle.itemerness.projection.ProjectionAdapterFactory",
                ),
            ) {
                "Itemerness.jar does not contain the projection adapter service descriptor"
            }
            val projectionProviders = jar.getInputStream(projectionService)
                .bufferedReader(Charsets.UTF_8)
                .use { reader -> reader.readLines().map(String::trim).filter(String::isNotEmpty) }
            val expectedProjectionProviders = exactNmsAdapters.values.mapTo(linkedSetOf()) { packageVersion ->
                "com.iroselle.itemerness.nms.v$packageVersion.NmsProjectionAdapterFactory"
            }
            check(projectionProviders.toSet() == expectedProjectionProviders) {
                "Itemerness.jar projection providers do not match the supported version matrix: $projectionProviders"
            }
            check(jar.manifest.mainAttributes.getValue("paperweight-mappings-namespace") == "mojang") {
                "Itemerness.jar must declare the Mojang mappings namespace"
            }
            check(jar.getJarEntry("config.yml") != null) {
                "Itemerness.jar does not contain the default user configuration"
            }
            check(jar.getJarEntry("META-INF/licenses/Apache-2.0.txt") != null) {
                "Itemerness.jar does not contain the Apache-2.0 license text for bundled dependencies"
            }
            check(jar.getJarEntry("META-INF/THIRD-PARTY-NOTICES.txt") != null) {
                "Itemerness.jar does not contain third-party dependency notices"
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
            exactNmsAdapters.forEach { (minecraftVersion, _) ->
                val nmsSurfaceEntry = checkNotNull(
                    jar.getJarEntry("META-INF/itemerness/nms/$minecraftVersion/surfaces.yml"),
                ) {
                    "Itemerness.jar does not contain the $minecraftVersion NMS coverage manifest"
                }
                val nmsSurfaces = jar.getInputStream(nmsSurfaceEntry)
                    .bufferedReader(Charsets.UTF_8)
                    .use { reader -> reader.readText() }
                check("minecraft-version: \"$minecraftVersion\"" in nmsSurfaces) {
                    "The packaged $minecraftVersion NMS surface metadata has the wrong version"
                }
                check("coverage-status: release-ready-exact-version" in nmsSurfaces) {
                    "The packaged $minecraftVersion NMS surface metadata is not release-ready"
                }
                check("release-gate-enabled: true" in nmsSurfaces) {
                    "The packaged $minecraftVersion NMS surface metadata does not enable the release gate"
                }
                check(Regex("(?m)^known-unsupported:\\s*\\[\\s*]\\s*$").containsMatchIn(nmsSurfaces)) {
                    "The packaged $minecraftVersion NMS surface metadata still declares unsupported surfaces"
                }

                val carrierEntry = checkNotNull(
                    jar.getJarEntry("META-INF/itemerness/nms/$minecraftVersion/carrier-surfaces.tsv"),
                ) {
                    "Itemerness.jar does not contain the $minecraftVersion packet carrier manifest"
                }
                val unsupportedCarriers = jar.getInputStream(carrierEntry)
                    .bufferedReader(Charsets.UTF_8)
                    .useLines { lines ->
                        lines.drop(1)
                            .filter(String::isNotBlank)
                            .map { line -> line.split('\t') }
                            .filter { columns -> columns.firstOrNull() == "unsupported-known" }
                            .mapNotNull { columns -> columns.getOrNull(1) }
                            .toList()
                    }
                check(unsupportedCarriers.isEmpty()) {
                    "The packaged $minecraftVersion carrier manifest has unsupported surfaces: $unsupportedCarriers"
                }
                check(
                    jar.getJarEntry(
                        "META-INF/itemerness/nms/$minecraftVersion/item-component-surfaces.tsv",
                    ) != null,
                ) {
                    "Itemerness.jar does not contain the $minecraftVersion item-component manifest"
                }
            }

            exactNmsAdapters.forEach { (minecraftVersion, packageVersion) ->
                val adapterClass = "com/iroselle/itemerness/nms/v$packageVersion/NmsProjectionAdapterFactory.class"
                check(jar.getJarEntry(adapterClass) != null) {
                    "Itemerness.jar does not contain the $minecraftVersion NMS adapter"
                }
                val gateEntry = checkNotNull(
                    jar.getJarEntry(
                        "com/iroselle/itemerness/nms/v$packageVersion/NmsProjectionReleaseGate.class",
                    ),
                ) {
                    "Itemerness.jar does not contain the $minecraftVersion NMS release gate"
                }
                val gateBytes = jar.getInputStream(gateEntry).use { stream -> stream.readAllBytes() }
                check(readBooleanClassConstant(gateBytes, "ENABLED")) {
                    "The packaged $minecraftVersion NMS release gate is disabled"
                }
            }

            val unsupportedClassVersions = jar.entries().asSequence()
                .filter { entry -> !entry.isDirectory && entry.name.endsWith(".class") }
                .mapNotNull { entry ->
                    val bytes = jar.getInputStream(entry).use { stream -> stream.readNBytes(8) }
                    check(bytes.size == 8 && bytes.copyOfRange(0, 4).contentEquals(byteArrayOf(0xCA.toByte(), 0xFE.toByte(), 0xBA.toByte(), 0xBE.toByte()))) {
                        "Malformed class file in Itemerness.jar: ${entry.name}"
                    }
                    val major = ((bytes[6].toInt() and 0xFF) shl 8) or (bytes[7].toInt() and 0xFF)
                    if (major > 65) "${entry.name} (major $major)" else null
                }
                .toList()
            check(unsupportedClassVersions.isEmpty()) {
                "Itemerness.jar contains classes that cannot load on Java 21: $unsupportedClassVersions"
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

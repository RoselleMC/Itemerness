import java.util.Properties
import java.util.jar.JarFile

plugins {
    java
}

group = "com.iroselle.itemerness.tools"
version = "1.0.0"

val paperApiVersion = providers.gradleProperty("paperApiVersion")
    .orElse("1.21.11-R0.1-SNAPSHOT")
val rootProperties = Properties().apply {
    providers.fileContents(layout.projectDirectory.file("../../gradle.properties")).asText.get().reader().use(::load)
}
val apiVersion = providers.gradleProperty("itemernessVersion")
    .orElse(rootProperties.getProperty("itemernessVersion"))
val apiMode = providers.gradleProperty("itemernessApiMode").orElse("files")
require(apiMode.get() in setOf("files", "mavenLocal")) {
    "itemernessApiMode must be files or mavenLocal"
}
val itemernessApiJar = providers.gradleProperty("itemernessApiJar")
    .map(::file)
    .orElse(layout.projectDirectory.file("../../itemerness-api/build/libs/itemerness-api-${apiVersion.get()}.jar").asFile)
val itemernessBukkitApiJar = providers.gradleProperty("itemernessBukkitApiJar")
    .map(::file)
    .orElse(layout.projectDirectory.file("../../itemerness-bukkit-api/build/libs/itemerness-bukkit-api-${apiVersion.get()}.jar").asFile)

repositories {
    if (apiMode.get() == "mavenLocal") {
        exclusiveContent {
            forRepository { mavenLocal() }
            filter { includeGroup("com.iroselle") }
        }
    }
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    if (apiMode.get() == "mavenLocal") {
        compileOnly("com.iroselle:itemerness-bukkit-api:${apiVersion.get()}")
    } else {
        compileOnly(files(itemernessApiJar, itemernessBukkitApiJar))
    }
    compileOnly(libs.kotlin.stdlib)
    compileOnly("io.papermc.paper:paper-api:${paperApiVersion.get()}")
}

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(25))
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(21)
    doFirst {
        if (apiMode.get() == "files") {
            listOf(itemernessApiJar.get(), itemernessBukkitApiJar.get()).forEach { apiJar ->
                require(apiJar.isFile) {
                    "Missing public API JAR: $apiJar. Build :itemerness-api:jar :itemerness-bukkit-api:jar first."
                }
            }
        }
    }
}

tasks.processResources {
    filteringCharset = "UTF-8"
}

tasks.jar {
    archiveFileName.set("ItemernessRuntimeProbe.jar")
}

val verifyProbeJar by tasks.registering {
    group = "verification"
    dependsOn(tasks.jar)
    val archive = tasks.jar.flatMap { it.archiveFile }
    inputs.file(archive)
    doLast {
        JarFile(archive.get().asFile).use { jar ->
            val forbiddenPrefixes = listOf(
                "com/iroselle/itemerness/api/",
                "com/iroselle/itemerness/bukkit/",
                "com/iroselle/itemerness/core/",
                "com/iroselle/itemerness/nms/",
                "org/bukkit/",
                "kotlin/",
            )
            check(jar.entries().asSequence().none { entry -> forbiddenPrefixes.any { prefix -> entry.name.startsWith(prefix) } }) {
                "The runtime probe must not bundle public API, platform, or implementation dependencies"
            }
        }
    }
}

tasks.check {
    dependsOn(verifyProbeJar)
}

plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
}

dependencies {
    // The agent bridges a wire protocol to the platform-neutral compiler. It must never see
    // Bukkit, Paper, or NMS: `itemerness-bukkit` depends on this module, not the other way round.
    api(project(":itemerness-editor-protocol"))
    api(project(":itemerness-core"))
    implementation(libs.kotlin.stdlib)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    systemProperty(
        "itemerness.editorFixtures",
        rootProject.layout.projectDirectory.dir("editor/packages/protocol/fixtures").asFile.absolutePath,
    )
    systemProperty(
        "itemerness.fontMetricsArtifact",
        rootProject.layout.projectDirectory
            .file("itemerness-bukkit/src/main/resources/META-INF/itemerness/font-metrics/minecraft-26.1.2.ifm")
            .asFile.absolutePath,
    )
}

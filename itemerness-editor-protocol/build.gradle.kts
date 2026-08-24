plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
}

dependencies {
    // The wire contract compiles the authoring document straight into the platform-neutral core
    // inputs, so it depends on core and never on Bukkit, Paper, or NMS.
    api(project(":itemerness-core"))
    implementation(libs.kotlin.stdlib)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    // The golden fixture lives in the editor workspace and is the single source of truth for both
    // languages. Passing the directory in keeps the test from guessing a relative path.
    systemProperty(
        "itemerness.editorFixtures",
        rootProject.layout.projectDirectory.dir("editor/packages/protocol/fixtures").asFile.absolutePath,
    )
}

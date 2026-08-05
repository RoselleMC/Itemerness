plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
}

dependencies {
    api(project(":itemerness-core"))
    api(project(":itemerness-projection-spi"))
    // Bukkit owns the concrete platform API on each compatibility classpath. Propagating Paper
    // here would add a second org.bukkit capability beside Folia or Canvas.
    compileOnly(libs.paper.api)
    implementation(libs.kotlin.stdlib)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}

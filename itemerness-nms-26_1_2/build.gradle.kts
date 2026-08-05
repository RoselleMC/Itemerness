plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.paperweight.userdev)
    `java-library`
}

dependencies {
    paperweight.paperDevBundle(libs.versions.paper.get())

    implementation(project(":itemerness-projection-spi"))
    implementation(libs.kotlin.stdlib)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}

paperweight.reobfArtifactConfiguration =
    io.papermc.paperweight.userdev.ReobfArtifactConfiguration.MOJANG_PRODUCTION

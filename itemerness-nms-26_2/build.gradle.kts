plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.paperweight.userdev)
    `java-library`
}

java {
    // The 26.x dev bundle requires a Java 25 compile classpath. Kotlin still emits
    // Java 21 bytecode so this exact adapter can coexist in the universal JAR.
    targetCompatibility = JavaVersion.VERSION_25
}

configurations.configureEach {
    if (isCanBeResolved) {
        attributes.attribute(
            org.gradle.api.attributes.java.TargetJvmVersion.TARGET_JVM_VERSION_ATTRIBUTE,
            25,
        )
    }
}

dependencies {
    paperweight.paperDevBundle(libs.versions.paper262.get())

    implementation(project(":itemerness-projection-spi"))
    implementation(project(":itemerness-bukkit-spi"))
    implementation(libs.kotlin.stdlib)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.platform.launcher)
}

paperweight.reobfArtifactConfiguration =
    io.papermc.paperweight.userdev.ReobfArtifactConfiguration.MOJANG_PRODUCTION

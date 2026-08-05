import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension

plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.paperweight.userdev) apply false
    alias(libs.plugins.shadow) apply false
}

allprojects {
    group = "com.iroselle"
    version = providers.gradleProperty("itemernessVersion").get()
}

subprojects {
    plugins.withId("java") {
        extensions.configure<JavaPluginExtension> {
            toolchain.languageVersion.set(JavaLanguageVersion.of(25))
            withSourcesJar()
        }

        tasks.withType<JavaCompile>().configureEach {
            options.encoding = "UTF-8"
            options.release.set(25)
        }

        tasks.withType<Test>().configureEach {
            useJUnitPlatform()
        }
    }

    plugins.withId("org.jetbrains.kotlin.jvm") {
        extensions.configure<KotlinJvmProjectExtension> {
            jvmToolchain(25)
            compilerOptions {
                jvmTarget.set(JvmTarget.JVM_25)
                javaParameters.set(true)
                freeCompilerArgs.add("-Xjsr305=strict")
            }
        }
    }
}

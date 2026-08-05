pluginManagement {
    repositories {
        gradlePluginPortal()
    }
}

plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        maven("https://repo.papermc.io/repository/maven-public/") {
            name = "PaperMC"
        }
        maven("https://maven.canvasmc.io/releases") {
            name = "CanvasMC"
        }
    }
}

rootProject.name = "Itemerness"

include("itemerness-api")
include("itemerness-core")
include("itemerness-bukkit")

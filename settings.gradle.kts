pluginManagement {
    repositories {
        gradlePluginPortal()
        maven("https://repo.papermc.io/repository/maven-public/") {
            name = "PaperMC"
        }
    }
}

plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    // paperweight-userdev installs the exact dev-bundle repository while configuring the NMS
    // module, so Gradle's FAIL_ON_PROJECT_REPOS mode cannot be used for this build.
    repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)
    repositories {
        mavenCentral()
        maven("https://repo.papermc.io/repository/maven-public/") {
            name = "PaperMC"
        }
        maven("https://maven.canvasmc.io/releases") {
            name = "CanvasMCReleases"
        }
        maven("https://maven.canvasmc.io/snapshots") {
            name = "CanvasMCSnapshots"
        }
        maven("https://repo.extendedclip.com/releases/") {
            name = "PlaceholderAPI"
            content {
                includeGroup("me.clip")
            }
        }
    }
}

rootProject.name = "Itemerness"

include("itemerness-api")
include("itemerness-bukkit-api")
include("itemerness-core")
include("itemerness-projection-spi")
include("itemerness-bukkit-spi")
include("itemerness-nms-1_21_11")
include("itemerness-nms-26_1_1")
include("itemerness-nms-26_1_2")
include("itemerness-nms-26_2")
include("itemerness-editor-protocol")
include("itemerness-editor-agent")
include("itemerness-bukkit")

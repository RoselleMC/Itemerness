plugins {
    java
}

group = "com.iroselle.itemerness.tools"
version = "1.0.0"

val paperApiVersion = providers.gradleProperty("paperApiVersion")
    .orElse("26.1.2.build.74-stable")
val itemernessJar = providers.gradleProperty("itemernessJar")
    .map(::file)
    .orElse(layout.projectDirectory.file("../../itemerness-bukkit/build/libs/Itemerness.jar").asFile)

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly(files(itemernessJar))
    compileOnly("io.papermc.paper:paper-api:${paperApiVersion.get()}")
}

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(25))
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(25)
    doFirst {
        require(itemernessJar.get().isFile) {
            "Build Itemerness.jar first or pass -PitemernessJar=/absolute/path/Itemerness.jar"
        }
    }
}

tasks.processResources {
    filteringCharset = "UTF-8"
}

tasks.jar {
    archiveFileName.set("ItemernessRuntimeProbe.jar")
}

plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
    `maven-publish`
}

dependencies {
    api(project(":itemerness-api"))
    compileOnly(libs.paper.api)
    implementation(libs.kotlin.stdlib)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.paper.api)
    testRuntimeOnly(libs.junit.platform.launcher)
}

publishing {
    publications {
        create<MavenPublication>("mavenJava") {
            from(components["java"])
        }
    }
}

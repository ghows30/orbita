import java.util.Properties

plugins {
    id("com.android.application")
}

// Firma release: da keystore.properties (locale, mai su Git) oppure da variabili d'ambiente (GitHub Actions).
val signing = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun sign(key: String): String? = signing.getProperty(key) ?: System.getenv("ORBITA_" + key.uppercase())

android {
    namespace = "com.orbita.player"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.orbita.player"
        minSdk = 23 // Fire OS 6+ (tutte le Fire TV ancora supportate) e Android TV 6+
        targetSdk = 36
        versionCode = (System.getenv("ORBITA_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("ORBITA_VERSION_NAME") ?: "1.0.0"
    }

    signingConfigs {
        create("release") {
            val path = sign("storeFile")
            if (path != null) {
                storeFile = rootProject.file(path)
                storePassword = sign("storePassword")
                keyAlias = sign("keyAlias")
                keyPassword = sign("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val cfg = signingConfigs.getByName("release")
            // senza chiave (es. pull request) si firma con la chiave debug: APK installabile solo per prova
            signingConfig = if (cfg.storeFile != null) cfg else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = true }
    lint {
        disable += "UnsafeOptInUsageError"
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.11.1")
    implementation("androidx.media3:media3-ui:1.11.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.11.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

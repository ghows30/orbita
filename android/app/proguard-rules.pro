# Metodi chiamati da JavaScript tramite il ponte WebView
-keepclassmembers class com.orbita.player.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

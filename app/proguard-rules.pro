# Keep JavascriptInterface methods
-keepclassmembers class com.kalamos.notebook.bridge.AndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep Ink SDK stub methods
-keep class com.inksdk.ink.** { *; }

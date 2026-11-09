package com.orbita.player

import android.annotation.SuppressLint
import android.app.Activity
import android.app.UiModeManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.LruCache
import android.view.KeyEvent
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.io.InputStream
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Ospita l'interfaccia ORBITA (la stessa del web) in una WebView chiusa:
 * - carica SOLO l'origine interna https://appassets.androidplatform.net, servita dagli asset dell'APK;
 * - qualsiasi altra navigazione o risorsa esterna è bloccata (il ponte JS non è mai esposto a pagine di terzi);
 * - le chiamate ai provider passano da [Bridge] + intercettazione, con la protezione SSRF di [Net];
 * - la riproduzione avviene nel player nativo ExoPlayer ([PlayerActivity]).
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val bridge = Bridge()
    private val remote = Remote(this) { json ->
        runOnUiThread { web.evaluateJavascript("window.orbitaRemoteSource && window.orbitaRemoteSource(${JSONObject.quote(json)})", null) }
    }
    private var lastBack = 0L
    private val logoCache = object : LruCache<String, Pair<String, ByteArray>>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Pair<String, ByteArray>) = value.second.size
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0E0D0C"))
            isFocusable = true
            isFocusableInTouchMode = true
            overScrollMode = View.OVER_SCROLL_NEVER
        }
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            textZoom = 100
            setGeolocationEnabled(false)
            userAgentString = userAgentString + " OrbitaAndroid/" + BuildConfig.VERSION_NAME
        }
        web.addJavascriptInterface(bridge, "OrbitaAndroid")
        web.webViewClient = Client()
        if (BuildConfig.DEBUG) web.webChromeClient = object : android.webkit.WebChromeClient() {
            override fun onConsoleMessage(m: android.webkit.ConsoleMessage): Boolean {
                android.util.Log.d("OrbitaJS", "${m.message()} @${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }
        setContentView(web)
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl("$ORIGIN/")
        web.requestFocus()
        BackKey.register(this, ::handleBack)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        remote.stop()
        web.destroy()
        super.onDestroy()
    }

    /* ---------------- tasto Indietro: prima lo chiede all'app web ---------------- */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP) BackKey.fire(this, ::handleBack)
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun handleBack() {
        web.evaluateJavascript("(window.orbitaBack && window.orbitaBack()) ? 1 : 0") { r ->
            if (r == "1") return@evaluateJavascript
            val now = System.currentTimeMillis()
            if (now - lastBack < 2000) finish()
            else {
                lastBack = now
                Toast.makeText(this, L10n.t("backAgain"), Toast.LENGTH_SHORT).show()
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PLAYER) return
        val res = data?.getStringExtra(PlayerActivity.EXTRA_RESULT) ?: "{}"
        web.evaluateJavascript("window.orbitaPlayerClosed && window.orbitaPlayerClosed(${JSONObject.quote(res)})", null)
        web.requestFocus()
    }

    fun isTv(): Boolean {
        val ui = getSystemService(UI_MODE_SERVICE) as UiModeManager
        return ui.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            packageManager.hasSystemFeature("amazon.hardware.fire_tv")
    }

    /* ---------------- ponte JavaScript (superficie minima) ---------------- */
    inner class Bridge {
        val pending = ConcurrentHashMap<String, Pair<String, String>>()
        private val rnd = SecureRandom()

        /** Registra una richiesta API; JS poi la esegue con fetch('/__native/<id>'). Uso singolo. */
        @JavascriptInterface
        fun prepare(path: String, body: String): String {
            if (path !in API_PATHS || body.length > 64 * 1024) return ""
            if (pending.size > 200) pending.clear()
            val id = ByteArray(16).also(rnd::nextBytes).joinToString("") { "%02x".format(it) }
            pending[id] = path to body
            return id
        }

        @JavascriptInterface
        fun play(json: String) {
            if (json.length > 8 * 1024 * 1024) return
            runOnUiThread {
                PlayerActivity.request = json
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(this@MainActivity, PlayerActivity::class.java), REQ_PLAYER)
            }
        }

        @JavascriptInterface
        fun isTv(): Boolean = this@MainActivity.isTv()

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun exit() = runOnUiThread { finish() }

        /** Accende il server per lo smartphone: {url, code, qr} oppure "" se la TV non è in una rete locale. */
        @JavascriptInterface
        fun remoteStart(): String = remote.start()?.toString() ?: ""

        /** Come remoteStart, ma il telefono invia le chiavi API (Impostazioni → Voti e copertine). */
        @JavascriptInterface
        fun remoteStartKeys(): String = remote.start("keys")?.toString() ?: ""

        @JavascriptInterface
        fun remoteStop() = remote.stop()

        @JavascriptInterface
        fun remoteResult(ok: Boolean, msg: String) = remote.result(ok, msg)

        /** Lingua scelta nelle Impostazioni: testi nativi e pagina per lo smartphone. */
        @JavascriptInterface
        fun setLang(lang: String) { L10n.lang = lang }
    }

    /* ---------------- origine interna ---------------- */
    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            request.url.host != HOST // nessuna navigazione fuori dall'app

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val url = request.url
            if (url.scheme != "https" || url.host != HOST) return text(403, "Bloccato")
            val path = url.path ?: "/"
            return try {
                when {
                    path.startsWith("/__native/") -> native(path.removePrefix("/__native/"))
                    path == "/logo" -> logo(url)
                    else -> asset(path)
                }
            } catch (e: Exception) {
                val (code, msg) = Net.friendly(e)
                json(code, JSONObject().put("error", msg).toString())
            }
        }
    }

    private fun native(id: String): WebResourceResponse {
        val (path, body) = bridge.pending.remove(id) ?: return json(404, """{"error":"Richiesta scaduta"}""")
        val b = JSONObject(body)
        val ua = b.optString("ua").ifEmpty { null }
        return when (path) {
            "/api/fetch" -> {
                val r = Net.get(b.optString("url"), ua)
                if (!r.isSuccessful) {
                    val code = r.code
                    r.close()
                    json(502, JSONObject().put("error", "Il provider ha risposto con errore $code.").put("status", code).toString())
                } else {
                    resp(200, "text/plain", Net.limited(r.body!!.byteStream(), 250L * 1024 * 1024))
                }
            }
            "/api/epg" -> {
                val ids = b.optJSONArray("ids")
                val wanted = HashSet<String>()
                if (ids != null) for (i in 0 until minOf(ids.length(), 20000)) wanted.add(ids.optString(i).lowercase())
                val now = System.currentTimeMillis() / 1000
                val from = b.optLong("from", now - 8 * 3600).takeIf { it > 0 } ?: (now - 8 * 3600)
                val to = b.optLong("to", now + 30 * 3600).takeIf { it > 0 } ?: (now + 30 * 3600)
                if (wanted.isEmpty()) return json(200, "{}")
                Net.get(b.optString("url"), ua, 90).use { r ->
                    if (!r.isSuccessful) return json(502, JSONObject().put("error", "Guida EPG non disponibile (${r.code}).").toString())
                    json(200, Xmltv.parse(r.body!!.byteStream(), wanted, from, to).toString())
                }
            }
            else -> json(404, """{"error":"Not found"}""")
        }
    }

    private fun logo(url: Uri): WebResourceResponse {
        val u = Net.validUrl(url.getQueryParameter("u")) ?: return text(400, "")
        logoCache.get(u)?.let { return resp(200, it.first, ByteArrayInputStream(it.second), cache = true) }
        Net.get(u, null, 12).use { r ->
            val ct = r.header("Content-Type").orEmpty().substringBefore(';').trim().lowercase()
            if (!r.isSuccessful || !Regex("^image/(png|jpe?g|gif|webp|avif|x-icon|vnd\\.microsoft\\.icon)$").matches(ct)) return text(404, "")
            val bytes = Net.limited(r.body!!.byteStream(), 3L * 1024 * 1024).readBytes()
            logoCache.put(u, ct to bytes)
            return resp(200, ct, ByteArrayInputStream(bytes), cache = true)
        }
    }

    private fun asset(path: String): WebResourceResponse {
        val clean = path.trimStart('/').ifEmpty { "index.html" }
        if (clean.contains("..") || clean.contains('\\')) return text(400, "")
        val (name, stream) = openAsset(clean) ?: openAsset("index.html")!!
        val headers = HashMap(SECURITY_HEADERS)
        if (name.endsWith(".html")) headers["Content-Security-Policy"] = CSP
        return WebResourceResponse(mime(name), if (mime(name).startsWith("text/") || name.endsWith(".js")) "utf-8" else null, 200, "OK", headers, stream)
    }

    private fun openAsset(name: String): Pair<String, InputStream>? = try {
        name to assets.open("web/$name")
    } catch (e: FileNotFoundException) {
        null
    }

    private fun mime(n: String) = when (n.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"
        "js" -> "text/javascript"
        "css" -> "text/css"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "json" -> "application/json"
        "woff2" -> "font/woff2"
        "m3u" -> "audio/x-mpegurl"
        else -> "application/octet-stream"
    }

    private fun resp(code: Int, mime: String, body: InputStream, cache: Boolean = false): WebResourceResponse {
        val h = HashMap(SECURITY_HEADERS)
        h["Cache-Control"] = if (cache) "private, max-age=86400" else "no-store"
        return WebResourceResponse(mime, "utf-8", code, reason(code), h, body)
    }

    private fun json(code: Int, s: String) = resp(code, "application/json", ByteArrayInputStream(s.toByteArray()))
    private fun text(code: Int, s: String) = resp(code, "text/plain", ByteArrayInputStream(s.toByteArray()))
    private fun reason(code: Int) = when (code) {
        200 -> "OK"; 400 -> "Bad Request"; 403 -> "Forbidden"; 404 -> "Not Found"; 413 -> "Too Large"; 504 -> "Timeout"; else -> "Error"
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        private const val REQ_PLAYER = 41
        private val API_PATHS = setOf("/api/fetch", "/api/epg")
        private val SECURITY_HEADERS = mapOf(
            "X-Content-Type-Options" to "nosniff",
            "Referrer-Policy" to "no-referrer",
        )
        private const val CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
            "media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self'; object-src 'none'; " +
            "base-uri 'none'; form-action 'self'"
    }
}

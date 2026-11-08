package com.orbita.player

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

/**
 * Player nativo (Media3/ExoPlayer): decodifica hardware, HLS/TS/MP4/MKV, tracce audio e sottotitoli,
 * riconnessione automatica, zapping con su/giù o CH+/CH- del telecomando.
 * Riceve la richiesta da JS come JSON; alla chiusura restituisce posizione/durata per "riprendi".
 */
@OptIn(UnstableApi::class)
class PlayerActivity : Activity() {
    companion object {
        /** Passata in memoria (non nell'Intent) perché le liste canali possono superare il limite Binder. */
        @Volatile var request: String? = null
        const val EXTRA_RESULT = "result"
        private const val MAX_RETRY = 6
        private const val MAX_RETRY_LIVE = 20
    }

    private class Item(val id: String, val title: String, val subtitle: String, val url: String, val alt: String?)

    private lateinit var player: ExoPlayer
    private lateinit var view: PlayerView
    private lateinit var titleV: TextView
    private lateinit var subV: TextView
    private lateinit var clockV: TextView
    private lateinit var statusV: TextView
    private lateinit var spinner: ProgressBar
    private lateinit var topBar: LinearLayout
    private val ui = Handler(Looper.getMainLooper())

    private var items = listOf<Item>()
    private var index = 0
    private var live = false
    private var resumeKey: String? = null
    private var startAt = 0L
    private var ua: String? = null
    private var retries = 0
    private var usingAlt = false
    private var ended = false
    private var retryPending: Runnable? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val req = runCatching { JSONObject(request ?: "{}") }.getOrElse { JSONObject() }
        request = null
        parse(req)
        if (items.isEmpty()) return finish()
        buildUi()
        buildPlayer()
        BackKey.register(this, ::onBack)
        watchNetwork()
        load(resume = true)
    }

    /** Quando la rete torna disponibile non aspetta il prossimo tentativo programmato: riprova subito. */
    private fun watchNetwork() {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                ui.post {
                    val r = retryPending ?: return@post
                    ui.removeCallbacks(r)
                    status("Rete tornata, riprendo…")
                    r.run()
                }
            }
        }
        val req = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
        if (runCatching { cm.registerNetworkCallback(req, cb) }.isSuccess) netCallback = cb
    }

    private fun parse(r: JSONObject) {
        live = r.optBoolean("live")
        resumeKey = r.optString("resumeKey").ifEmpty { null }
        startAt = (r.optDouble("startAt", 0.0) * 1000).toLong()
        ua = r.optString("ua").ifEmpty { null }
        val list = r.optJSONArray("list") ?: JSONArray().put(r)
        items = (0 until list.length()).mapNotNull { i ->
            val o = list.optJSONObject(i) ?: return@mapNotNull null
            val url = Net.validUrl(o.optString("url")) ?: return@mapNotNull null
            Item(o.optString("id"), o.optString("title"), o.optString("subtitle"), url, Net.validUrl(o.optString("alt")))
        }
        index = r.optInt("index", 0).coerceIn(0, maxOf(0, items.size - 1))
    }

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    @SuppressLint("SetTextI18n")
    private fun buildUi() {
        view = PlayerView(this).apply {
            setShowSubtitleButton(true)
            setShowFastForwardButton(!live)
            setShowRewindButton(!live)
            setShowNextButton(false)
            setShowPreviousButton(false)
            controllerShowTimeoutMs = 3500
            controllerAutoShow = true
            setKeepContentOnPlayerReset(false) // cambiando canale: nero + caricamento, mai l'ultimo fotogramma del canale prima
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            setShutterBackgroundColor(Color.BLACK)
            setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v -> topBar.visibility = v })
        }
        titleV = TextView(this).apply { setTextColor(Color.WHITE); textSize = 22f; typeface = Typeface.DEFAULT_BOLD; maxLines = 1 }
        subV = TextView(this).apply { setTextColor(Color.parseColor("#B8BED4")); textSize = 15f; maxLines = 1 }
        clockV = TextView(this).apply { setTextColor(Color.WHITE); textSize = 18f; typeface = Typeface.DEFAULT_BOLD }
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(titleV); addView(subV) }
        topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(40f), dp(28f), dp(40f), dp(40f))
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0xCC000000.toInt(), 0x00000000))
            addView(texts, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(clockV)
        }
        statusV = TextView(this).apply {
            setTextColor(Color.WHITE); textSize = 16f; gravity = Gravity.CENTER
            setPadding(dp(18f), dp(10f), dp(18f), dp(10f))
            background = GradientDrawable().apply { setColor(0xB3000000.toInt()); cornerRadius = dp(12f).toFloat() }
            visibility = View.GONE
        }
        spinner = ProgressBar(this).apply { isIndeterminate = true; visibility = View.GONE }
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(topBar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP))
            addView(spinner, FrameLayout.LayoutParams(dp(56f), dp(56f), Gravity.CENTER))
            addView(statusV, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM).apply { bottomMargin = dp(140f) })
        }
        setContentView(root)
        tickClock()
    }

    private fun tickClock() {
        clockV.text = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date())
        ui.postDelayed(::tickClock, 15_000)
    }

    private fun buildPlayer() {
        val http = OkHttpDataSource.Factory(Net.streamClient).setUserAgent(Net.cleanUa(ua))
        val renderers = DefaultRenderersFactory(this)
            .setEnableDecoderFallback(true)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
        // partenza rapida (2,5 s), ma dopo un'interruzione riparte solo con 8 s di scorta:
        // con un Wi-Fi ballerino evita il ciclo "riparte, si blocca, riparte"
        val load = DefaultLoadControl.Builder()
            .setBufferDurationsMs(20_000, 60_000, 2_500, 8_000)
            .build()
        // un segmento HLS perso si riprova più volte prima di far fallire la riproduzione
        val sources = DefaultMediaSourceFactory(this)
            .setDataSourceFactory(http)
            .setLoadErrorHandlingPolicy(DefaultLoadErrorHandlingPolicy(8))
        player = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(sources)
            .setLoadControl(load)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
            .setHandleAudioBecomingNoisy(true)
            // tiene il Wi-Fi in modalità alte prestazioni durante la riproduzione (niente risparmio energetico)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                spinner.visibility = if (state == Player.STATE_BUFFERING) View.VISIBLE else View.GONE
                if (state == Player.STATE_READY) {
                    retries = 0
                    status(null)
                }
                if (state == Player.STATE_ENDED && !live) {
                    ended = true
                    finishWithResult()
                }
            }

            override fun onPlayerError(error: PlaybackException) = onError(error)
        })
        view.player = player
    }

    private fun current() = items[index]

    private fun load(resume: Boolean) {
        val it = current()
        titleV.text = it.title
        subV.text = it.subtitle
        val url = if (usingAlt && it.alt != null) it.alt else it.url
        val b = MediaItem.Builder().setUri(url)
        if (url.contains(".m3u8", true)) b.setMimeType(MimeTypes.APPLICATION_M3U8)
        // 15 s dal punto live: qualche secondo di ritardo in cambio di una scorta che assorbe i cali di rete
        if (live) b.setLiveConfiguration(MediaItem.LiveConfiguration.Builder().setTargetOffsetMs(15_000).build())
        player.setMediaItem(b.build(), if (resume && startAt > 0 && !live) startAt else C.TIME_UNSET)
        player.prepare()
        player.playWhenReady = true
        view.showController()
    }

    private fun onError(e: PlaybackException) {
        if (e.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
            player.seekToDefaultPosition()
            player.prepare()
            return
        }
        // per i canali Xtream prova una volta il formato alternativo (m3u8 <-> ts)
        if (live && !usingAlt && current().alt != null) {
            usingAlt = true
            status("Provo un formato alternativo…")
            load(resume = false)
            return
        }
        // 401/403/404: riprovare non serve (abbonamento, link scaduto, contenuto rimosso)
        val http = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()
        if (http != null && http.responseCode in 400..499) {
            status(when (http.responseCode) {
                401, 403 -> "Accesso negato dal provider (${http.responseCode}). Controlla abbonamento o connessioni attive."
                404 -> "Contenuto non trovato sul server del provider (404)."
                else -> "Il provider ha rifiutato la richiesta (${http.responseCode})."
            })
            spinner.visibility = View.GONE
            return
        }
        // in diretta si insiste di più (un calo di Wi-Fi può durare un minuto), con attese più brevi
        val max = if (live) MAX_RETRY_LIVE else MAX_RETRY
        if (retries < max) {
            val wait = minOf(1000L shl retries, if (live) 8_000L else 15_000L)
            retries++
            if (!live) startAt = player.currentPosition
            status("Connessione interrotta. Nuovo tentativo tra ${wait / 1000}s ($retries/$max)")
            val idx = index
            retryPending = Runnable { retryPending = null; if (idx == index && !isFinishing) load(resume = !live) }
            ui.postDelayed(retryPending!!, wait)
        } else {
            status("Impossibile riprodurre questo contenuto (${e.errorCodeName}).")
        }
    }

    private fun status(msg: String?) {
        statusV.text = msg ?: ""
        statusV.visibility = if (msg == null) View.GONE else View.VISIBLE
    }

    private fun zap(dir: Int) {
        if (!live || items.size < 2) return
        index = (index + dir + items.size) % items.size
        retries = 0
        usingAlt = false
        status(null)
        ui.removeCallbacksAndMessages(null)
        retryPending = null
        tickClock()
        load(resume = false)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val down = event.action == KeyEvent.ACTION_DOWN
        val controls = view.isControllerFullyVisible
        when (event.keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                if (!down) BackKey.fire(this, ::onBack)
                return true
            }
            KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> { if (down) zap(-1); return true }
            KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> { if (down) zap(1); return true }
            // in diretta su/giù cambiano sempre canale, come su un normale televisore
            KeyEvent.KEYCODE_DPAD_UP -> if (live && items.size > 1) { if (down) zap(-1); return true }
            KeyEvent.KEYCODE_DPAD_DOWN -> if (live && items.size > 1) { if (down) zap(1); return true }
            KeyEvent.KEYCODE_DPAD_LEFT -> if (!live && !controls) { if (down) seekBy(-10_000); return true }
            KeyEvent.KEYCODE_DPAD_RIGHT -> if (!live && !controls) { if (down) seekBy(30_000); return true }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> {
                if (down) { player.playWhenReady = !player.playWhenReady; view.showController() }
                return true
            }
        }
        return view.dispatchKeyEvent(event) || super.dispatchKeyEvent(event)
    }

    private fun onBack() {
        if (view.isControllerFullyVisible) view.hideController() else finishWithResult()
    }

    private fun seekBy(ms: Long) {
        val d = player.duration
        val t = (player.currentPosition + ms).coerceAtLeast(0)
        player.seekTo(if (d > 0) minOf(t, d - 1000) else t)
        status(if (ms > 0) "+${ms / 1000}s" else "${ms / 1000}s")
        ui.postDelayed({ if (player.playbackState == Player.STATE_READY) status(null) }, 900)
    }

    private fun finishWithResult() {
        if (isFinishing) return
        val res = JSONObject()
            .put("key", resumeKey)
            .put("pos", if (live) 0.0 else player.currentPosition / 1000.0)
            .put("dur", if (live || player.duration <= 0) 0.0 else player.duration / 1000.0)
            .put("ended", ended)
            .put("id", current().id)
        setResult(RESULT_OK, Intent().putExtra(EXTRA_RESULT, res.toString()))
        finish()
    }

    override fun onStop() {
        super.onStop()
        if (::player.isInitialized) player.pause()
    }

    override fun onDestroy() {
        netCallback?.let { cb -> runCatching { (getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(cb) } }
        ui.removeCallbacksAndMessages(null)
        if (::player.isInitialized) player.release()
        super.onDestroy()
    }
}

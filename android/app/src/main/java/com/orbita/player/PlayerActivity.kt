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
 * In diretta mostra un banner canale con la guida; per film ed episodi ricerca con anteprime,
 * "Salta intro", conto alla rovescia del prossimo episodio e schermata di pausa.
 * Riceve la richiesta da JS come JSON; alla chiusura restituisce posizione/durata per "riprendi".
 */
@OptIn(UnstableApi::class)
class PlayerActivity : Activity() {
    companion object {
        /** Passata in memoria (non nell'Intent) perché le liste canali possono superare il limite Binder. */
        @Volatile var request: String? = null

        /** Guida di un canale chiesta all'app web (id canale → JSON [{s,e,t}]); la imposta [MainActivity]. */
        @Volatile var epgSource: ((String, (String) -> Unit) -> Unit)? = null
        const val EXTRA_RESULT = "result"
        private const val MAX_RETRY = 6
        private const val MAX_RETRY_LIVE = 20
        private const val INTRO_WINDOW = 180_000L
        private const val INTRO_DEFAULT_SKIP = 85_000L
        private const val NEXT_AT = 30_000L
        private const val NEXT_COUNTDOWN = 15_000L
        private const val PAUSE_SCREEN_AFTER = 5_000L
    }

    private class Item(
        val id: String, val title: String, val subtitle: String, val url: String, val alt: String?,
        val num: String?, val logo: String?,
    )

    private lateinit var player: ExoPlayer
    private lateinit var view: PlayerView
    private lateinit var titleV: TextView
    private lateinit var subV: TextView
    private lateinit var clockV: TextView
    private lateinit var statusV: TextView
    private lateinit var spinner: ProgressBar
    private lateinit var topBar: LinearLayout
    private lateinit var banner: ChannelBanner
    private lateinit var scrubber: Scrubber
    private lateinit var pauseScreen: PauseScreen
    private lateinit var nextCard: NextCard
    private lateinit var skipBtn: TextView
    private val ui = Handler(Looper.getMainLooper())

    private var items = listOf<Item>()
    private var index = 0
    private var live = false
    private var kind = ""
    private var resumeKey: String? = null
    private var startAt = 0L
    private var ua: String? = null
    private var accent = 0xFFFF5626.toInt()
    private var retries = 0
    private var usingAlt = false
    private var ended = false
    private var retryPending: Runnable? = null
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    // film ed episodi
    private var pauseInfo: JSONObject? = null
    private var thumbsOn = false
    private var thumbs: Thumbs? = null
    private var introEnd = 0L
    private var introLearned: Long? = null
    private var skipDone = false
    private var nextLabel: String? = null
    private var nextCancelled = false
    private var countdownLeft = -1L
    private var scrubbing = false
    private var scrubFrom = 0L
    private var scrubTarget = 0L

    private val epgCache = HashMap<String, Pair<Long, JSONArray>>()
    private val hideBanner = Runnable { banner.hide() }
    private val commitScrub = Runnable { commitScrub() }
    private val showPause = Runnable { showPauseScreen() }
    private val tick = object : Runnable {
        override fun run() {
            onTick()
            ui.postDelayed(this, 500)
        }
    }

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
        if (!live) ui.post(tick)
    }

    /** Quando la rete torna disponibile non aspetta il prossimo tentativo programmato: riprova subito. */
    private fun watchNetwork() {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                ui.post {
                    val r = retryPending ?: return@post
                    ui.removeCallbacks(r)
                    status(L10n.t("netBack"))
                    r.run()
                }
            }
        }
        val req = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
        if (runCatching { cm.registerNetworkCallback(req, cb) }.isSuccess) netCallback = cb
    }

    private fun parse(r: JSONObject) {
        L10n.lang = r.optString("lang")
        live = r.optBoolean("live")
        kind = r.optString("kind")
        resumeKey = r.optString("resumeKey").ifEmpty { null }
        startAt = (r.optDouble("startAt", 0.0) * 1000).toLong()
        ua = r.optString("ua").ifEmpty { null }
        accent = runCatching { Color.parseColor(r.optString("accent").trim()) }.getOrDefault(accent)
        pauseInfo = r.optJSONObject("pause")
        thumbsOn = r.optBoolean("thumbs")
        introEnd = (r.optDouble("introEnd", 0.0) * 1000).toLong()
        nextLabel = r.optString("next").ifEmpty { null }
        val list = r.optJSONArray("list") ?: JSONArray().put(r)
        items = (0 until list.length()).mapNotNull { i ->
            val o = list.optJSONObject(i) ?: return@mapNotNull null
            val url = Net.validUrl(o.optString("url")) ?: return@mapNotNull null
            Item(o.optString("id"), o.optString("title"), o.optString("subtitle"), url, Net.validUrl(o.optString("alt")),
                o.optString("num").ifEmpty { null }, Net.validUrl(o.optString("logo")))
        }
        index = r.optInt("index", 0).coerceIn(0, maxOf(0, items.size - 1))
    }

    @SuppressLint("SetTextI18n")
    private fun buildUi() {
        view = PlayerView(this).apply {
            setShowSubtitleButton(true)
            setShowFastForwardButton(!live)
            setShowRewindButton(!live)
            setShowNextButton(false)
            setShowPreviousButton(false)
            controllerShowTimeoutMs = 3500
            // in diretta al cambio canale si vede il banner, non i controlli
            controllerAutoShow = !live
            setKeepContentOnPlayerReset(false) // cambiando canale: nero + caricamento, mai l'ultimo fotogramma del canale prima
            resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            setShutterBackgroundColor(Color.BLACK)
            setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { v ->
                topBar.visibility = v
                if (v == View.VISIBLE) {
                    if (banner.visible) banner.hide()
                    if (skipBtn.visibility == View.VISIBLE) skipBtn.fadeOut()
                }
            })
        }
        titleV = TextView(this).apply { setTextColor(Color.WHITE); textSize = 22f; typeface = Typeface.DEFAULT_BOLD; maxLines = 1 }
        subV = TextView(this).apply { setTextColor(Color.parseColor("#C9C2B8")); textSize = 15f; maxLines = 1 }
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
        banner = ChannelBanner(this, accent)
        scrubber = Scrubber(this, accent)
        pauseScreen = PauseScreen(this, accent)
        nextCard = NextCard(this, accent)
        skipBtn = skipButton(this)
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(pauseScreen.root, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(topBar, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP))
            addView(scrubber.root, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))
            addView(banner.root, FrameLayout.LayoutParams(minOf(dp(900f), resources.displayMetrics.widthPixels - dp(96f)), WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
                bottomMargin = dp(44f)
            })
            addView(skipBtn, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
                rightMargin = dp(56f); bottomMargin = dp(64f)
            })
            addView(nextCard.root, FrameLayout.LayoutParams(dp(420f), WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
                rightMargin = dp(56f); bottomMargin = dp(64f)
            })
            addView(spinner, FrameLayout.LayoutParams(dp(56f), dp(56f), Gravity.CENTER))
            addView(statusV, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM).apply { bottomMargin = dp(140f) })
        }
        setContentView(root)
        nextLabel?.let(nextCard::bind)
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
                armPauseScreen()
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = armPauseScreen()

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
        if (live) showBanner() else view.showController()
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
            status(L10n.t("altFormat"))
            load(resume = false)
            return
        }
        // 401/403/404: riprovare non serve (abbonamento, link scaduto, contenuto rimosso)
        val http = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()
        if (http != null && http.responseCode in 400..499) {
            status(when (http.responseCode) {
                401, 403 -> L10n.t("denied", http.responseCode)
                404 -> L10n.t("notFound")
                else -> L10n.t("rejected", http.responseCode)
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
            status(L10n.t("retry", (wait / 1000).toInt(), retries, max))
            val idx = index
            retryPending = Runnable { retryPending = null; if (idx == index && !isFinishing) load(resume = !live) }
            ui.postDelayed(retryPending!!, wait)
        } else {
            status(L10n.t("cannot", e.errorCodeName))
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
        retryPending?.let(ui::removeCallbacks)
        retryPending = null
        load(resume = false)
    }

    /* ---------------- diretta: banner canale ---------------- */

    private fun showBanner() {
        val it = current()
        banner.bind(it.num, it.title, it.subtitle, it.logo)
        applyEpg(it.id)
        if (view.isControllerFullyVisible) view.hideController()
        banner.show()
        ui.removeCallbacks(hideBanner)
        ui.postDelayed(hideBanner, 5_000)
    }

    private fun applyEpg(id: String) {
        val now = System.currentTimeMillis()
        epgCache[id]?.let { (at, arr) -> if (now - at < 5 * 60_000) return banner.epg(arr) }
        val src = epgSource ?: return banner.epg(JSONArray())
        banner.epg(null)
        src(id) { json ->
            ui.post {
                val arr = runCatching { JSONArray(json) }.getOrElse { JSONArray() }
                epgCache[id] = System.currentTimeMillis() to arr
                if (!isFinishing && current().id == id) banner.epg(arr)
            }
        }
    }

    /* ---------------- film ed episodi ---------------- */

    private fun onTick() {
        if (live || isFinishing) return
        val pos = player.currentPosition
        val dur = player.duration
        val ready = player.playbackState == Player.STATE_READY
        if (pauseScreen.visible) pauseScreen.position(pos, dur)

        // "Salta intro": negli episodi, nei primi minuti (o fino a dove l'intro di questa serie finiva l'ultima volta)
        val limit = if (introEnd > 0) introEnd else INTRO_WINDOW
        val skip = kind == "episode" && !skipDone && ready && !scrubbing && !pauseScreen.visible &&
            !view.isControllerFullyVisible && pos in 3_000 until limit - 2_000
        if (skip) skipBtn.fadeIn() else skipBtn.fadeOut()

        // prossimo episodio: compare negli ultimi 30 s, parte dopo 15 s (il conto si ferma in pausa)
        if (nextLabel != null && !nextCancelled && ready && dur > 5 * 60_000 && dur - pos <= NEXT_AT && countdownLeft < 0 && !scrubbing) {
            countdownLeft = NEXT_COUNTDOWN
            skipBtn.fadeOut()
            nextCard.tick(countdownLeft, NEXT_COUNTDOWN)
            nextCard.show()
        } else if (countdownLeft >= 0) {
            if (dur - pos > NEXT_AT + 5_000) return cancelNext(forget = true) // si è tornati indietro
            if (player.isPlaying) countdownLeft -= 500
            nextCard.tick(maxOf(0, countdownLeft), NEXT_COUNTDOWN)
            if (countdownLeft <= 0) playNext()
        }
    }

    private fun playNext() {
        ended = true
        finishWithResult()
    }

    /** forget = l'utente è tornato indietro: la scheda potrà ricomparire più avanti. */
    private fun cancelNext(forget: Boolean = false) {
        countdownLeft = -1
        if (!forget) nextCancelled = true
        nextCard.hide()
    }

    private fun skipIntro() {
        val pos = player.currentPosition
        val target = if (introEnd > pos) introEnd else pos + INTRO_DEFAULT_SKIP
        player.seekTo(minOf(target, maxOf(0, player.duration - 5_000)))
        if (introEnd <= pos) learnIntro(pos, target)
        skipDone = true
        skipBtn.fadeOut()
    }

    /** Un salto in avanti nei primi minuti di un episodio: è lì che finisce la sigla di questa serie. */
    private fun learnIntro(from: Long, to: Long) {
        if (kind != "episode" || from >= 5 * 60_000 || to > 7 * 60_000 || to - from < 20_000) return
        introEnd = to
        introLearned = to
    }

    private fun scrub(dir: Int, repeat: Int) {
        val dur = player.duration
        if (dur <= 0) return
        if (!scrubbing) {
            scrubbing = true
            scrubFrom = player.currentPosition
            scrubTarget = scrubFrom
            scrubber.clearThumb()
            hidePauseScreen()
            skipBtn.fadeOut()
            scrubber.show()
        }
        // tenendo premuto si accelera: 10 s, poi 30 s, 1 min, 2 min a passo
        val step = when {
            repeat < 4 -> 10_000L
            repeat < 12 -> 30_000L
            repeat < 24 -> 60_000L
            else -> 120_000L
        }
        scrubTarget = (scrubTarget + dir * step).coerceIn(0, maxOf(0, dur - 1_000))
        val url = current().url
        if (thumbsOn && thumbs == null && !url.contains(".m3u8", true)) thumbs = Thumbs(url, ua)
        val th = thumbs?.takeUnless { it.broken }
        scrubber.update(scrubTarget, player.currentPosition, dur, scrubTarget - scrubFrom, th != null)
        th?.request(scrubTarget) { bmp -> if (scrubbing) scrubber.thumb(bmp) }
        ui.removeCallbacks(commitScrub)
        ui.postDelayed(commitScrub, 900)
    }

    private fun commitScrub() {
        if (!scrubbing) return
        scrubbing = false
        ui.removeCallbacks(commitScrub)
        player.seekTo(scrubTarget)
        if (scrubTarget > scrubFrom) learnIntro(scrubFrom, scrubTarget)
        ui.postDelayed({ if (!scrubbing) scrubber.hide() }, 500)
    }

    private fun cancelScrub() {
        scrubbing = false
        ui.removeCallbacks(commitScrub)
        scrubber.hide()
    }

    private fun armPauseScreen() {
        ui.removeCallbacks(showPause)
        val paused = !live && !player.playWhenReady && player.playbackState == Player.STATE_READY
        if (paused) ui.postDelayed(showPause, PAUSE_SCREEN_AFTER) else hidePauseScreen()
    }

    private fun showPauseScreen() {
        if (live || player.playWhenReady || scrubbing || isFinishing) return
        pauseScreen.bind(pauseInfo, current().title)
        pauseScreen.position(player.currentPosition, player.duration)
        view.hideController()
        skipBtn.fadeOut()
        pauseScreen.show()
    }

    private fun hidePauseScreen() {
        ui.removeCallbacks(showPause)
        pauseScreen.hide()
    }

    /* ---------------- telecomando ---------------- */

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val down = event.action == KeyEvent.ACTION_DOWN
        val controls = view.isControllerFullyVisible
        val code = event.keyCode
        val ok = code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER
        if (code == KeyEvent.KEYCODE_BACK) {
            if (!down) BackKey.fire(this, ::onBack)
            return true
        }
        // la schermata di pausa si chiude con qualsiasi tasto; OK e Play riprendono la visione
        if (pauseScreen.visible) {
            if (down && event.repeatCount == 0) {
                hidePauseScreen()
                if (ok || code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PLAY || code == KeyEvent.KEYCODE_SPACE) player.playWhenReady = true
                else { view.showController(); armPauseScreen() }
            }
            return true
        }
        if (scrubbing && ok) { if (down) commitScrub(); return true }
        if (nextCard.visible && ok && !controls) { if (down) playNext(); return true }
        if (skipBtn.visibility == View.VISIBLE && ok && !controls) { if (down) skipIntro(); return true }
        when (code) {
            KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> { if (down) zap(-1); return true }
            KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> { if (down) zap(1); return true }
            // in diretta su/giù cambiano sempre canale, come su un normale televisore
            KeyEvent.KEYCODE_DPAD_UP -> if (live && items.size > 1) { if (down) zap(-1); return true }
            KeyEvent.KEYCODE_DPAD_DOWN -> if (live && items.size > 1) { if (down) zap(1); return true }
            KeyEvent.KEYCODE_DPAD_LEFT -> if (!live && !controls) { if (down) scrub(-1, event.repeatCount); return true }
            KeyEvent.KEYCODE_DPAD_RIGHT -> if (!live && !controls) { if (down) scrub(1, event.repeatCount); return true }
            KeyEvent.KEYCODE_MEDIA_REWIND -> if (!live) { if (down) scrub(-1, event.repeatCount); return true }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> if (!live) { if (down) scrub(1, event.repeatCount); return true }
            KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_GUIDE -> if (live) { if (down) showBanner(); return true }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> {
                if (down) { player.playWhenReady = !player.playWhenReady; view.showController() }
                return true
            }
        }
        // in diretta il primo OK mostra il banner del canale, il secondo i controlli
        if (live && ok && !controls && !banner.visible) { if (down) showBanner(); return true }
        return view.dispatchKeyEvent(event) || super.dispatchKeyEvent(event)
    }

    private fun onBack() {
        when {
            scrubbing -> cancelScrub()
            nextCard.visible -> cancelNext()
            pauseScreen.visible -> { hidePauseScreen(); view.showController() }
            banner.visible -> { ui.removeCallbacks(hideBanner); banner.hide() }
            view.isControllerFullyVisible -> view.hideController()
            else -> finishWithResult()
        }
    }

    private fun finishWithResult() {
        if (isFinishing) return
        val res = JSONObject()
            .put("key", resumeKey)
            .put("pos", if (live) 0.0 else player.currentPosition / 1000.0)
            .put("dur", if (live || player.duration <= 0) 0.0 else player.duration / 1000.0)
            .put("ended", ended)
            .put("id", current().id)
            .put("cancelNext", nextCancelled)
        introLearned?.let { res.put("introEnd", it / 1000.0) }
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
        thumbs?.release()
        if (::player.isInitialized) player.release()
        super.onDestroy()
    }
}

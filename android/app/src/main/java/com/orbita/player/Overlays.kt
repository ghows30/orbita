package com.orbita.player

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

/* Pezzi di interfaccia del player nativo: banner canale, barra di ricerca con anteprime,
 * schermata di pausa, "Salta intro" e conto alla rovescia del prossimo episodio. */

private const val TEXT_2 = 0xFFC9C2B8.toInt()
private const val CARD = 0xEB141210.toInt()

internal fun Context.dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

internal fun Context.label(size: Float, color: Int = Color.WHITE, bold: Boolean = false, lines: Int = 1) = TextView(this).apply {
    setTextColor(color)
    textSize = size
    if (bold) typeface = Typeface.DEFAULT_BOLD
    maxLines = lines
    ellipsize = TextUtils.TruncateAt.END
    setShadowLayer(6f, 0f, 1f, 0x99000000.toInt())
}

internal fun rounded(color: Int, radius: Int, stroke: Int = 0, strokeColor: Int = 0) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = radius.toFloat()
    if (stroke > 0) setStroke(stroke, strokeColor)
}

internal fun View.fadeIn(dy: Float = 0f) {
    if (visibility == View.VISIBLE && alpha == 1f) return
    animate().cancel()
    if (visibility != View.VISIBLE) { alpha = 0f; translationY = dy }
    visibility = View.VISIBLE
    animate().alpha(1f).translationY(0f).setDuration(220).start()
}

internal fun View.fadeOut() {
    if (visibility != View.VISIBLE) return
    animate().cancel()
    animate().alpha(0f).setDuration(180).withEndAction { visibility = View.GONE }.start()
}

internal fun fmt(ms: Long): String {
    val s = maxOf(0L, ms / 1000)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%02d:%02d".format(m, sec)
}

private fun clock(sec: Long) = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(sec * 1000))

/** Barra orizzontale: traccia, riempimento e (facoltativo) un indicatore per la posizione cercata. */
internal class Bar(ctx: Context, private val accent: Int) : View(ctx) {
    var progress = 0f
        set(v) { field = v.coerceIn(0f, 1f); invalidate() }
    var marker = -1f
        set(v) { field = v; invalidate() }
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private val r = RectF()

    override fun onDraw(c: Canvas) {
        val h = height.toFloat()
        val bar = if (marker >= 0) h * 0.32f else h
        val top = (h - bar) / 2
        val rad = bar / 2
        p.color = 0x40FFFFFF
        r.set(0f, top, width.toFloat(), top + bar); c.drawRoundRect(r, rad, rad, p)
        p.color = accent
        r.set(0f, top, width * progress, top + bar); c.drawRoundRect(r, rad, rad, p)
        if (marker >= 0) {
            p.color = Color.WHITE
            c.drawCircle(width * marker.coerceIn(0f, 1f), h / 2, h / 2, p)
        }
    }
}

/** Banner "da televisore" per la diretta: numero, logo, nome, programma in onda e successivo. */
internal class ChannelBanner(ctx: Context, private val accent: Int) {
    private val logo = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
    private val initials = ctx.label(26f, 0x66FFFFFF, true).apply { gravity = Gravity.CENTER }
    private val num = ctx.label(30f, accent, true)
    private val name = ctx.label(26f, Color.WHITE, true)
    private val group = ctx.label(14f, TEXT_2)
    private val clockV = ctx.label(18f, Color.WHITE, true)
    private val nowTime = ctx.label(15f, accent, true)
    private val nowTitle = ctx.label(19f, Color.WHITE, true)
    private val bar = Bar(ctx, accent)
    private val nextV = ctx.label(15f, TEXT_2)
    private val epgBox: LinearLayout
    val root: LinearLayout

    init {
        val logoBox = FrameLayout(ctx).apply {
            background = rounded(0x1FFFFFFF, ctx.dp(14f))
            setPadding(ctx.dp(10f), ctx.dp(10f), ctx.dp(10f), ctx.dp(10f))
            addView(initials, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(logo, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        val head = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(num, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { rightMargin = ctx.dp(14f) })
            addView(name, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            addView(clockV, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = ctx.dp(16f) })
        }
        val nowRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(nowTime, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { rightMargin = ctx.dp(10f) })
            addView(nowTitle, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        }
        epgBox = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            addView(nowRow)
            addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, ctx.dp(5f)).apply { topMargin = ctx.dp(8f); bottomMargin = ctx.dp(8f) })
            addView(nextV)
        }
        val texts = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            addView(head)
            addView(group, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { bottomMargin = ctx.dp(10f) })
            addView(epgBox)
        }
        root = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = rounded(CARD, ctx.dp(20f))
            elevation = ctx.dp(8f).toFloat()
            setPadding(ctx.dp(20f), ctx.dp(18f), ctx.dp(26f), ctx.dp(18f))
            addView(logoBox, LinearLayout.LayoutParams(ctx.dp(132f), ctx.dp(96f)).apply { rightMargin = ctx.dp(22f) })
            addView(texts, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            visibility = View.GONE
        }
    }

    fun bind(number: String?, title: String, sub: String, logoUrl: String?) {
        num.text = number ?: ""
        num.visibility = if (number.isNullOrEmpty()) View.GONE else View.VISIBLE
        name.text = title
        group.text = sub
        group.visibility = if (sub.isEmpty()) View.GONE else View.VISIBLE
        clockV.text = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date())
        initials.text = title.split(' ').filter { it.isNotBlank() }.take(2).joinToString("") { it.take(1).uppercase() }
        initials.visibility = View.VISIBLE
        Images.load(logoUrl, 320, logo) { ok -> if (ok) initials.visibility = View.GONE }
    }

    /** null = in caricamento; lista vuota = nessuna guida per questo canale. */
    fun epg(items: JSONArray?) {
        val now = System.currentTimeMillis() / 1000
        var cur: JSONObject? = null
        var next: JSONObject? = null
        if (items != null) for (i in 0 until items.length()) {
            val o = items.optJSONObject(i) ?: continue
            val s = o.optLong("s"); val e = o.optLong("e")
            if (cur == null && s <= now && e > now) cur = o
            else if (s > now && (next == null || s < next.optLong("s"))) next = o
        }
        if (items == null) {
            epgBox.alpha = 0.4f
            return
        }
        epgBox.alpha = 1f
        if (cur == null && next == null) {
            nowTime.visibility = View.GONE
            nowTitle.text = L10n.t("noEpg")
            nowTitle.setTextColor(TEXT_2)
            bar.visibility = View.GONE
            nextV.visibility = View.GONE
            return
        }
        nowTitle.setTextColor(Color.WHITE)
        if (cur != null) {
            val s = cur.optLong("s"); val e = cur.optLong("e")
            nowTime.visibility = View.VISIBLE
            nowTime.text = "${clock(s)}–${clock(e)}"
            nowTitle.text = cur.optString("t")
            bar.visibility = View.VISIBLE
            bar.progress = (now - s).toFloat() / maxOf(1L, e - s)
        } else {
            nowTime.visibility = View.GONE
            nowTitle.text = L10n.t("noEpg")
            nowTitle.setTextColor(TEXT_2)
            bar.visibility = View.GONE
        }
        nextV.visibility = if (next != null) View.VISIBLE else View.GONE
        if (next != null) nextV.text = "${L10n.t("after")}  ${clock(next.optLong("s"))}  ${next.optString("t")}"
    }

    val visible get() = root.visibility == View.VISIBLE
    fun show() = root.fadeIn(root.context.dp(24f).toFloat())
    fun hide() = root.fadeOut()
}

/** Ricerca con il telecomando: anteprima del fotogramma, tempo di arrivo e salto rispetto a dove si era. */
internal class Scrubber(ctx: Context, accent: Int) {
    private val thumb = ImageView(ctx).apply {
        scaleType = ImageView.ScaleType.CENTER_CROP
        background = rounded(Color.BLACK, ctx.dp(10f), ctx.dp(2f), Color.WHITE)
        clipToOutline = true
        setPadding(ctx.dp(2f), ctx.dp(2f), ctx.dp(2f), ctx.dp(2f))
    }
    private val time = ctx.label(22f, Color.WHITE, true).apply { gravity = Gravity.CENTER }
    private val delta = ctx.label(15f, accent, true).apply { gravity = Gravity.CENTER }
    private val col = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        addView(thumb, LinearLayout.LayoutParams(ctx.dp(256f), ctx.dp(144f)).apply { bottomMargin = ctx.dp(10f) })
        addView(time)
        addView(delta, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { bottomMargin = ctx.dp(12f) })
    }
    private val bar = Bar(ctx, accent)
    private val leftT = ctx.label(15f, TEXT_2)
    private val rightT = ctx.label(15f, TEXT_2)
    val root: FrameLayout

    init {
        val times = FrameLayout(ctx).apply {
            addView(leftT, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.START))
            addView(rightT, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.END))
        }
        val bottom = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, ctx.dp(16f)))
            addView(times, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = ctx.dp(6f) })
        }
        root = FrameLayout(ctx).apply {
            setPadding(ctx.dp(56f), ctx.dp(80f), ctx.dp(56f), ctx.dp(40f))
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xE6000000.toInt(), 0x00000000))
            addView(col, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM).apply { bottomMargin = ctx.dp(44f) })
            addView(bottom, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))
            visibility = View.GONE
        }
    }

    fun update(target: Long, current: Long, dur: Long, jump: Long, thumbs: Boolean) {
        val f = target.toFloat() / maxOf(1L, dur)
        bar.progress = current.toFloat() / maxOf(1L, dur)
        bar.marker = f
        time.text = fmt(target)
        delta.text = if (jump == 0L) "" else (if (jump > 0) "+" else "−") + fmt(kotlin.math.abs(jump))
        leftT.text = fmt(current)
        rightT.text = fmt(dur)
        thumb.visibility = if (thumbs) View.VISIBLE else View.GONE
        col.post {
            val w = root.width - root.paddingLeft - root.paddingRight
            val x = f * w - col.width / 2f
            col.translationX = x.coerceIn(0f, maxOf(0f, (w - col.width).toFloat()))
        }
    }

    fun thumb(b: Bitmap) = thumb.setImageBitmap(b)
    fun clearThumb() = thumb.setImageDrawable(null)

    val visible get() = root.visibility == View.VISIBLE
    fun show() = root.fadeIn()
    fun hide() = root.fadeOut()
}

/** Schermata di pausa: sfondo del titolo, voti, trama. */
internal class PauseScreen(ctx: Context, accent: Int) {
    private val backdrop = ImageView(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
    private val eyebrow = ctx.label(14f, accent, true).apply { letterSpacing = 0.2f; text = L10n.t("paused").uppercase() }
    private val title = ctx.label(40f, Color.WHITE, true, 2)
    private val line = ctx.label(17f, TEXT_2)
    private val ratings = ctx.label(17f, Color.WHITE, true)
    private val plot = ctx.label(17f, 0xFFE6E0D6.toInt(), lines = 4).apply { setLineSpacing(0f, 1.25f) }
    private val pos = ctx.label(16f, TEXT_2)
    private val bar = Bar(ctx, accent)
    val root: FrameLayout

    init {
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            addView(eyebrow, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { bottomMargin = ctx.dp(10f) })
            addView(title)
            addView(line, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = ctx.dp(8f) })
            addView(ratings, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = ctx.dp(10f) })
            addView(plot, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = ctx.dp(16f) })
            addView(bar, LinearLayout.LayoutParams(ctx.dp(320f), ctx.dp(4f)).apply { topMargin = ctx.dp(26f) })
            addView(pos, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = ctx.dp(8f) })
        }
        val shadeL = View(ctx).apply {
            background = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, intArrayOf(0xF2000000.toInt(), 0xB3000000.toInt(), 0x33000000))
        }
        val shadeB = View(ctx).apply {
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xCC000000.toInt(), 0x00000000))
        }
        root = FrameLayout(ctx).apply {
            setBackgroundColor(0x99000000.toInt())
            addView(backdrop, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(shadeL, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(shadeB, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(col, FrameLayout.LayoutParams((ctx.resources.displayMetrics.widthPixels * 0.55f).toInt(), WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
                leftMargin = ctx.dp(64f); bottomMargin = ctx.dp(64f)
            })
            visibility = View.GONE
        }
    }

    fun bind(info: JSONObject?, fallbackTitle: String) {
        title.text = info?.optString("title")?.ifEmpty { null } ?: fallbackTitle
        fun set(v: TextView, s: String?) { v.text = s ?: ""; v.visibility = if (s.isNullOrEmpty()) View.GONE else View.VISIBLE }
        set(line, info?.optString("line"))
        set(ratings, info?.optString("ratings"))
        set(plot, info?.optString("plot"))
        Images.load(info?.optString("backdrop")?.ifEmpty { null }, 1280, backdrop)
    }

    fun position(cur: Long, dur: Long) {
        pos.text = "${fmt(cur)} / ${fmt(dur)}"
        bar.progress = cur.toFloat() / maxOf(1L, dur)
    }

    val visible get() = root.visibility == View.VISIBLE
    fun show() = root.fadeIn()
    fun hide() = root.fadeOut()
}

/** Scheda "Prossimo episodio" con conto alla rovescia. */
internal class NextCard(ctx: Context, accent: Int) {
    private val title = ctx.label(20f, Color.WHITE, true, 2)
    private val count = ctx.label(16f, TEXT_2)
    private val bar = Bar(ctx, accent)
    val root: LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(CARD, ctx.dp(18f), ctx.dp(1f), 0x33FFFFFF)
        elevation = ctx.dp(8f).toFloat()
        setPadding(ctx.dp(22f), ctx.dp(18f), ctx.dp(22f), ctx.dp(18f))
        addView(ctx.label(13f, accent, true).apply { letterSpacing = 0.18f; text = L10n.t("upNext").uppercase() })
        addView(title, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = ctx.dp(6f) })
        addView(count, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = ctx.dp(4f) })
        addView(bar, LinearLayout.LayoutParams(MATCH_PARENT, ctx.dp(4f)).apply { topMargin = ctx.dp(12f); bottomMargin = ctx.dp(12f) })
        addView(ctx.label(14f, TEXT_2, lines = 2).apply { text = L10n.t("nextHint") })
        visibility = View.GONE
    }

    fun bind(label: String) { title.text = label }

    @SuppressLint("SetTextI18n")
    fun tick(leftMs: Long, totalMs: Long) {
        count.text = L10n.t("startsIn", ((leftMs + 999) / 1000).toInt())
        bar.progress = leftMs.toFloat() / maxOf(1L, totalMs)
    }

    val visible get() = root.visibility == View.VISIBLE
    fun show() = root.fadeIn(root.context.dp(20f).toFloat())
    fun hide() = root.fadeOut()
}

internal fun skipButton(ctx: Context) = ctx.label(19f, Color.WHITE, true).apply {
    text = L10n.t("skipIntro") + "  ›"
    background = rounded(0xCC141210.toInt(), ctx.dp(10f), ctx.dp(2f), Color.WHITE)
    setPadding(ctx.dp(26f), ctx.dp(14f), ctx.dp(26f), ctx.dp(14f))
    setShadowLayer(0f, 0f, 0f, 0)
    visibility = View.GONE
}

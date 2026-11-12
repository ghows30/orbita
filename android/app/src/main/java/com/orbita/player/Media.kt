package com.orbita.player

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaDataSource
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.widget.ImageView
import okhttp3.Request
import java.util.concurrent.Executors

/** Immagini (loghi canali, sfondi) scaricate con la protezione di [Net], ridotte e tenute in memoria. */
object Images {
    private val cache = object : LruCache<String, Bitmap>(20 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val pool = Executors.newFixedThreadPool(2)
    private val main = Handler(Looper.getMainLooper())

    fun load(url: String?, maxW: Int, target: ImageView, done: ((Boolean) -> Unit)? = null) {
        target.tag = url
        target.setImageDrawable(null)
        if (url == null) return done?.invoke(false) ?: Unit
        cache.get(url)?.let { target.setImageBitmap(it); done?.invoke(true); return }
        pool.execute {
            val bmp = runCatching { fetch(url, maxW) }.getOrNull()
            if (bmp != null) cache.put(url, bmp)
            main.post {
                if (target.tag != url) return@post
                if (bmp != null) target.setImageBitmap(bmp)
                done?.invoke(bmp != null)
            }
        }
    }

    private fun fetch(url: String, maxW: Int): Bitmap? = Net.get(url, null, 12).use { r ->
        if (!r.isSuccessful) return null
        val bytes = Net.limited(r.body!!.byteStream(), 8L * 1024 * 1024).readBytes()
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        var s = 1
        while (o.outWidth / (s * 2) >= maxW) s *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = s })
    }
}

/**
 * Sorgente a richieste HTTP "Range" per [MediaMetadataRetriever]: passa dallo stesso client protetto
 * del player (anti-SSRF, User-Agent del provider) e scarica solo i blocchi che servono per un fotogramma.
 */
private class RangeSource(private val url: String, private val ua: String?) : MediaDataSource() {
    private val block = 256 * 1024
    private val blocks = object : LinkedHashMap<Long, ByteArray>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, ByteArray>?) = size > 32
    }
    private var total = -2L
    @Volatile private var closed = false

    private fun range(from: Long, to: Long): Pair<Long, ByteArray>? {
        if (closed) return null
        val req = Request.Builder().url(url).header("User-Agent", Net.cleanUa(ua)).header("Range", "bytes=$from-$to").build()
        Net.streamClient.newCall(req).execute().use { r ->
            if (r.code != 206) return null // il server ignora i Range: scaricare tutto il film non ha senso
            val len = r.header("Content-Range")?.substringAfter('/')?.toLongOrNull() ?: -1L
            return len to Net.limited(r.body!!.byteStream(), (to - from + 1)).readBytes()
        }
    }

    override fun getSize(): Long {
        if (total == -2L) total = runCatching { range(0, 0)?.first }.getOrNull() ?: -1L
        return total
    }

    override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
        if (closed || size == 0) return if (size == 0) 0 else -1
        val len = getSize()
        if (len in 0..position) return -1
        val idx = position / block
        val data = blocks[idx] ?: runCatching { range(idx * block, idx * block + block - 1)?.second }.getOrNull()?.also { blocks[idx] = it } ?: return -1
        val off = (position - idx * block).toInt()
        if (off >= data.size) return -1
        val n = minOf(size, data.size - off)
        System.arraycopy(data, off, buffer, offset, n)
        return n
    }

    override fun close() { closed = true }
}

/** Anteprime per la barra di avanzamento: un fotogramma ogni 10 s, su un thread a parte, solo l'ultima richiesta conta. */
class Thumbs(private val url: String, private val ua: String?) {
    private val exec = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val cache = LruCache<Long, Bitmap>(48)
    private var mmr: MediaMetadataRetriever? = null
    private var fails = 0
    @Volatile private var wanted = -1L
    @Volatile var broken = false
        private set

    fun request(posMs: Long, cb: (Bitmap) -> Unit) {
        if (broken) return
        val key = posMs / 10_000
        cache.get(key)?.let { cb(it); return }
        wanted = key
        exec.execute {
            if (wanted != key || broken) return@execute
            val r = mmr ?: runCatching { MediaMetadataRetriever().apply { setDataSource(RangeSource(url, ua)) } }
                .getOrElse { broken = true; null }?.also { mmr = it } ?: return@execute
            val us = key * 10_000_000L
            val bmp = runCatching {
                if (Build.VERSION.SDK_INT >= 27) r.getScaledFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 384, 216)
                else r.getFrameAtTime(us, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)?.let {
                    Bitmap.createScaledBitmap(it, 384, maxOf(1, it.height * 384 / maxOf(1, it.width)), true)
                }
            }.getOrNull()
            if (bmp == null) {
                if (++fails >= 3) broken = true
                return@execute
            }
            fails = 0
            cache.put(key, bmp)
            main.post { if (wanted == key && !broken) cb(bmp) }
        }
    }

    fun release() {
        broken = true
        exec.execute { runCatching { mmr?.release() }; mmr = null }
        exec.shutdown()
    }
}

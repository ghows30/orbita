package com.orbita.player

import android.util.Xml
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import java.io.BufferedInputStream
import java.io.InputStream
import java.util.Calendar
import java.util.TimeZone
import java.util.zip.GZIPInputStream

/** Guida XMLTV (anche .gz) letta in streaming: tiene solo i canali richiesti e una finestra di tempo. */
object Xmltv {
    private const val MAX_BYTES = 600L * 1024 * 1024
    private const val MAX_PER_CHANNEL = 200

    fun time(s: String?): Long? {
        val t = s?.trim() ?: return null
        if (t.length < 12 || !t.substring(0, 12).all { it.isDigit() }) return null
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        c.clear()
        c.set(t.substring(0, 4).toInt(), t.substring(4, 6).toInt() - 1, t.substring(6, 8).toInt(),
            t.substring(8, 10).toInt(), t.substring(10, 12).toInt(), if (t.length >= 14 && t[12].isDigit()) t.substring(12, 14).toInt() else 0)
        var sec = c.timeInMillis / 1000
        val tz = Regex("""([+-])(\d{2})(\d{2})""").find(t.substring(12))
        if (tz != null) {
            val sign = if (tz.groupValues[1] == "-") -1 else 1
            sec -= sign * (tz.groupValues[2].toInt() * 3600 + tz.groupValues[3].toInt() * 60)
        }
        return sec
    }

    fun parse(raw: InputStream, wanted: Set<String>, from: Long, to: Long): JSONObject {
        val buf = BufferedInputStream(Net.limited(raw, MAX_BYTES), 1 shl 16)
        buf.mark(2)
        val gz = buf.read() == 0x1f && buf.read() == 0x8b
        buf.reset()
        val input: InputStream = if (gz) BufferedInputStream(Net.limited(GZIPInputStream(buf, 1 shl 16), MAX_BYTES), 1 shl 16) else buf

        val out = HashMap<String, JSONArray>()
        val p = Xml.newPullParser()
        p.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
        p.setInput(input, null)
        var ch: String? = null
        var s = 0L
        var e = 0L
        var title = ""
        var desc = ""
        var field: String? = null
        var ev = p.eventType
        while (ev != XmlPullParser.END_DOCUMENT) {
            when (ev) {
                XmlPullParser.START_TAG -> when (p.name) {
                    "programme" -> {
                        val c = p.getAttributeValue(null, "channel")?.lowercase()
                        val st = time(p.getAttributeValue(null, "start"))
                        val en = time(p.getAttributeValue(null, "stop"))
                        ch = if (c != null && c in wanted && st != null && en != null && en > st && en >= from && st <= to) c else null
                        s = st ?: 0; e = en ?: 0; title = ""; desc = ""
                    }
                    "title", "desc" -> field = if (ch != null) p.name else null
                }
                XmlPullParser.TEXT -> when (field) {
                    "title" -> if (title.isEmpty()) title = p.text.trim().take(300)
                    "desc" -> if (desc.isEmpty()) desc = p.text.trim().take(1500)
                }
                XmlPullParser.END_TAG -> when (p.name) {
                    "title", "desc" -> field = null
                    "programme" -> {
                        val c = ch
                        if (c != null) {
                            val list = out.getOrPut(c) { JSONArray() }
                            if (list.length() < MAX_PER_CHANNEL) list.put(JSONObject().put("s", s).put("e", e).put("t", title).put("d", desc))
                        }
                        ch = null
                    }
                }
            }
            ev = p.next()
        }
        val res = JSONObject()
        for ((k, v) in out) {
            val sorted = (0 until v.length()).map { v.getJSONObject(it) }.sortedBy { it.getLong("s") }
            res.put(k, JSONArray(sorted))
        }
        return res
    }
}

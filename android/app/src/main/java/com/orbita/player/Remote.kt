package com.orbita.player

import android.content.Context
import android.util.Base64
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.security.SecureRandom

/**
 * "Aggiungi dallo smartphone": mini server HTTP sulla rete di casa, acceso solo mentre la TV mostra il QR.
 * - risponde solo a client della rete locale (192.168.x, 10.x, 172.16-31.x, link-local);
 * - ogni sessione ha un codice di 6 cifre (nel QR o da digitare); 5 codici sbagliati spengono il server;
 * - accetta un solo invio riuscito, poi resta acceso solo per comunicare l'esito al telefono;
 * - si spegne da solo dopo [TTL_MS].
 * Il JSON ricevuto passa a JavaScript ([onSource]), che lo valida come il form della TV.
 * Modalità: "source" (playlist) oppure "keys" (chiavi API TMDB/OMDb dalle Impostazioni).
 */
class Remote(private val ctx: Context, private val onSource: (String) -> Unit) {
    @Volatile private var server: ServerSocket? = null
    @Volatile private var code = ""
    @Volatile private var state = "waiting" // waiting | loading | ok | error
    @Volatile private var message = ""
    @Volatile private var failures = 0
    @Volatile private var startedAt = 0L
    @Volatile private var mode = "source"

    /** Avvia (o riavvia) la sessione; restituisce {url, code, qr} oppure null se la TV non è in rete locale. */
    @Synchronized
    fun start(mode: String = "source"): JSONObject? {
        stop()
        this.mode = if (mode == "keys") "keys" else "source"
        val ip = lanAddress() ?: return null
        val ss = PORTS.firstNotNullOfOrNull { p -> runCatching { ServerSocket(p, 8) }.getOrNull() } ?: return null
        code = (100000 + rnd.nextInt(900000)).toString()
        state = "waiting"
        message = ""
        failures = 0
        startedAt = System.currentTimeMillis()
        server = ss
        Thread({ loop(ss) }, "orbita-remote").apply { isDaemon = true }.start()
        val base = "http://${ip.hostAddress}:${ss.localPort}"
        return JSONObject()
            .put("url", base)
            .put("code", code)
            .put("qr", qrSvg("$base/?c=$code"))
    }

    @Synchronized
    fun stop() {
        runCatching { server?.close() }
        server = null
    }

    /** Esito del caricamento sulla TV, mostrato al telefono. */
    fun result(ok: Boolean, msg: String) {
        state = if (ok) "ok" else "error"
        message = msg.take(300)
    }

    private fun loop(ss: ServerSocket) {
        ss.soTimeout = 30_000
        while (!ss.isClosed) {
            if (System.currentTimeMillis() - startedAt > TTL_MS) break
            val s = try {
                ss.accept()
            } catch (e: java.net.SocketTimeoutException) {
                continue
            } catch (e: SocketException) {
                break
            }
            s.use { runCatching { handle(it) } }
        }
        runCatching { ss.close() }
    }

    private fun handle(s: Socket) {
        s.soTimeout = 8_000
        val out = s.getOutputStream()
        if (!local(s.inetAddress)) return send(out, 403, "text/plain", L10n.t("homeOnly"))
        val input = BufferedInputStream(s.getInputStream())
        val line = readLine(input) ?: return
        val parts = line.split(' ')
        if (parts.size < 3) return send(out, 400, "text/plain", "")
        val (method, target) = parts
        var length = 0
        while (true) {
            val h = readLine(input) ?: return
            if (h.isEmpty()) break
            if (h.startsWith("content-length:", true)) length = h.substringAfter(':').trim().toIntOrNull() ?: -1
        }
        val path = target.substringBefore('?')
        val query = target.substringAfter('?', "")
        when {
            method == "GET" && path == "/" -> send(out, 200, "text/html", page())
            method == "GET" && path == "/status" -> {
                if (param(query, "c") != code) return send(out, 403, "application/json", """{"state":"denied"}""")
                send(out, 200, "application/json", JSONObject().put("state", state).put("msg", message).toString())
            }
            method == "POST" && path == "/add" -> {
                if (length !in 1..MAX_BODY) return send(out, 413, "application/json", err(L10n.t("tooBig")))
                val body = JSONObject(String(readN(input, length), Charsets.UTF_8))
                if (body.optString("code") != code) {
                    if (++failures >= 5) {
                        send(out, 403, "application/json", err(L10n.t("tooManyCodes")))
                        return stop()
                    }
                    return send(out, 403, "application/json", err(L10n.t("wrongCode")))
                }
                if (state == "loading" || state == "ok") return send(out, 409, "application/json", err(L10n.t("already")))
                val key = if (mode == "keys") "keys" else "source"
                val src = body.optJSONObject(key) ?: return send(out, 400, "application/json", err(L10n.t("missing")))
                state = "loading"
                message = ""
                onSource(src.toString())
                send(out, 200, "application/json", """{"ok":true}""")
            }
            else -> send(out, 404, "text/plain", "")
        }
    }

    private fun page(): String = ctx.assets.open("remote.html").use { String(it.readBytes(), Charsets.UTF_8) }
        .replaceFirst("<html lang=\"it\">", "<html lang=\"${L10n.lang}\" data-mode=\"$mode\">")

    private fun err(m: String) = JSONObject().put("error", m).toString()

    private fun param(q: String, k: String) =
        q.split('&').firstOrNull { it.startsWith("$k=") }?.substringAfter('=')

    private fun readLine(i: InputStream): String? {
        val b = ByteArrayOutputStream()
        while (true) {
            val c = i.read()
            if (c < 0) return if (b.size() == 0) null else b.toString("UTF-8")
            if (c == '\n'.code) return b.toString("UTF-8").trimEnd('\r')
            if (b.size() > 8192) return null
            b.write(c)
        }
    }

    private fun readN(i: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = i.read(buf, off, n - off)
            if (r < 0) break
            off += r
        }
        return buf.copyOf(off)
    }

    private fun send(out: OutputStream, code: Int, mime: String, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $code ${if (code == 200) "OK" else "Error"}\r\n" +
            "Content-Type: $mime; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Cache-Control: no-store\r\n" +
            "X-Content-Type-Options: nosniff\r\n" +
            "Referrer-Policy: no-referrer\r\n" +
            "X-Frame-Options: DENY\r\n" +
            "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'\r\n" +
            "Connection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.US_ASCII))
        out.write(bytes)
        out.flush()
    }

    private fun local(a: InetAddress): Boolean {
        val v4 = if (a is Inet4Address) a else {
            val b = a.address
            val mapped = b.size == 16 && (0 until 10).all { b[it].toInt() == 0 } && b[10].toInt() == -1 && b[11].toInt() == -1
            if (mapped) InetAddress.getByAddress(b.copyOfRange(12, 16)) else return a.isLinkLocalAddress || a.isSiteLocalAddress
        }
        return v4.isSiteLocalAddress || v4.isLinkLocalAddress
    }

    private fun lanAddress(): InetAddress? {
        val all = runCatching { NetworkInterface.getNetworkInterfaces().toList() }.getOrNull() ?: return null
        return all.filter { it.isUp && !it.isLoopback && !it.isVirtual }
            .sortedBy { if (it.name.startsWith("wlan") || it.name.startsWith("eth")) 0 else 1 }
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }
    }

    private fun qrSvg(text: String): String {
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.MARGIN to 2))
        val d = StringBuilder()
        for (y in 0 until m.height) for (x in 0 until m.width) if (m[x, y]) d.append("M$x ${y}h1v1h-1z")
        val svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.width} ${m.height}" shape-rendering="crispEdges">""" +
            """<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="$d"/></svg>"""
        return "data:image/svg+xml;base64," + Base64.encodeToString(svg.toByteArray(), Base64.NO_WRAP)
    }

    companion object {
        private val PORTS = listOf(8765, 8766, 8767, 0)
        private const val MAX_BODY = 32 * 1024
        private const val TTL_MS = 15 * 60 * 1000L
        private val rnd = SecureRandom()
    }
}

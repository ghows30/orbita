package com.orbita.player

import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

class BlockedException(msg: String) : IOException(msg)
class TooBigException : IOException("Risposta troppo grande")

/**
 * Rete verso i provider con protezione SSRF: solo http/https e il DNS rifiuta indirizzi
 * loopback / link-local / multicast / metadata cloud. Il controllo è sull'IP effettivo usato
 * dalla connessione (anche dopo ogni redirect), quindi regge al DNS rebinding.
 * Le reti private (192.168.x, 10.x…) sono ammesse: su TV è normale avere un server IPTV in casa.
 */
object Net {
    const val DEFAULT_UA = "VLC/3.0.21 LibVLC/3.0.21"

    fun blocked(a: InetAddress): Boolean {
        if (a.isLoopbackAddress || a.isAnyLocalAddress || a.isLinkLocalAddress || a.isMulticastAddress) return true
        val b = a.address
        if (a is Inet4Address) {
            val o0 = b[0].toInt() and 0xff
            val o1 = b[1].toInt() and 0xff
            if (o0 == 0 || o0 >= 240) return true
            if (o0 == 100 && o1 in 64..127) return true // CGNAT
            if (o0 == 169 && o1 == 254) return true // metadata cloud
        }
        if (a is Inet6Address) {
            // ::ffff:127.0.0.1 ecc.
            val mapped = b.size == 16 && (0 until 10).all { b[it].toInt() == 0 } && b[10].toInt() == -1 && b[11].toInt() == -1
            if (mapped) return blocked(InetAddress.getByAddress(b.copyOfRange(12, 16)))
        }
        return false
    }

    private val guardDns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            if (hostname.equals("localhost", true) || hostname.endsWith(".localhost", true)) throw BlockedException("Indirizzo non consentito")
            val ok = Dns.SYSTEM.lookup(hostname).filterNot(::blocked)
            if (ok.isEmpty()) throw BlockedException("Indirizzo non consentito")
            return ok
        }
    }

    val client: OkHttpClient = OkHttpClient.Builder()
        .dns(guardDns)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .retryOnConnectionFailure(true)
        .build()

    fun cleanUa(ua: String?): String {
        val t = ua?.replace(Regex("[\\r\\n\\u0000]"), "")?.trim()?.take(200)
        return if (t.isNullOrEmpty()) DEFAULT_UA else t
    }

    fun validUrl(raw: String?): String? {
        if (raw == null || raw.length > 8192) return null
        val u = raw.trim().toHttpUrlOrNull() ?: return null
        if (u.scheme != "http" && u.scheme != "https") return null
        return u.toString()
    }

    fun get(url: String, ua: String?, timeoutSec: Long = 45): Response {
        val u = validUrl(url) ?: throw BlockedException("URL non valido")
        val c = if (timeoutSec == 30L) client else client.newBuilder().readTimeout(timeoutSec, TimeUnit.SECONDS).build()
        return c.newCall(Request.Builder().url(u).header("User-Agent", cleanUa(ua)).header("Accept", "*/*").build()).execute()
    }

    /** Stream con tetto di byte: protegge dalla memoria esaurita con risposte infinite. */
    fun limited(input: InputStream, max: Long): InputStream = object : FilterInputStream(input) {
        var n = 0L
        override fun read(): Int {
            val r = super.read()
            if (r >= 0 && ++n > max) throw TooBigException()
            return r
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val r = super.read(b, off, len)
            if (r > 0) {
                n += r
                if (n > max) throw TooBigException()
            }
            return r
        }
    }

    fun friendly(e: Throwable): Pair<Int, String> = when (e) {
        is BlockedException -> 403 to "Indirizzo non consentito per sicurezza."
        is TooBigException -> 413 to "Risposta del provider troppo grande."
        is UnknownHostException -> 502 to "Server del provider non trovato."
        is java.net.SocketTimeoutException -> 504 to "Il provider non risponde (timeout)."
        is java.net.ConnectException -> 502 to "Connessione rifiutata dal provider."
        is javax.net.ssl.SSLException -> 502 to "Connessione sicura non riuscita (certificato)."
        else -> 502 to "Errore di rete verso il provider."
    }
}

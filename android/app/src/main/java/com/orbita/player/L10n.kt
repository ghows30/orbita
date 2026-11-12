package com.orbita.player

/**
 * Testi nativi (player, tasto Indietro, server per lo smartphone) nella lingua scelta
 * nelle Impostazioni dell'interfaccia web. La lingua arriva dal ponte JS (setLang) e dal player (campo "lang").
 */
object L10n {
    val SUPPORTED = setOf("it", "en", "es", "de")

    @Volatile
    var lang: String = java.util.Locale.getDefault().language.takeIf { it in SUPPORTED } ?: "en"
        set(v) { if (v in SUPPORTED) field = v }

    private val strings: Map<String, Map<String, String>> = mapOf(
        "backAgain" to mapOf(
            "it" to "Premi di nuovo Indietro per uscire", "en" to "Press Back again to exit",
            "es" to "Pulsa Atrás otra vez para salir", "de" to "Zum Beenden erneut Zurück drücken"),
        "netBack" to mapOf(
            "it" to "Rete tornata, riprendo…", "en" to "Network is back, resuming…",
            "es" to "La red ha vuelto, reanudando…", "de" to "Netz wieder da, setze fort…"),
        "altFormat" to mapOf(
            "it" to "Provo un formato alternativo…", "en" to "Trying an alternative format…",
            "es" to "Probando un formato alternativo…", "de" to "Versuche ein anderes Format…"),
        "denied" to mapOf(
            "it" to "Accesso negato dal provider (%1\$d). Controlla abbonamento o connessioni attive.",
            "en" to "Access denied by the provider (%1\$d). Check your subscription or active connections.",
            "es" to "Acceso denegado por el proveedor (%1\$d). Revisa la suscripción o las conexiones activas.",
            "de" to "Zugriff vom Anbieter verweigert (%1\$d). Prüfe Abo oder aktive Verbindungen."),
        "notFound" to mapOf(
            "it" to "Contenuto non trovato sul server del provider (404).", "en" to "Content not found on the provider's server (404).",
            "es" to "Contenido no encontrado en el servidor del proveedor (404).", "de" to "Inhalt auf dem Server des Anbieters nicht gefunden (404)."),
        "rejected" to mapOf(
            "it" to "Il provider ha rifiutato la richiesta (%1\$d).", "en" to "The provider rejected the request (%1\$d).",
            "es" to "El proveedor rechazó la petición (%1\$d).", "de" to "Der Anbieter hat die Anfrage abgelehnt (%1\$d)."),
        "retry" to mapOf(
            "it" to "Connessione interrotta. Nuovo tentativo tra %1\$ds (%2\$d/%3\$d)",
            "en" to "Connection lost. Retrying in %1\$ds (%2\$d/%3\$d)",
            "es" to "Conexión interrumpida. Reintentando en %1\$d s (%2\$d/%3\$d)",
            "de" to "Verbindung unterbrochen. Neuer Versuch in %1\$d s (%2\$d/%3\$d)"),
        "cannot" to mapOf(
            "it" to "Impossibile riprodurre questo contenuto (%1\$s).", "en" to "This content cannot be played (%1\$s).",
            "es" to "No se puede reproducir este contenido (%1\$s).", "de" to "Dieser Inhalt kann nicht abgespielt werden (%1\$s)."),
        "homeOnly" to mapOf(
            "it" to "Solo dalla rete di casa", "en" to "Home network only", "es" to "Solo desde la red doméstica", "de" to "Nur aus dem Heimnetz"),
        "tooBig" to mapOf(
            "it" to "Dati troppo grandi", "en" to "Data too large", "es" to "Datos demasiado grandes", "de" to "Daten zu groß"),
        "tooManyCodes" to mapOf(
            "it" to "Troppi codici errati: riapri il QR sulla TV", "en" to "Too many wrong codes: reopen the QR on the TV",
            "es" to "Demasiados códigos erróneos: vuelve a abrir el QR en la TV", "de" to "Zu viele falsche Codes: QR auf dem TV neu öffnen"),
        "noEpg" to mapOf(
            "it" to "Nessuna informazione sul programma", "en" to "No programme information",
            "es" to "Sin información del programa", "de" to "Keine Programminformationen"),
        "after" to mapOf("it" to "Dopo", "en" to "Next", "es" to "Después", "de" to "Danach"),
        "paused" to mapOf("it" to "In pausa", "en" to "Paused", "es" to "En pausa", "de" to "Pausiert"),
        "skipIntro" to mapOf("it" to "Salta intro", "en" to "Skip intro", "es" to "Saltar intro", "de" to "Intro überspringen"),
        "upNext" to mapOf("it" to "Prossimo episodio", "en" to "Next episode", "es" to "Siguiente episodio", "de" to "Nächste Folge"),
        "startsIn" to mapOf(
            "it" to "Inizia tra %1\$d s", "en" to "Starts in %1\$d s", "es" to "Empieza en %1\$d s", "de" to "Startet in %1\$d s"),
        "nextHint" to mapOf(
            "it" to "OK: guarda ora  ·  Indietro: annulla", "en" to "OK: watch now  ·  Back: cancel",
            "es" to "OK: ver ahora  ·  Atrás: cancelar", "de" to "OK: jetzt ansehen  ·  Zurück: abbrechen"),
        "wrongCode" to mapOf(
            "it" to "Codice errato: controlla quello sulla TV", "en" to "Wrong code: check the one on the TV",
            "es" to "Código erróneo: comprueba el de la TV", "de" to "Falscher Code: prüfe den auf dem TV"),
        "already" to mapOf(
            "it" to "La TV ha già ricevuto una playlist", "en" to "The TV has already received a playlist",
            "es" to "La TV ya ha recibido una lista", "de" to "Der TV hat bereits eine Playlist erhalten"),
        "missing" to mapOf(
            "it" to "Dati mancanti", "en" to "Missing data", "es" to "Faltan datos", "de" to "Daten fehlen"),
    )

    fun t(key: String, vararg args: Any): String {
        val s = strings[key]?.let { it[lang] ?: it["en"] } ?: key
        return if (args.isEmpty()) s else String.format(java.util.Locale.ROOT, s, *args)
    }
}

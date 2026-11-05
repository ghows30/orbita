# ORBITA

Player IPTV per **Xtream Codes** e **M3U**: TV in diretta con guida TV e catch-up, film, serie, preferiti e "riprendi da dove eri".
Gira nel browser con un piccolo server locale (Node ≥ 20) che fa da proxy sicuro verso il provider.

> ORBITA non fornisce contenuti. Usa solo sorgenti che hai il diritto di guardare.

## Avvio

```bash
npm install
npm start          # build + server su http://127.0.0.1:7878
```

Sviluppo con hot reload: `npm run dev` (Vite su :5173, server su :7878). Test: `npm test`.

## Android TV e Fire TV (Firestick)

App nativa in `android/`: la stessa interfaccia in una WebView chiusa e la riproduzione nel player **ExoPlayer** (decodifica hardware, HLS/TS/MP4/MKV, audio e sottotitoli, zapping con ↑/↓ o CH+/CH−). Funziona da Fire OS 6 / Android 6 in su.

**Installazione su Firestick con Downloader**
1. Sulla Fire TV: *Impostazioni → La mia Fire TV → Opzioni sviluppatore → Installa app sconosciute* → attiva **Downloader**.
2. Apri Downloader e digita il codice ORBITA (oppure l'URL `https://github.com/<utente>/<repo>/releases/latest/download/orbita.apk`).
3. Installa e apri ORBITA.

L'URL `releases/latest/download/orbita.apk` punta sempre all'ultima versione: il codice Downloader creato su [go.aftvnews.com](https://go.aftvnews.com/) non va mai cambiato.

**Pubblicare una nuova versione**: `git tag v1.0.1 && git push --tags`. GitHub Actions compila, firma e pubblica `orbita.apk` nella Release.
Segreti richiesti nel repository (*Settings → Secrets and variables → Actions*): `ORBITA_KEYSTORE_BASE64` (keystore in base64) e `ORBITA_STORE_PASSWORD`.

**Build locale**: `npm run apk` → `android/app/build/outputs/apk/release/app-release.apk` (serve Android SDK; la chiave di firma va in `android/keystore.properties`, esclusa da Git).

> ⚠ Conserva una copia di `android/orbita-release.jks` e della sua password: senza la stessa chiave gli aggiornamenti non si installano sopra la versione esistente.

## Funzioni

- **Sorgenti**: login Xtream (si può incollare il link `get.php` intero), link M3U, file M3U locale; più playlist.
- **TV in diretta**: categorie, ricerca, preferiti, ora/dopo con barra di avanzamento, guida (XMLTV `.xml`/`.gz` o EPG Xtream), **catch-up** Xtream ("Rivedi" / "Dall'inizio").
- **Player**: HLS (hls.js), MPEG-TS (mpegts.js), MP4/WebM nativo; audio, sottotitoli, qualità, velocità, formato immagine, PiP, schermo intero; riconnessione automatica con backoff e cambio formato m3u8 ↔ ts.
- **Film e serie**: griglie a caricamento progressivo, filtri per categoria, ordinamento, schede con trama/cast (Xtream), stagioni ed episodi, episodio successivo automatico.
- **Telecomando/tastiera**: navigazione con le frecce ovunque. Nel player: Spazio play/pausa · ←/→ salta · ↑/↓ canale · F schermo intero · I tracce · L lista canali · Esc indietro.

## Sicurezza

| Rischio | Come lo gestisce ORBITA |
|---|---|
| Credenziali su disco | Fonti e librerie cifrate **AES-GCM 256** in IndexedDB con chiave **non estraibile**. Nessun fallback in chiaro. |
| Password negli URL / log | Il browser riceve solo token opachi `/p/<token>`; le playlist HLS vengono riscritte. I log del server oscurano gli URL. Credenziali sempre codificate (`encodeURIComponent`). |
| Altri siti che usano il proxy (CSRF) | Le API richiedono header `x-orbita` (impone un preflight CORS mai concesso), controllo `Origin` e `Sec-Fetch-Site`. |
| DNS rebinding | Accettato solo `Host` uguale a `127.0.0.1`/`localhost` sulla porta giusta. Il server ascolta solo su loopback. |
| SSRF | Solo http/https; IP controllato **dopo** la risoluzione DNS e a ogni redirect: bloccati loopback, link-local, metadata cloud, reti private (sbloccabili con `ORBITA_ALLOW_PRIVATE=1`). |
| XSS da playlist malevole | Il DOM si costruisce solo con `textContent`, niente `innerHTML`; CSP restrittiva (`script-src 'self'`, `frame-ancestors 'none'`…); URL `javascript:` scartati; gli SVG dei loghi sono serviti con CSP propria. |
| Risposte enormi | Limiti di dimensione e timeout su playlist, HLS, EPG (anche gzip) e immagini. |
| Controllo parentale | Categorie per adulti nascoste; PIN con PBKDF2-SHA256 (210.000 iterazioni), confronto a tempo costante. |

## Struttura

```
server/   index.mjs (router, proxy, token, header di sicurezza) · net-guard.mjs (SSRF) · xmltv.mjs (EPG streaming)
src/core/ m3u.ts · xtream.ts · api.ts · store.ts (cifratura, PIN) · util.ts · types.ts
src/ui/   player.ts · live.ts · library.ts · settings.ts · onboard.ts · dom.ts
src/      main.ts (router, navigazione spaziale) · state.ts · styles.css
tests/    parser, Xtream (provider simulato), protezioni del server
```

# Bello – Plan

> **Status:** Draft, awaiting approval
> **Date:** 2026-10-08

Bello ist ein Privacy-Spürhund: Ein CLI-Tool, das eine Website darauf untersucht, ob ihr Consent-Management (CMP) tatsächlich verhindert, dass vor bzw. ohne Einwilligung Verbindungen zu Dritten aufgebaut oder Informationen auf dem Endgerät gespeichert/ausgelesen werden (TDDDG §25, DSGVO Art. 6).

Kernthese: Viele CMPs mit „Autoblocker" (Usercentrics, CCM19, …) blockieren eingebettete Ressourcen erst, *nachdem* der Browser sie bereits angefragt hat. Der Preload-Scanner von Chromium liest das rohe HTML und startet Verbindungen für `src`-Attribute, bevor irgendein JavaScript läuft. Ein einziger TCP-/TLS-Handshake zu z. B. `www.youtube.com` überträgt die IP-Adresse des Nutzers an Google (vgl. LG München I, 20.01.2022, 3 O 17493/20). Bello weist genau das auf **Socket-Ebene** nach.

> Bello liefert technische Befunde und Einschätzungen, **keine Rechtsberatung**. Jeder Report enthält einen entsprechenden Hinweis.

---

## 1. Zielgruppe & Einsatz

- **Nutzer:** Primär die eigene Firma. Reports werden an Kunden verschickt. Das Repo ist **öffentlich** (persönlicher GitHub-Account), jeder darf Bello nutzen.
- **Leser der Reports:** Entwickler/Agentur (technische Details, Fixes) **und** Datenschutzbeauftragte/Juristen (Management-Summary, Beweissicherung).
- **Sprache:** Ausschließlich **Deutsch** (Reports, Terminal-Ausgabe, Findings). Code und Kommentare auf Englisch.
- **Lizenz:** **Apache-2.0**. Freie Nutzung (auch kommerziell), Änderung und Weitergabe; Namensnennung über Copyright-Hinweis und `NOTICE`-Datei, die bei Weitergabe erhalten bleiben müssen. Repo enthält `LICENSE` (Apache-2.0-Volltext) und `NOTICE` („Bello – Copyright 2026 k1tesurfen", plus Attributionen der Drittdaten). `package.json`: `"license": "Apache-2.0"`. Siehe §9 Abhängigkeiten & Lizenzen.

## 2. Nutzung (CLI)

Bello wird einmalig aus dem Repo installiert (siehe §16), danach:

```bash
bello example.de                       # Quick-Check: eine URL, 3 Szenarien, Terminal + voller Report
bello example.de --crawl               # Vollständiger Crawl (Sitemap, Fallback Link-Crawl)
bello scan --all                       # Nacht-Batch: alle Kunden aus bello.config.yaml
bello scan --customer acme             # Ein Kunde aus der Config
bello diff <reportA> <reportB>         # Zwei JSON-Reports vergleichen
bello vendors update                   # EasyPrivacy + DB-IP Lite aktualisieren
bello setup                            # Chromium + Datendateien laden, fehlende Systempakete melden
bello doctor                           # Umgebung prüfen, Probleme mit Lösungshinweis ausgeben
```

- `scan` ist der Default-Befehl; `https://` wird ergänzt, wenn es fehlt.
- **Quick-Check** (`bello example.de`): ca. 1–2 Min. Ausgabe: farbige Terminal-Zusammenfassung **und** vollständiges Bundle (JSON/HTML/PDF/Evidence) unter `./bello-reports/<domain>/<timestamp>/`, der Pfad wird ausgegeben.
- Wichtige Flags: `--crawl`, `--pages <n>`, `--config <file>`, `--out <dir>`, `--proxy <url>`, `--identify` (UA-Suffix `Bello/x.y`), `--reject-selector`, `--accept-selector`, `--wait <s>`, `--no-pdf`, `--headful` (Debug).
- **Exit-Codes:** `0` Grün, `1` Gelb, `2` Rot, `3` technischer Fehler.

## 3. Scan-Szenarien

Jedes Szenario läuft in einer **eigenen, frischen Browser-Instanz** (eigener Prozess, da NetLog pro Prozess geschrieben wird; leeres Profil, keine Cookies).

| # | Szenario | Ablauf | Erwartung bei korrektem CMP |
|---|---|---|---|
| A | **Keine Interaktion** | Laden, Banner ignorieren, „passiver Leser" | Keine nicht notwendigen Drittverbindungen, keine Tracking-Speicherung |
| B | **Alle ablehnen** | Laden, Banner „Ablehnen" klicken, passiver Leser, anschließend Navigation auf 1–2 interne Links (im Quick-Modus) | Wie A, auch nach Klick und Navigation |
| C | **Alle akzeptieren** | Laden, „Akzeptieren" klicken, passiver Leser | Baseline: Was lädt die Seite mit Einwilligung? |

Der **Diff C vs. A/B** zeigt, was das CMP tatsächlich steuert. Hosts, die in A/B *und* C auftauchen, sind entweder notwendig oder ungeblockt.

### „Passiver Leser" (A und B)
1. Warten auf Network-Idle.
2. Langsam bis ans Seitenende scrollen (löst `loading="lazy"`-iframes und Lazy-Scripts aus).
3. Mausbewegungen simulieren.
4. Weitere ~10 s warten (konfigurierbar, `--wait`).
5. **Niemals** etwas anderes als den Banner anklicken. Scrollen/Lesen ist keine Einwilligung, alles, was dabei lädt, ist ein Befund.

### Crawl-Modus (`--crawl`)
- URL-Quelle: `sitemap.xml` (inkl. Sitemap-Index, `robots.txt`-Verweis), Fallback: Same-Site-Link-Crawl (BFS).
- **Jede Seite × jedes Szenario = frische Session.** Jede Seite wird als möglicher Landing-Page-Einstieg getestet.
- Defaults (pro Kunde überschreibbar): max. **200 Seiten**/Site, **1 Seite gleichzeitig** pro Site (Szenarien sequenziell), **2 s Pause** zwischen Seitenaufrufen, bis zu **3 Sites parallel** im Batch.
- Nur HTML-Seiten. URL-Normalisierung (Canonical, Query-Parameter-Normalisierung, Fragment entfernen), Duplikate überspringen.

## 4. Browser-Umgebung

- Chromium über Playwright, „new headless" Modus.
- Realistischer Desktop-Chrome-User-Agent (kein Bot-Kennzeichen; optional `--identify`).
- `locale: de-DE`, `timezoneId: Europe/Berlin`, Desktop-Viewport 1920×1080, `Accept-Language: de-DE,de`.
- **Standort-Check beim Start:** Eigene Exit-IP ermitteln, per DB-IP auf Land prüfen und **warnen**, wenn sie nicht in der EU liegt (viele CMPs zeigen den Banner nur EU-IPs). Optional `--proxy`.
- Chromium-Hintergrundverkehr unterbinden bzw. herausfiltern (`--disable-background-networking`, `--disable-component-update`, `--no-pings`, Safe Browsing aus, DoH aus, damit DNS im NetLog sichtbar ist) und bekannte Chrome-eigene Hosts in der Auswertung ignorieren.

## 5. Datenerfassung (Evidence)

### 5.1 Netzwerk: Socket-Ebene (Kern)
- Chromium mit `--log-net-log=<file>` und `--net-log-capture-mode=Default` starten.
- NetLog-Parser extrahiert pro Host:
  - DNS-Auflösung (`HOST_RESOLVER_*`)
  - TCP-Connect (`TCP_CONNECT`, Ziel-IP:Port)
  - TLS-Handshake (`SSL_CONNECT`, SNI)
  - QUIC-Sessions (HTTP/3)
  - Zugehörige URL-Requests (`URL_REQUEST_START_JOB`), auch abgebrochene
  - Preconnects / Socket-Pools ohne Request
- **Ein Befund entsteht durch den Verbindungsaufbau, nicht erst durch einen erfolgreichen Request.** DNS allein = schwächeres Indiz (Info im Report), TCP/TLS = IP-Übertragung.
- Zeitbezug: Alle Ereignisse relativ zu Navigationsstart (t=0), zum **Zeitpunkt, an dem das CMP-Script geladen/initialisiert wurde**, und zum **Banner-Klick**. So kann der Report sagen: „Verbindung zu www.youtube.com 38 ms nach Navigationsstart, 412 ms *bevor* das CMP geladen war."

### 5.2 Netzwerk: CDP-Kontext
- `Network.requestWillBeSent`, `loadingFailed` (inkl. `net::ERR_ABORTED`, `ERR_BLOCKED_BY_CLIENT`), `responseReceivedExtraInfo` (Set-Cookie inkl. geblockter).
- **Initiator-Kette** (parser → Element im HTML / script → URL:Zeile / preload / preconnect).
- Abgleich NetLog ↔ CDP über URL + Zeit, damit jede Socket-Verbindung ihre Ursache bekommt.
- HAR-Export pro Szenario.

### 5.3 Speicherzugriffe (TDDDG §25)
- Cookies (1st/3rd Party) über `context.cookies()` und Set-Cookie-Header, zu Checkpoints: nach Load, nach Banner-Klick, am Ende.
- `localStorage`, `sessionStorage`, IndexedDB (Datenbanknamen) in **allen Frames**.
- Abgleich mit bekannten Tracking-Cookies/Keys aus `vendors.yaml` (`_ga`, `_gid`, `_fbp`, `_gcl_au`, `_hjSession*`, …).
- Das CMP-eigene Consent-Cookie wird als notwendig erkannt und nicht beanstandet.

### 5.4 Fingerprinting
Init-Script (in allen Frames, vor Seiten-Scripts) instrumentiert und protokolliert mit Aufrufer (Stack-Trace → Script-URL):
- Canvas: `toDataURL`, `toBlob`, `getImageData`
- WebGL: `getParameter` (insb. `UNMASKED_VENDOR/RENDERER`), `getSupportedExtensions`
- Audio: `OfflineAudioContext`, `AudioContext` + Analyser
- `navigator.plugins`/`mimeTypes`-Enumeration, `hardwareConcurrency`, `deviceMemory`, Font-Probing-Heuristik (viele `measureText`-Aufrufe mit wechselnden Fonts)

Bewertung über Heuristik (Kombination mehrerer Signale aus einem Script = Fingerprinting).

### 5.5 Google Consent Mode
- Parsing von `gcs`, `gcd`, `npa`, `dma`-Parametern in Requests an `google-analytics.com`, `googletagmanager.com`, `doubleclick.net` u. a.
- Erkennen von „Advanced Mode": Pings mit `gcs=G100` (denied) vor Consent / nach Ablehnung.

### 5.6 Banner-Bedienung
- **`@duckduckgo/autoconsent`** (Regeln für 200+ CMPs) für Erkennung, Ablehnen, Akzeptieren.
- Fallback: Text-Heuristik (DE/EN: „Alle ablehnen", „Nur notwendige", „Ablehnen", „Alle akzeptieren", …) über DOM, Shadow DOM und iframes.
- Override: `--reject-selector` / `--accept-selector` bzw. in der Kunden-Config.
- Screenshots: Banner sichtbar (vor Klick), nach Klick, Seitenende.

### 5.7 Datenschutzerklärung
- Link finden (Banner, Footer; Texte „Datenschutz", „Datenschutzerklärung", „Privacy"), Seite laden (im Akzeptieren-Kontext, separat protokolliert), Text extrahieren.
- Abgleich: Jeder kontaktierte Vendor (Name + Aliase aus `vendors.yaml`) wird im Text gesucht. **Kontaktiert, aber nicht erwähnt** → Befund.

## 6. Klassifizierung

Jeder kontaktierte Host durchläuft diese Stufen. **Kein externer Host wird stillschweigend durchgelassen.** Die Stufen bestimmen nur Schweregrad und Erklärung.

1. **First Party:** gleiche registrierbare Domain (eTLD+1 via Public Suffix List, `tldts`) + in der Kunden-Config hinterlegte `firstPartyAliases` (z. B. `firma-cdn.de`).
2. **Kunden-Allowlist (`allowedProcessors`):** vom Kunden bestätigte Auftragsverarbeiter/notwendige Dienste (Host + Begründung + AVV-Hinweis) → Schweregrad INFO mit Vermerk.
3. **`vendors.yaml` (eigene, kuratierte Datei im Repo):** Host-Muster → Firma, Sitzland, Kategorie (Werbung, Analyse, Video, Karten, Fonts, CDN, Zahlung, Bot-Schutz, Social, …), bekannte Cookies, Aliase für Datenschutzerklärung, **Fix-Empfehlung** (z. B. „Google Fonts lokal hosten"). Startbestand: die für deutsche Websites relevanten ~150–300 Vendors.
4. **EasyPrivacy** (zur Laufzeit heruntergeladen & gecacht, nicht im Repo): nur Domain-Regeln (`||domain^`) als zusätzliches Tracker-Signal.
5. **DB-IP Lite** (Country + ASN, mmdb, CC BY 4.0): Land und Netzbetreiber der tatsächlich verbundenen IP, für unbekannte Hosts.

## 7. Bewertung

### Schweregrade

| Stufe | Beispiele |
|---|---|
| **KRITISCH** | Verbindung zu bekanntem Tracker oder Vendor mit Sitz in einem Drittland (z. B. Google, Meta) in Szenario A oder B; kein Banner gefunden, aber Drittverbindungen; Tracking-Cookie/-Storage in A/B; Fingerprinting in A/B |
| **HOCH** | Unbekannter Drittanbieter (nicht in Listen) in A/B; Google Consent Mode „Advanced"-Pings (`gcs=G100`) in A/B (mit Erklärung: IP wurde trotz „denied" übertragen, Empfehlung Basic Mode); keine Ablehnen-Option auf erster Ebene |
| **MITTEL** | EU-Drittanbieter mit plausibel notwendiger Kategorie (CDN, Bot-Schutz, Zahlung) ohne Kunden-Allowlist-Eintrag; Banner verdeckt Impressum/Datenschutzerklärung; Vendor kontaktiert, aber nicht in der Datenschutzerklärung erwähnt |
| **INFO** | Allowlist-Treffer; nur DNS-Auflösung ohne Verbindung; Befunde nur in Szenario C (mit Einwilligung, zur Dokumentation) |

### Gesamtampel
- **Rot:** mindestens ein KRITISCH-Befund.
- **Gelb:** HOCH- oder MITTEL-Befunde, **oder** ein Szenario war UNVOLLSTÄNDIG.
- **Grün:** nur INFO **und** alle Szenarien vollständig durchgeführt.

### Nicht bedienbarer Banner
- „Kein Banner gefunden" + Drittverbindungen → KRITISCH.
- „Banner gefunden, aber keine Ablehnen-Option auf erster Ebene" → Dark-Pattern-Befund (HOCH); Bello versucht zusätzlich die zweite Ebene, um Szenario B trotzdem auszuführen.
- „Banner technisch nicht bedienbar" → Szenario **UNVOLLSTÄNDIG**, Gesamtampel maximal **Gelb – manuelle Prüfung nötig**. **Bello meldet niemals Grün für ein Szenario, das nicht ausgeführt werden konnte.**

### Banner-Design-Prüfungen (v1)
1. **Ablehnen auf erster Ebene** mit gleichem Aufwand (1 Klick) wie Akzeptieren (vgl. OLG Köln 2022, DSK-Orientierungshilfe).
2. **Impressum & Datenschutzerklärung erreichbar**, während der Banner offen ist (Links im Banner oder Seite nicht vollständig blockiert).

(Visuelle Gleichwertigkeit und vorausgewählte Kategorien: bewusst nicht in v1, siehe §13.)

## 8. Ursachenanalyse & Fix-Empfehlungen

Jeder Befund in A/B bekommt eine **Ursachenklasse** (aus Initiator-Kette + Abgleich mit dem rohen HTML-Quelltext inkl. Snippet und Zeilennummer):

| Ursachenklasse | Erkennung | Fix-Empfehlung (Beispiel) |
|---|---|---|
| **Im HTML-Quelltext (Preload-Scanner, Autoblocker zu spät)** | Initiator `parser`, Element mit `src` im Roh-HTML | `src` → `data-src` / Zwei-Klick-Lösung / CMP-Embed-Platzhalter, serverseitig rendern |
| **Resource-Hint** | `<link rel="preconnect\|dns-prefetch\|preload">` im HTML | Hint entfernen oder erst nach Consent einfügen |
| **Script vor CMP geladen** | Script-Initiator, Ladezeitpunkt vor CMP-Init | Script mit `type="text/plain"` + CMP-Attribut versehen / über CMP laden |
| **Nachgeladen durch Script** | Initiator-Stack → Script-URL | Auslösendes Script im CMP als Dienst einordnen |
| **Nach Ablehnen geladen** | Zeitpunkt nach Reject-Klick | CMP-Konfiguration des Dienstes prüfen |
| **Consent Mode Advanced** | `gcs=G100`-Pings | Auf Basic Mode umstellen |
| **Lazy-Load beim Scrollen** | Erst nach Scroll-Phase | Wie „Im HTML-Quelltext" |

## 9. Abhängigkeiten & Lizenzen

Ziel: Keine Abhängigkeit, die mit Apache-2.0 kollidiert oder kommerzielle Nutzung (Geld verdienen mit den Reports) verbietet.

**Grundregel für das öffentliche Repo:** Fremde Datensätze (EasyPrivacy, DB-IP-mmdb) werden **nie eingecheckt**, sondern von `bello setup` / `bello vendors update` zur Laufzeit in ein lokales Cache-Verzeichnis geladen. Damit verteilt das Repo nur eigenen Code und die eigene `vendors.yaml` (Apache-2.0).

| Komponente | Lizenz | Einschätzung |
|---|---|---|
| Playwright | Apache-2.0 | unproblematisch |
| `@duckduckgo/autoconsent` | MPL-2.0 | Datei-bezogenes Copyleft, unveränderte Nutzung als Abhängigkeit unproblematisch |
| `tldts` (Public Suffix List) | MIT / MPL-2.0 (PSL-Daten) | unproblematisch |
| DB-IP Lite (Country + ASN) | CC BY 4.0 | kommerziell erlaubt, **Namensnennung im Report** („IP-Geolokation: DB-IP.com") |
| EasyPrivacy | GPLv3 / CC BY-SA 3.0 | Wird zur Laufzeit geladen, nicht im Repo verteilt. Copyleft greift erst bei Weitergabe der Liste selbst; Bellos Code bleibt Apache-2.0 |
| DuckDuckGo Tracker Radar | CC BY-NC-SA | **Nicht verwenden** (NonCommercial) |
| `vendors.yaml` | eigene (Apache-2.0) | volle Kontrolle; nur selbst recherchierte Einträge, nichts aus NC-/Copyleft-Listen kopieren |

*Keine Rechtsberatung. Bei Bedarf juristisch prüfen lassen.*

Neue Abhängigkeiten werden vor Aufnahme auf Lizenzkompatibilität geprüft; CI prüft die Lizenzen aller Produktions-Abhängigkeiten (z. B. `license-checker` mit Allowlist: MIT, ISC, BSD, Apache-2.0, MPL-2.0).

## 10. Ausgaben

Pro Scan: `./bello-reports/<domain>/<YYYY-MM-DDTHH-mm-ssZ>/`

```
report.json            # vollständige, maschinenlesbare Ergebnisse (versioniertes Schema)
report.html            # eigenständige Einzeldatei (inline CSS/Bilder)
report.pdf             # aus report.html via Playwright page.pdf()
evidence/
  manifest.json        # SHA-256 aller Dateien + Scan-Metadaten
  A-no-interaction/    netlog.json, network.har, cookies.json, storage.json,
                       fingerprinting.json, dom.html, raw.html, screenshots/*.png
  B-reject/            …
  C-accept/            …
  privacy-policy.txt
```

- **Terminal:** Ampel, Anzahl Befunde je Schweregrad und Szenario, die Top-Befunde (Host, Firma, Land, Ursache), Pfad zum Report.
- **HTML/PDF-Report (Deutsch):**
  1. Deckblatt mit Branding der eigenen Firma (Logo, Name, Farben, Kontakt aus Config; Fallback neutrales Bello-Design), Kundenname, URL, Datum
  2. Management-Summary: Ampel, Kernaussagen in Klartext
  3. Befunde nach Schweregrad (Host, Firma, Land, Kategorie, Szenario, Zeitpunkt relativ zu Navigation/CMP/Klick, Ursache, Quelltext-Snippet, Fix)
  4. Zeitleiste je Szenario (Verbindungen vs. CMP-Init vs. Klick)
  5. Szenario-Vergleich A/B/C
  6. Cookies & Storage, Fingerprinting, Consent Mode, Banner-Prüfungen, Datenschutzerklärungs-Abgleich
  7. Screenshots
  8. Methodik, Scan-Metadaten, Manifest-Hash, Haftungsausschluss, Quellennachweise (DB-IP)
- Print-Stylesheet für PDF (Seitenumbrüche, keine interaktiven Elemente).

### Beweissicherung
- Scan-Metadaten: UTC-Zeit, Exit-IP + Land, Bello-Version, Chromium-Version, verwendete Config (mit Hash), Kommandozeile.
- `manifest.json` mit SHA-256 aller Evidence-Dateien. Der Hash des Manifests steht im Report. Manipulationserkennbar, aber nicht rechtlich zertifiziert (kein RFC-3161-Zeitstempel in v1).

## 11. Konfiguration

Eine zentrale Datei `bello.config.yaml` (Pfad per `--config` überschreibbar). Für Ad-hoc-Scans ist keine Config nötig.

```yaml
company:
  name: "Ihre Firma GmbH"
  logo: ./assets/logo.svg
  colors: { primary: "#0a5" }
  contact: "datenschutz@ihre-firma.de"

defaults:
  outDir: ./bello-reports
  waitSeconds: 10
  crawl: { maxPages: 200, delayMs: 2000, sitesInParallel: 3 }

customers:
  acme:
    name: "ACME GmbH"
    url: https://www.acme.de
    crawl: true                     # für Nacht-Batch
    firstPartyAliases: [acme-cdn.de, static.acme.com]
    allowedProcessors:
      - host: "*.b-cdn.net"
        reason: "CDN, AVV vom 2026-03-01"
    banner:
      rejectSelector: "#uc-deny"    # optional
    vendorsFile: ./vendors.acme.yaml # optionale Ergänzungen
```

Validierung mit `zod`, verständliche deutsche Fehlermeldungen.

## 12. Nacht-Batch & Vergleich

- `bello scan --all`: alle Kunden (Crawl gemäß Config), bis zu 3 Sites parallel.
- Zeitplanung außerhalb von Bello (cron/systemd-Timer im Docker-Host).
- **Batch-Übersicht** (`bello-reports/_batch/<timestamp>/summary.html` + `.json`): alle Kunden mit Ampel, Befundzahlen und **Veränderung zum letzten Lauf**.
- `bello diff <a> <b>`: neue / behobene / unveränderte Befunde zwischen zwei `report.json`. Wird auch intern für die Batch-Übersicht genutzt.
- Keine Datenbank. Die Historie besteht aus den Report-Ordnern.

## 13. Bewusst nicht in v1 (spätere Ideen)

- Granulare/teilweise Einwilligung (nur Statistik o. ä.)
- Visuelle Gleichwertigkeit der Buttons, vorausgewählte Kategorien
- RFC-3161-Zeitstempel für das Manifest
- SQLite-Historie / Trends
- Benachrichtigungen (E-Mail/Slack/Teams)
- Web-Oberfläche
- Weitere Browser (Firefox/WebKit)
- Englische Reports

## 14. Technischer Stack & Projektstruktur

- **TypeScript**, Node.js 22 LTS, **pnpm**, ESM
- Playwright (Chromium), `commander` (CLI), `zod` (Config/Schema), `tldts`, `maxmind` (mmdb-Reader), `@duckduckgo/autoconsent`, `picocolors` (Terminal)
- HTML-Report: serverseitig gerenderte Templates (ohne Frontend-Framework), alles inline in einer Datei
- Tests: `vitest`
- Lint/Format: ESLint + Prettier

```
src/
  cli/              # commander-Setup, Befehle scan/diff/vendors/setup/doctor
  platform/         # OS-/Distro-Erkennung, Bibliotheksprüfung, Cache-Pfade, Startfehler-Übersetzung
  config/           # Laden & Validieren von bello.config.yaml
  browser/          # Launch (Flags, NetLog), Kontext-Setup, passiver Leser
  scenarios/        # A/B/C-Ablauf, Banner-Bedienung (autoconsent + Fallbacks)
  capture/
    netlog/         # NetLog-Parser → Verbindungen pro Host
    cdp/            # Requests, Initiatoren, HAR
    storage/        # Cookies, local/sessionStorage, IndexedDB
    fingerprint/    # Init-Script + Auswertung
    consentmode/    # gcs/gcd-Parsing
    privacypolicy/  # Finden, Extrahieren, Abgleich
    banner/         # Design-Prüfungen
  classify/         # First Party, Allowlist, vendors.yaml, EasyPrivacy, DB-IP
  analyze/          # Ursachenklassen, Schweregrad, Ampel
  crawl/            # Sitemap, Link-Crawl, Normalisierung, Rate-Limit
  report/           # terminal, json, html, pdf, evidence/manifest, batch summary, diff
data/
  vendors.yaml
test/
  fixtures/         # lokale Testseiten
  unit/  integration/  smoke/
Dockerfile
LICENSE  NOTICE
.github/workflows/
bello.config.example.yaml
```

## 15. Teststrategie

Ein falsches „Grün" an einen Kunden ist der schlimmste Fehler. Deshalb:

- **Hermetische Fixture-Sites:** lokaler Testserver. Chromium `--host-resolver-rules` mappt Fake-Hosts (`www.youtube.com`, `fonts.googleapis.com`, `www.googletagmanager.com`, `connect.facebook.net`, …) auf localhost. Die Tests laufen offline und deterministisch, die Hosts erscheinen aber als echte Dritte.
  - Fixtures (positiv = muss erkannt werden): YouTube-iframe im HTML + simulierter Autoblocker, `preconnect`-Hint, `loading="lazy"`-iframe (erst beim Scrollen), Script vor CMP, Laden nach Ablehnen, Tracking-Cookie vor Consent, Canvas-Fingerprinting, Consent-Mode-Advanced-Ping, kein Ablehnen-Button auf erster Ebene, Banner verdeckt Impressum, Vendor fehlt in Datenschutzerklärung.
  - Fixtures (negativ = darf nicht anschlagen): korrekte Zwei-Klick-Lösung, `data-src` + CMP, nur First-Party, Allowlist-Host.
  - Fixture mit nicht bedienbarem Banner → muss UNVOLLSTÄNDIG/Gelb ergeben, nie Grün.
- **Unit-Tests:** NetLog-Parser (mit aufgezeichneten NetLog-Samples), Klassifizierung, Schweregrad/Ampel, Consent-Mode-Parser, Diff, Config-Validierung.
- **Smoke-Tests (opt-in, `pnpm test:smoke`):** wenige echte Websites, bei denen das Verhalten bekannt ist. Nicht in der Standard-Testsuite.

## 16. Plattformen, Installation & Betrieb

### Unterstützte Plattformen
Bello benötigt nur **Node.js ≥ 22** und das **von Playwright selbst heruntergeladene Chromium**. Es nutzt keine System-Programme (kein System-Chrome, kein `curl`/`dig`/`tcpdump`, kein SMB o. ä.), daher verhält es sich auf allen Plattformen gleich. Das NetLog ist eine Chromium-Funktion und plattformunabhängig.

| Plattform | Status | Anmerkung |
|---|---|---|
| macOS 14+ (arm64 + x64) | **unterstützt, in CI getestet** | Chromium ist eigenständig, keine Zusatzpakete |
| Ubuntu 22.04/24.04, Debian 12/13 | **unterstützt, in CI getestet** | Systembibliotheken per `apt` (Playwright-Liste) |
| Fedora (aktuell), Arch | **unterstützt, in CI getestet (Container)** | Systembibliotheken per `dnf`/`pacman`; Bello liefert die Paketliste |
| openSUSE, andere | Best Effort | `bello doctor` meldet fehlende Bibliotheken |
| Windows | nicht Ziel von v1 | wahrscheinlich lauffähig, ungetestet |
| Docker | **immer funktionierender Fallback** | offizielles Playwright-Image |

Plattformunterschiede im Code: Pfade nur über `node:path`/`os.homedir()`, Cache-Verzeichnis nach XDG (`~/.cache/bello`) bzw. `~/Library/Caches/bello` auf macOS, keine Shell-Aufrufe für Kernfunktionen. Screenshots können sich durch System-Schriftarten leicht unterscheiden (nur kosmetisch).

### Installation (aus dem Repo)
```bash
git clone https://github.com/k1tesurfen/bello && cd bello
pnpm install && pnpm build && pnpm link --global
bello setup
```
Alle Schritte stehen im README. Kein npm-Paket, kein Install-Script in v1.

### `bello setup`
1. Prüft Node-Version.
2. Lädt die gepinnte Chromium-Version (Playwright) herunter.
3. Lädt DB-IP Lite (Country + ASN) und EasyPrivacy in den Cache.
4. **Linux:** erkennt die Distribution über `/etc/os-release`, prüft fehlende Bibliotheken (`ldd` auf das Chromium-Binary) und gibt den **exakten Installationsbefehl** für die Distribution aus (`sudo apt-get install …`, `sudo dnf install …`, `sudo pacman -S …`, `sudo zypper install …`). Bello führt **nie selbst `sudo`** aus.
5. Abschließend ein `bello doctor`-Lauf.

### `bello doctor`
Prüft und meldet jeweils ✓ / ✗ mit deutschem Lösungshinweis:
- Node-Version, Bello-Version, Betriebssystem/Distribution, Architektur
- Chromium vorhanden und gepinnte Version
- Fehlende Systembibliotheken (Linux)
- **Test-Start** von Chromium headless mit NetLog und Laden einer lokalen Testseite (beweist, dass Capture funktioniert)
- Datendateien vorhanden und Alter (Warnung, wenn älter als 30 Tage)
- Ausgabeverzeichnis beschreibbar
- Exit-IP in der EU (optional, `--offline` überspringt)

### Fehlerbehandlung beim Start
Schlägt der Browser-Start fehl, fängt Bello die (oft kryptische) Playwright-Meldung ab, erkennt typische Ursachen (fehlende `.so`-Bibliothek, Chromium nicht installiert, Sandbox-Probleme in Containern) und gibt eine verständliche deutsche Meldung plus „Führe `bello doctor` aus" aus. Ebenso, wenn Datendateien fehlen: Hinweis auf `bello setup`.

### Server/Nacht
Docker-Image auf Basis des offiziellen Playwright-Images mit **gepinnter Chromium-Version** (Reproduzierbarkeit der Evidence), Volume für Config + Reports, cron auf einem Server mit deutscher IP.

### CI (GitHub Actions)
- Matrix: `ubuntu-latest`, `macos-latest` (arm64): Lint, Unit-, Fixture-Tests.
- Container-Jobs: Debian, Fedora, Arch: `bello setup` (mit den ausgegebenen Paketbefehlen) + `bello doctor` + Fixture-Tests. So wird geprüft, dass die Paketlisten pro Distribution stimmen.
- Lizenz-Check der Abhängigkeiten.

## 17. Umsetzungsreihenfolge

Alles gehört zu v1, gebaut wird **das Riskanteste zuerst**. Jeder Schritt endet mit lauffähigem, getestetem Code.

1. **Projekt-Setup + Capture-Kern:** `LICENSE`/`NOTICE`, Grundgerüst, CI (Ubuntu + macOS), Browser-Launch mit NetLog, NetLog-Parser, CDP-Requests/Initiatoren, Fixture-Server mit `--host-resolver-rules`. **Meilenstein:** Der YouTube-iframe-mit-Autoblocker-Fall wird auf Socket-Ebene nachgewiesen.
2. **Klassifizierung:** First Party, `vendors.yaml` (Startbestand), EasyPrivacy, DB-IP Lite, Allowlist.
3. **Szenarien A/B/C + passiver Leser + Banner-Bedienung** (autoconsent, Fallback, Selektoren, UNVOLLSTÄNDIG-Logik).
4. **CLI (`bello <url>`) + Terminal-Ausgabe + JSON-Report**, Schweregrade, Ampel, Exit-Codes.
5. **Cookies/Storage, Consent Mode, Fingerprinting, Ursachenanalyse + Fix-Empfehlungen.**
6. **HTML-Report, PDF, Evidence-Bundle + Manifest**, Firmen-Branding.
7. **Banner-Design-Prüfungen + Datenschutzerklärungs-Abgleich.**
8. **Crawl (Sitemap + Link-Crawl), zentrale Config, `scan --all`, Batch-Übersicht, `diff`.**
9. **`bello setup` / `bello doctor`**, freundliche Startfehler, Distro-Container-Jobs in CI, **Docker-Image**, Doku (README inkl. Installation pro Plattform), Beispiel-Config.

## 18. Offene Punkte / Risiken

- **NetLog-Format** ist nicht offiziell stabil, kann sich zwischen Chromium-Versionen ändern. Gegenmaßnahme: gepinnte Version, Parser-Tests mit Samples.
- **Bot-Erkennung/WAF** (Cloudflare o. ä.) kann Scans blockieren → als UNVOLLSTÄNDIG melden, nie als Grün.
- **Geo-abhängige Banner:** Bello muss von einer EU-IP laufen (Startprüfung warnt).
- **Linux-Distributionen außer Debian/Ubuntu** werden von Playwright nicht offiziell unterstützt; Paketnamen können sich ändern → CI-Container-Jobs fangen das ab.
- **Pflegeaufwand `vendors.yaml`:** Startbestand fokussiert auf deutsche Top-Vendors. Unbekannte Hosts landen trotzdem im Report (HOCH).
- **Rechtliche Einordnungen** (Schweregrade, Wortlaut) sind Einschätzungen und sollten einmalig mit einem Datenschutzjuristen abgestimmt werden, bevor Reports an Kunden gehen.

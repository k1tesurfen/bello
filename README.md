# Bello – Privacy-Spürhund

Bello ist ein CLI-Tool, das eine Website darauf untersucht, ob ihr Consent-Management (CMP) tatsächlich verhindert, dass **vor bzw. ohne Einwilligung** Verbindungen zu Dritten aufgebaut oder Informationen auf dem Endgerät gespeichert bzw. ausgelesen werden (TDDDG § 25, DSGVO Art. 6).

**Kernthese:** Viele CMPs mit „Autoblocker" (Usercentrics, CCM19, …) blockieren eingebettete Ressourcen erst, _nachdem_ der Browser sie bereits angefragt hat. Der Preload-Scanner von Chromium liest das rohe HTML und startet Verbindungen für `src`-Attribute, bevor irgendein JavaScript läuft. Ein einziger TCP-/TLS-Handshake zu z. B. `www.youtube.com` überträgt die IP-Adresse des Nutzers an Google (vgl. LG München I, 20.01.2022, 3 O 17493/20). Bello weist genau das auf **Socket-Ebene** nach (Chromium-NetLog).

> **Hinweis: Keine Rechtsberatung.** Bello liefert technische Befunde und Einschätzungen, keine Rechtsberatung. Die rechtliche Bewertung (z. B. ob ein Dienst als Auftragsverarbeiter eingebunden ist oder eine Einwilligung erforderlich ist) obliegt Ihnen bzw. Ihrer Datenschutzbeauftragten. Jeder Report enthält einen entsprechenden Hinweis.

## Inhalt

- [Voraussetzungen](#voraussetzungen)
- [Installation](#installation)
- [Befehle und Optionen](#befehle-und-optionen)
- [Konfiguration](#konfiguration)
- [Ausgaben (Reports)](#ausgaben-reports)
- [Exit-Codes](#exit-codes)
- [Docker und Nacht-Batch](#docker-und-nacht-batch)
- [Entwicklung](#entwicklung)
- [Lizenz und Datenquellen](#lizenz-und-datenquellen)

## Voraussetzungen

Bello benötigt nur **Node.js ≥ 22**, **pnpm** und das von Playwright selbst heruntergeladene Chromium. Es nutzt keine System-Programme (kein System-Chrome, kein `curl`/`dig`/`tcpdump`).

| Plattform                             | Status                                                    |
| ------------------------------------- | --------------------------------------------------------- |
| macOS 14+ (arm64 + x64)               | unterstützt, in CI getestet                               |
| Ubuntu 22.04/24.04, Debian 12/13      | unterstützt, in CI getestet                               |
| Fedora (aktuell), Arch Linux          | unterstützt, in CI getestet (Container)                   |
| openSUSE, andere Linux-Distributionen | Best Effort, `bello doctor` meldet fehlende Bibliotheken  |
| Windows                               | nicht Ziel von v1 (ungetestet), Docker oder WSL empfohlen |
| Docker                                | immer funktionierender Fallback (siehe unten)             |

## Installation

Bello wird aus dem Repo installiert (kein npm-Paket):

```bash
git clone https://github.com/k1tesurfen/bello && cd bello
pnpm install && pnpm build && pnpm link --global
bello setup
```

`bello setup` führt folgende Schritte aus:

1. Prüft die Node-Version.
2. Lädt die gepinnte Chromium-Version (Playwright).
3. Lädt DB-IP Lite (Country + ASN) und EasyPrivacy in das Cache-Verzeichnis.
4. **Linux:** erkennt die Distribution (`/etc/os-release`), prüft per `ldd` fehlende Bibliotheken des Chromium-Binarys und gibt den **exakten Installationsbefehl** aus. Bello führt **nie selbst `sudo`** aus.
5. Startet abschließend `bello doctor`.

### macOS

Keine Zusatzpakete nötig. Node und pnpm z. B. über Homebrew (`brew install node pnpm`), danach die Schritte oben.

### Ubuntu / Debian

```bash
bello setup
# gibt bei fehlenden Bibliotheken z. B. aus:
sudo apt-get install -y libnss3 libnspr4 libgbm1 libasound2t64 …
```

Alternativ installiert `pnpm exec playwright install --with-deps chromium` Browser und Systempakete in einem Schritt (benötigt root).

### Fedora

```bash
bello setup
# z. B.: sudo dnf install -y nss nspr mesa-libgbm alsa-lib …
```

### Arch Linux

```bash
bello setup
# z. B.: sudo pacman -S --needed --noconfirm nss nspr mesa alsa-lib …
```

### openSUSE und andere

`bello setup` gibt für openSUSE (`zypper`) ebenfalls einen Befehl aus. Bei unbekannten Distributionen listet `bello doctor` die fehlenden `.so`-Dateien auf, die Sie über Ihren Paketmanager installieren.

### Cache-Verzeichnis

Datendateien (EasyPrivacy, DB-IP) liegen unter `~/.cache/bello` (Linux, nach XDG), `~/Library/Caches/bello` (macOS). Überschreibbar mit der Umgebungsvariable `BELLO_CACHE_DIR`.

## Befehle und Optionen

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

`scan` ist der Standardbefehl; fehlt `https://`, wird es ergänzt.

| Option                         | Bedeutung                                                            |
| ------------------------------ | -------------------------------------------------------------------- |
| `--crawl`                      | Vollständiger Crawl (Sitemap, Fallback: Link-Crawl)                  |
| `--pages <n>`                  | Maximale Seitenzahl pro Site                                         |
| `--config <file>`              | Pfad zur Konfigurationsdatei (Standard: `bello.config.yaml`)         |
| `--out <dir>`                  | Ausgabeverzeichnis (Standard: `./bello-reports`)                     |
| `--proxy <url>`                | Proxy (z. B. für eine deutsche Exit-IP)                              |
| `--identify`                   | Hängt `Bello/x.y` an den User-Agent                                  |
| `--reject-selector <css>`      | CSS-Selektor des „Ablehnen"-Buttons, falls nicht automatisch erkannt |
| `--accept-selector <css>`      | CSS-Selektor des „Akzeptieren"-Buttons                               |
| `--wait <s>`                   | Wartezeit des „passiven Lesers" in Sekunden                          |
| `--no-pdf`                     | Keinen PDF-Report erzeugen                                           |
| `--headful`                    | Sichtbares Browserfenster (Debug)                                    |
| `doctor --offline`             | Prüfungen ohne Internetzugriff (überspringt die Exit-IP-Prüfung)     |
| `-v, --version` / `-h, --help` | Version bzw. Hilfe                                                   |

Die drei Szenarien laufen jeweils in einer frischen Browser-Instanz: **A** keine Interaktion, **B** alle ablehnen, **C** alle akzeptieren (Baseline). Der Diff C gegen A/B zeigt, was das CMP tatsächlich steuert. Bello klickt ausschließlich den Banner an, Scrollen und Lesen gilt nicht als Einwilligung.

### `bello doctor`

Prüft und meldet jeweils ✓ / ✗ / ! mit deutschem Lösungshinweis:

- Node-Version, Bello-Version, Betriebssystem/Distribution, Architektur
- Chromium vorhanden (gepinnte Version)
- Fehlende Systembibliotheken (Linux)
- **Test-Start** von Chromium headless mit NetLog gegen eine lokale Testseite (beweist, dass das Capture funktioniert)
- Datendateien vorhanden und Alter (Warnung ab 30 Tagen)
- Ausgabeverzeichnis beschreibbar
- Exit-IP in der EU/im EWR (`--offline` überspringt die Prüfung)

Schlägt der Browser-Start bei einem Scan fehl, übersetzt Bello die Playwright-Meldung (fehlende Bibliothek, Chromium nicht installiert, Sandbox-Probleme im Container, fehlende Datendateien) in eine verständliche Meldung mit Hinweis auf `bello doctor` bzw. `bello setup`.

## Konfiguration

Für Ad-hoc-Scans ist keine Konfiguration nötig. Für Kunden, Branding und Nacht-Batch dient eine zentrale Datei `bello.config.yaml`. Eine kommentierte Vorlage liegt in [`bello.config.example.yaml`](bello.config.example.yaml):

```bash
cp bello.config.example.yaml bello.config.yaml
```

```yaml
company:
  name: 'Ihre Firma GmbH'
  logo: ./assets/logo.svg
  colors: { primary: '#0a5' }
  contact: 'datenschutz@ihre-firma.de'

defaults:
  outDir: ./bello-reports
  waitSeconds: 10
  crawl: { maxPages: 200, delayMs: 2000, sitesInParallel: 3 }

customers:
  acme:
    name: 'ACME GmbH'
    url: https://www.acme.de
    crawl: true
    firstPartyAliases: [acme-cdn.de, static.acme.com]
    allowedProcessors:
      - host: '*.b-cdn.net'
        reason: 'CDN, AVV vom 2026-03-01'
    banner:
      rejectSelector: '#uc-deny'
    vendorsFile: ./vendors.acme.yaml
```

Die Konfiguration wird mit `zod` validiert; Fehler werden auf Deutsch gemeldet. Das Firmen-Branding (Logo, Farben, Kontakt) erscheint im Deckblatt der Reports.

## Ausgaben (Reports)

Pro Scan entsteht `./bello-reports/<domain>/<YYYY-MM-DDTHH-mm-ssZ>/`:

```
report.json            # vollständige, maschinenlesbare Ergebnisse (versioniertes Schema)
report.html            # eigenständige Einzeldatei (inline CSS/Bilder)
report.pdf             # aus report.html via Playwright
evidence/
  manifest.json        # SHA-256 aller Dateien + Scan-Metadaten
  A-no-interaction/    netlog.json, network.har, cookies.json, storage.json,
                       fingerprinting.json, dom.html, raw.html, screenshots/*.png
  B-reject/            …
  C-accept/            …
  privacy-policy.txt
```

- **Terminal:** Ampel, Anzahl Befunde je Schweregrad und Szenario, Top-Befunde (Host, Firma, Land, Ursache), Pfad zum Report.
- **HTML/PDF-Report (Deutsch):** Deckblatt, Management-Summary, Befunde nach Schweregrad (mit Ursache, Quelltext-Snippet und Fix-Empfehlung), Zeitleiste je Szenario, Szenario-Vergleich A/B/C, Cookies & Storage, Fingerprinting, Consent Mode, Banner-Prüfungen, Datenschutzerklärungs-Abgleich, Screenshots, Methodik und Quellennachweise.
- **Beweissicherung:** Scan-Metadaten (UTC-Zeit, Exit-IP + Land, Bello- und Chromium-Version, Config-Hash, Kommandozeile) und ein Manifest mit SHA-256 aller Evidence-Dateien. Der Manifest-Hash steht im Report. Das ist manipulationserkennbar, aber nicht rechtlich zertifiziert.
- **Nacht-Batch:** `bello-reports/_batch/<timestamp>/summary.html` + `.json` mit Ampel je Kunde und Veränderung zum letzten Lauf.

## Exit-Codes

| Code | Bedeutung                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Grün: keine Befunde                                                                                                      |
| `1`  | Gelb: Hinweise bzw. geringfügige Befunde                                                                                 |
| `2`  | Rot: kritische Befunde (Drittverbindungen/Speicherung ohne Einwilligung)                                                 |
| `3`  | Technischer Fehler (z. B. Umgebung, Browser-Start, Netzwerk); bei `bello doctor`: mindestens eine Prüfung fehlgeschlagen |

## Docker und Nacht-Batch

Das [`Dockerfile`](Dockerfile) basiert auf dem offiziellen Playwright-Image (`mcr.microsoft.com/playwright:v<Version>-noble`) mit **gepinnter Chromium-Version** (Reproduzierbarkeit der Evidence). Die Playwright-Version muss zu `package.json` passen. Das Image läuft als nicht-privilegierter Benutzer `pwuser`.

- `/config`: `bello.config.yaml` und der Daten-Cache (`BELLO_CACHE_DIR=/config/cache`)
- `/reports`: Report-Ausgabe

Der Entrypoint ergänzt bei `scan`, `<url>` und `doctor` automatisch `--config /config/bello.config.yaml` (falls die Datei existiert) und `--out /reports`, sofern nicht selbst angegeben. `bello <url>` und `bello scan --all` funktionieren im Container daher ohne weitere Optionen.

**Rechte bei Bind-Mounts:** Der Container läuft nicht als root, sondern als `pwuser`. Die gemounteten Ordner (`/config`, `/reports`) müssen für diesen Benutzer beschreibbar sein (`pwuser` hat im Playwright-Image UID 1001; prüfbar mit `docker run --rm --entrypoint id bello`), z. B. `chown -R 1001:1001 reports config`. Alternativ mit `--user "$(id -u):$(id -g)"` als eigener Benutzer starten.

```bash
docker build -t bello .

# einmalig: Datendateien laden
docker run --rm -v "$PWD/config:/config" bello vendors update

# Quick-Check
docker run --rm -v "$PWD/config:/config" -v "$PWD/reports:/reports" \
  bello example.de

# Umgebung prüfen
docker run --rm -v "$PWD/config:/config" bello doctor --offline
```

Chromium benötigt in Containern teils zusätzliche Rechte für seine Sandbox. Playwright startet Chromium im Container ohne Sandbox. Treten dennoch Sandbox-Fehler auf, hilft `--security-opt seccomp=seccomp_profile.json` (Playwright-Profil) oder `--ipc=host`.

### Cron-Beispiel (Server mit deutscher IP)

```cron
# täglich um 02:30 alle Kunden prüfen
30 2 * * * docker run --rm -v /opt/bello/config:/config -v /opt/bello/reports:/reports bello scan --all >> /var/log/bello.log 2>&1
```

Die Zeitplanung liegt bewusst außerhalb von Bello (cron oder systemd-Timer auf dem Docker-Host). Die Exit-Codes (`0`/`1`/`2`/`3`) eignen sich für Monitoring.

## Entwicklung

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm license:check      # Lizenzen der Produktions-Abhängigkeiten (Allowlist: MIT, ISC, BSD, Apache-2.0, MPL-2.0, …)
pnpm build
```

Die CI (GitHub Actions) testet auf Ubuntu und macOS (Lint, Typecheck, Unit- und Fixture-Tests), in Containern mit Debian 13, Fedora und Arch (`bello setup` mit den ausgegebenen Paketbefehlen, `bello doctor --offline`, Tests) und prüft die Lizenzen.

## Lizenz und Datenquellen

Bello steht unter der **Apache License 2.0** (siehe [`LICENSE`](LICENSE)). Der Copyright-Hinweis und die Datei [`NOTICE`](NOTICE) müssen bei Weitergabe erhalten bleiben. Kommerzielle Nutzung ist erlaubt.

Fremde Datensätze werden **nie** im Repo verteilt, sondern von `bello setup` bzw. `bello vendors update` zur Laufzeit in das lokale Cache-Verzeichnis geladen:

- **IP-Geolokation: DB-IP.com** (DB-IP Lite Country + ASN, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). Die Namensnennung erscheint in jedem Report.
- **EasyPrivacy** (The EasyList authors, GPLv3 / CC BY-SA 3.0) wird zur Laufzeit geladen und nicht weitergegeben.
- Abhängigkeiten wie Playwright (Apache-2.0), `@duckduckgo/autoconsent` (MPL-2.0) und `tldts` (MIT) behalten ihre jeweiligen Lizenzen.

Die Anbieterliste `data/vendors.yaml` ist eigenes Material (Apache-2.0).

_Keine Rechtsberatung. Bei Bedarf juristisch prüfen lassen._

#!/usr/bin/env bash
# Bello installer: checks everything Bello needs and installs what is missing.
# All user-facing output is German; comments are English.
# Compatible with bash >= 3.2 (macOS): no associative arrays, no ${var,,}, no mapfile.
set -euo pipefail

# ---------------------------------------------------------------- options ---
CHECK_ONLY=0
YES=0
YES_SUDO=0

usage() {
  cat <<'EOF'
Bello-Installer – richtet alles ein, was Bello braucht.

Aufruf:   ./install.sh [Optionen]

Optionen:
  --check      Nur prüfen, nichts verändern.
  --yes        Alle Fragen mit „Ja" beantworten (außer Schritte mit sudo).
  --yes-sudo   Zusammen mit --yes: auch Schritte mit sudo ohne Nachfrage ausführen.
  --help       Diese Hilfe anzeigen.

Das Skript ist gefahrlos mehrfach ausführbar.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --yes | -y) YES=1 ;;
    --yes-sudo) YES_SUDO=1 ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "Unbekannte Option: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# ----------------------------------------------------------------- output ---
if [ -t 1 ]; then
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_OFF=$'\033[0m'
else
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_BOLD=""
  C_DIM=""
  C_OFF=""
fi

ok() { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$1"; }
bad() { printf '%s✗%s %s\n' "$C_RED" "$C_OFF" "$1"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_OFF" "$1"; }
info() { printf '    %s\n' "$1"; }
cmdline() { printf '      %s$ %s%s\n' "$C_BOLD" "$1" "$C_OFF"; }
title() { printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_OFF"; }

# Number of things that are still missing at the end.
OUTSTANDING=0
note_missing() { OUTSTANDING=$((OUTSTANDING + 1)); }

die() {
  printf '\n%sFehler:%s %s\n' "$C_RED" "$C_OFF" "$1" >&2
  [ -n "${2:-}" ] && printf '%s\n' "$2" >&2
  printf 'Sie können %s./install.sh%s jederzeit erneut starten.\n' "$C_BOLD" "$C_OFF" >&2
  exit 1
}

# ask "Frage": returns 0 for yes. Enter = yes. Honors --yes.
ask() {
  local ans
  if [ "$YES" = 1 ]; then
    printf '    %s [J/n] J (--yes)\n' "$1"
    return 0
  fi
  if [ ! -t 0 ]; then
    info "Keine Eingabe möglich (kein Terminal). Mit --yes geht es automatisch."
    return 1
  fi
  read -r -p "    $1 [J/n] " ans || return 1
  case "$ans" in
    "" | j | J | ja | Ja | JA | y | Y | yes | Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# ask_sudo "Frage": like ask, but only --yes-sudo (together with --yes) skips the prompt.
ask_sudo() {
  local ans
  if [ "$YES" = 1 ] && [ "$YES_SUDO" = 1 ]; then
    printf '    %s [J/n] J (--yes --yes-sudo)\n' "$1"
    return 0
  fi
  if [ ! -t 0 ]; then
    info "Keine Eingabe möglich (kein Terminal). Mit --yes --yes-sudo geht es automatisch."
    return 1
  fi
  read -r -p "    $1 [J/n] " ans || return 1
  case "$ans" in
    "" | j | J | ja | Ja | JA | y | Y | yes | Yes) return 0 ;;
    *) return 1 ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------- paths/env ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR"
OPT_DIR="$HOME/.local/opt"
BIN_DIR="$HOME/.local/bin"
CLI_JS="$REPO_DIR/dist/cli/index.js"

[ -f "$REPO_DIR/package.json" ] || die "Im Ordner $REPO_DIR fehlt package.json." \
  "Bitte starten Sie install.sh aus dem Bello-Ordner (git clone …)."

case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac
# Make user-local tools visible to this script.
export PATH="$BIN_DIR:$PATH"

TMP_DIR=""
cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"; return 0; }
trap cleanup EXIT

# --------------------------------------------------------------- platform ---
OS_KIND=""   # macos | linux
ARCH=""      # x64 | arm64 (Node naming)
PKG=""       # apt | dnf | pacman | zypper | brew | ""
DISTRO_NAME=""

detect_platform() {
  local uname_s uname_m
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"
  case "$uname_s" in
    Darwin) OS_KIND="macos" ;;
    Linux) OS_KIND="linux" ;;
    MINGW* | MSYS* | CYGWIN*)
      echo "Windows wird von diesem Installer nicht unterstützt."
      echo "Bitte nutzen Sie WSL (Ubuntu) oder Docker – siehe README.md."
      exit 0
      ;;
    *)
      echo "Dieses Betriebssystem ($uname_s) wird nicht unterstützt."
      echo "Unterstützt: macOS und Linux. Alternative: Docker, siehe README.md."
      exit 0
      ;;
  esac
  case "$uname_m" in
    x86_64 | amd64) ARCH="x64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    *)
      echo "Diese Prozessor-Architektur ($uname_m) wird nicht unterstützt."
      exit 0
      ;;
  esac
  if [ "$OS_KIND" = "linux" ]; then
    if [ -f /etc/alpine-release ]; then
      echo "Alpine Linux (musl) wird nicht unterstützt, da Chromium dort nicht läuft."
      echo "Bitte nutzen Sie Docker, siehe README.md."
      exit 0
    fi
    DISTRO_NAME="Linux"
    if [ -r /etc/os-release ]; then
      # shellcheck disable=SC1091
      DISTRO_NAME="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}")"
    fi
    if have apt-get; then
      PKG="apt"
    elif have dnf; then
      PKG="dnf"
    elif have pacman; then
      PKG="pacman"
    elif have zypper; then
      PKG="zypper"
    fi
  else
    DISTRO_NAME="macOS $(sw_vers -productVersion 2>/dev/null || true)"
    if have brew; then PKG="brew"; fi
  fi
}

# ----------------------------------------------------------- root helpers ---
# Printable form of a root command (wrapped in bash -c when it chains commands).
root_display() {
  local cmd="$1"
  case "$cmd" in
    *"&&"* | *"||"*) cmd="bash -c '$cmd'" ;;
  esac
  if [ "$(id -u)" = 0 ]; then printf '%s' "$cmd"; else printf 'sudo %s' "$cmd"; fi
}

# Run a package-manager command string as root (directly, or via sudo).
# Returns 2 if neither is possible.
run_as_root() {
  local cmd="$1"
  cmd="${cmd#sudo }"
  if [ "$(id -u)" = 0 ]; then
    bash -c "$cmd"
  elif have sudo; then
    sudo bash -c "$cmd"
  else
    return 2
  fi
}

# Show a root command and run it only with explicit consent.
# $1 = description, $2 = command (without sudo). Returns 0 on success.
offer_root_command() {
  local what="$1" cmd="$2" shown
  shown="$(root_display "$cmd")"
  info "Dafür sind Administratorrechte nötig. Befehl:"
  cmdline "$shown"
  if [ "$CHECK_ONLY" = 1 ]; then return 1; fi
  if [ "$(id -u)" != 0 ] && ! have sudo; then
    info "sudo ist nicht installiert. Führen Sie den Befehl als Administrator (root) aus."
    return 1
  fi
  if ask_sudo "$what jetzt mit Administratorrechten installieren? (Sie müssen ggf. Ihr Passwort eingeben)"; then
    if run_as_root "$cmd"; then return 0; fi
    warn "Der Befehl ist fehlgeschlagen. Sie können ihn später selbst ausführen (siehe oben)."
    return 1
  fi
  info "Übersprungen. Führen Sie den Befehl oben später selbst aus."
  return 1
}

# Base command for installing packages with the system package manager.
pkg_install_cmd() {
  case "$PKG" in
    apt) echo "apt-get update && apt-get install -y $*" ;;
    dnf) echo "dnf install -y $*" ;;
    pacman) echo "pacman -S --needed --noconfirm $* || (pacman -Sy --noconfirm && pacman -S --needed --noconfirm $*)" ;;
    zypper) echo "zypper --non-interactive install $*" ;;
    *) echo "" ;;
  esac
}

# --------------------------------------------------------------- download ---
net_error() {
  die "Download fehlgeschlagen: $1" \
    "Bitte prüfen Sie Ihre Internetverbindung (und ggf. Proxy/VPN) und versuchen Sie es erneut."
}

# fetch_to URL FILE (with progress bar) / fetch_out URL (to stdout, quiet)
fetch_to() {
  if have curl; then
    curl -fL --retry 2 --connect-timeout 15 -# -o "$2" "$1"
  else
    wget -q --show-progress --tries=3 --timeout=30 -O "$2" "$1"
  fi
}
fetch_out() {
  if have curl; then
    curl -fsSL --retry 2 --connect-timeout 15 "$1"
  else
    wget -q --tries=3 --timeout=30 -O - "$1"
  fi
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    return 1
  fi
}

# ---------------------------------------------------------------- checks ---
NODE_BIN=""

node_ok() { # $1 = path to a node binary: succeeds if version >= 22
  [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null
}

find_node() {
  NODE_BIN=""
  local c c_dir
  for c in "$OPT_DIR/node22/bin/node" "$(command -v node 2>/dev/null || true)"; do
    if [ -n "$c" ] && node_ok "$c"; then
      NODE_BIN="$c"
      # Put this Node (and its npm/pnpm) first on PATH for the rest of the script.
      c_dir="$(dirname "$c")"
      export PATH="$c_dir:$PATH"
      return 0
    fi
  done
  return 1
}

# --- step: basic tools ------------------------------------------------------
step_basics() {
  title "1. Grundwerkzeuge"
  if have git; then
    ok "git – vorhanden (nur zur Information, wird nicht zwingend gebraucht)"
  else
    warn "git – nicht gefunden (nur zum Aktualisieren von Bello nützlich, nicht nötig)"
  fi

  local missing_pkgs="" need=0
  if have curl || have wget; then
    ok "curl/wget – zum Herunterladen vorhanden"
  else
    bad "curl oder wget – fehlt (wird zum Herunterladen von Node.js gebraucht)"
    missing_pkgs="$missing_pkgs curl ca-certificates"
    need=1
  fi
  if have tar && have gzip; then
    ok "tar/gzip – zum Entpacken vorhanden"
  else
    bad "tar/gzip – fehlt (wird zum Entpacken von Node.js gebraucht)"
    missing_pkgs="$missing_pkgs tar gzip"
    need=1
  fi
  [ "$need" = 0 ] && return 0

  if [ "$OS_KIND" = "macos" ] || [ -z "$PKG" ]; then
    note_missing
    info "Bitte installieren Sie die genannten Programme mit Ihrem Paketmanager und starten Sie das Skript erneut."
    return 0
  fi
  info "Diese Systempakete fehlen:$missing_pkgs"
  # shellcheck disable=SC2086
  if offer_root_command "Systempakete" "$(pkg_install_cmd $missing_pkgs)"; then
    ok "Grundwerkzeuge installiert"
  else
    note_missing
  fi
  return 0
}

# --- step: Node.js ----------------------------------------------------------
install_node() {
  local os_name index version file base tmp expected actual target
  if [ "$OS_KIND" = "macos" ]; then os_name="darwin"; else os_name="linux"; fi
  have curl || have wget || die "Zum Herunterladen von Node.js wird curl oder wget gebraucht."
  have tar || die "Zum Entpacken von Node.js wird tar gebraucht."

  info "Suche die aktuelle Node.js-22-Version auf nodejs.org …"
  index="$(fetch_out https://nodejs.org/dist/index.json)" || net_error "https://nodejs.org/dist/index.json"
  version="$(printf '%s' "$index" | grep -oE '"version": *"v22\.[0-9]+\.[0-9]+"' | sed -n '1p' | grep -oE 'v22\.[0-9]+\.[0-9]+')" || true
  [ -n "$version" ] || die "Konnte keine Node.js-22-Version bei nodejs.org finden."

  file="node-$version-$os_name-$ARCH.tar.gz"
  base="https://nodejs.org/dist/$version"
  target="$OPT_DIR/node-$version"
  mkdir -p "$OPT_DIR"
  TMP_DIR="$(mktemp -d "$OPT_DIR/.bello-install.XXXXXX")"
  tmp="$TMP_DIR"

  info "Lade $file herunter …"
  fetch_to "$base/$file" "$tmp/$file" || net_error "$base/$file"
  fetch_out "$base/SHASUMS256.txt" >"$tmp/SHASUMS256.txt" || net_error "$base/SHASUMS256.txt"

  expected="$(grep " $file\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  [ -n "$expected" ] || die "Keine Prüfsumme für $file gefunden."
  actual="$(sha256_of "$tmp/$file")" || die "Weder sha256sum noch shasum gefunden – kann die Prüfsumme nicht prüfen."
  if [ "$expected" != "$actual" ]; then
    die "Prüfsumme (SHA-256) stimmt nicht überein – die Datei wurde nicht installiert." \
      "Erwartet: $expected
Erhalten:  $actual"
  fi
  ok "Prüfsumme (SHA-256) stimmt"

  info "Entpacke nach $target …"
  rm -rf "$target"
  tar -xzf "$tmp/$file" -C "$tmp"
  mv "$tmp/node-$version-$os_name-$ARCH" "$target"
  ln -sfn "$target" "$OPT_DIR/node22"
  rm -rf "$tmp"
  TMP_DIR=""
}

step_node() {
  title "2. Node.js 22 (Laufzeitumgebung)"
  if find_node; then
    ok "Node.js $("$NODE_BIN" --version) – $NODE_BIN"
    return 0
  fi
  if have node; then
    bad "Node.js – $(node --version) ist zu alt, Bello braucht Version 22 oder neuer"
  else
    bad "Node.js – nicht gefunden (Bello braucht Version 22 oder neuer)"
  fi
  note_missing
  info "Node.js ist das Programm, auf dem Bello läuft. Es wird nur für Ihren Benutzer"
  info "installiert (nach ~/.local/opt/node22), ohne Administratorrechte."
  info "Vorgehen: offizielles Paket von nodejs.org laden, Prüfsumme kontrollieren, entpacken."
  if [ "$OS_KIND" = "macos" ] && [ "$PKG" = "brew" ]; then
    info "Alternative mit Homebrew: brew install node@22 (dieses Skript nutzt standardmäßig das offizielle Paket)."
  fi
  [ "$CHECK_ONLY" = 1 ] && return 0
  if ask "Node.js 22 jetzt installieren?"; then
    install_node
    find_node || die "Node.js wurde entpackt, läuft aber nicht." "Bitte melden Sie das Problem mit Ihrer Systeminfo (uname -a)."
    OUTSTANDING=$((OUTSTANDING - 1))
    ok "Node.js $("$NODE_BIN" --version) installiert"
  fi
}

# --- step: pnpm -------------------------------------------------------------
step_pnpm() {
  title "3. pnpm (Paketverwaltung)"
  if [ -z "$NODE_BIN" ]; then
    bad "pnpm – kann erst nach Node.js geprüft werden"
    return 0
  fi
  if have pnpm && pnpm --version >/dev/null 2>&1; then
    ok "pnpm $(pnpm --version)"
    return 0
  fi
  bad "pnpm – nicht gefunden"
  note_missing
  info "pnpm lädt die Bausteine, aus denen Bello besteht. Installation nur für Ihren Benutzer:"
  local node_dir prefix_args=""
  node_dir="$(dirname "$NODE_BIN")"
  if [ ! -w "$node_dir" ]; then prefix_args=" --prefix $HOME/.local"; fi
  cmdline "npm install -g pnpm@9$prefix_args"
  [ "$CHECK_ONLY" = 1 ] && return 0
  if ask "pnpm jetzt installieren?"; then
    # shellcheck disable=SC2086
    npm install -g pnpm@9 $prefix_args || net_error "npm install -g pnpm@9"
    hash -r
    have pnpm || die "pnpm wurde installiert, ist aber nicht auffindbar."
    OUTSTANDING=$((OUTSTANDING - 1))
    ok "pnpm $(pnpm --version) installiert"
  fi
}

# --- step: dependencies + build ---------------------------------------------
step_build() {
  title "4. Bello-Bausteine und Programm"
  if [ -z "$NODE_BIN" ] || ! have pnpm; then
    bad "Abhängigkeiten / Programm – kann erst nach Node.js und pnpm geprüft werden"
    return 0
  fi
  # After a `git pull` the lockfile can be newer than the installed modules.
  if [ -d "$REPO_DIR/node_modules/playwright" ] && [ -f "$REPO_DIR/node_modules/.modules.yaml" ] &&
    [ "$REPO_DIR/pnpm-lock.yaml" -nt "$REPO_DIR/node_modules/.modules.yaml" ]; then
    bad "Abhängigkeiten – veraltet (pnpm-lock.yaml wurde geändert)"
    note_missing
    cmdline "pnpm install --frozen-lockfile"
    if [ "$CHECK_ONLY" = 0 ] && ask "Jetzt aktualisieren?"; then
      (cd "$REPO_DIR" && pnpm install --frozen-lockfile) || net_error "pnpm install"
      OUTSTANDING=$((OUTSTANDING - 1))
      ok "Abhängigkeiten aktualisiert"
    fi
  elif [ -d "$REPO_DIR/node_modules/playwright" ]; then
    ok "Abhängigkeiten installiert (node_modules)"
  else
    bad "Abhängigkeiten – noch nicht installiert"
    note_missing
    info "pnpm lädt jetzt die Programmbausteine (ca. 1–2 Minuten):"
    cmdline "pnpm install --frozen-lockfile"
    if [ "$CHECK_ONLY" = 0 ] && ask "Jetzt installieren?"; then
      (cd "$REPO_DIR" && pnpm install --frozen-lockfile) || net_error "pnpm install"
      OUTSTANDING=$((OUTSTANDING - 1))
      ok "Abhängigkeiten installiert"
    fi
  fi
  # Sources changed since the last build (e.g. after `git pull`) → rebuild.
  local stale=""
  if [ -f "$CLI_JS" ]; then
    stale="$(find "$REPO_DIR/src" "$REPO_DIR/package.json" -newer "$CLI_JS" -print 2>/dev/null | head -n 1)"
  fi
  if [ -f "$CLI_JS" ] && [ -z "$stale" ]; then
    ok "Bello ist gebaut (dist/cli/index.js)"
  else
    if [ -f "$CLI_JS" ]; then
      bad "Bello – veraltet (Quellcode wurde seit dem letzten Bauen geändert)"
    else
      bad "Bello – noch nicht gebaut"
    fi
    note_missing
    if [ ! -d "$REPO_DIR/node_modules/playwright" ]; then
      info "Zuerst müssen die Abhängigkeiten installiert werden."
      return 0
    fi
    info "Der Quellcode wird in ein lauffähiges Programm übersetzt:"
    cmdline "pnpm build"
    if [ "$CHECK_ONLY" = 0 ] && ask "Jetzt bauen?"; then
      (cd "$REPO_DIR" && pnpm build) || die "Der Build ist fehlgeschlagen." "Die Fehlermeldung steht oben."
      OUTSTANDING=$((OUTSTANDING - 1))
      ok "Bello gebaut"
    fi
  fi
}

# --- step: Chromium, data files, system libraries (via the Bello CLI) -------
DOCTOR_OUT=""
run_doctor_quiet() {
  DOCTOR_OUT="$(cd "$REPO_DIR" && NO_COLOR=1 "$NODE_BIN" "$CLI_JS" doctor --offline 2>&1 || true)"
}
doctor_has() { printf '%s\n' "$DOCTOR_OUT" | grep -q -- "$1"; }

step_browser_and_data() {
  title "5. Browser (Chromium) und Datendateien"
  if [ ! -f "$CLI_JS" ]; then
    bad "Chromium / Datendateien – kann erst nach dem Bauen geprüft werden"
    return 0
  fi
  run_doctor_quiet
  local chromium_ok=0 data_ok=1
  doctor_has '✓ Chromium installiert' && chromium_ok=1
  doctor_has '✗ Datei ' && data_ok=0

  if [ "$chromium_ok" = 1 ]; then
    ok "Chromium (Browser für die Prüfungen) heruntergeladen"
  else
    bad "Chromium – noch nicht heruntergeladen (ca. 150 MB)"
  fi
  if [ "$data_ok" = 1 ]; then
    ok "Datendateien (EasyPrivacy, DB-IP) vorhanden"
  else
    bad "Datendateien (EasyPrivacy-Trackerliste, DB-IP-Länderdaten) – fehlen"
  fi
  [ "$chromium_ok" = 1 ] && [ "$data_ok" = 1 ] && return 0

  note_missing
  info "Bello lädt einen eigenen Browser und Datenlisten in Ihren Benutzerordner:"
  cmdline "node dist/cli/index.js setup"
  [ "$CHECK_ONLY" = 1 ] && return 0
  if ask "Jetzt herunterladen?"; then
    # setup exits non-zero when system libraries are missing; handled in the next step.
    (cd "$REPO_DIR" && "$NODE_BIN" "$CLI_JS" setup) || true
    run_doctor_quiet
    if doctor_has '✓ Chromium installiert' && ! doctor_has '✗ Datei '; then
      OUTSTANDING=$((OUTSTANDING - 1))
      ok "Chromium und Datendateien sind da"
    else
      warn "Der Download war nicht vollständig. Prüfen Sie die Internetverbindung und starten Sie ./install.sh erneut."
    fi
  fi
}

step_libs() {
  title "6. Systembibliotheken für Chromium"
  if [ "$OS_KIND" = "macos" ]; then
    ok "macOS – keine zusätzlichen Systempakete nötig"
    return 0
  fi
  if [ ! -f "$CLI_JS" ]; then
    bad "Systembibliotheken – kann erst nach dem Bauen geprüft werden"
    return 0
  fi
  run_doctor_quiet
  if doctor_has '✓ Systembibliotheken vollständig'; then
    ok "Systembibliotheken vollständig"
    return 0
  fi
  if doctor_has '! Systembibliotheken'; then
    bad "Systembibliotheken – noch nicht prüfbar (Chromium fehlt noch)"
    return 0
  fi
  local missing cmd
  missing="$(printf '%s\n' "$DOCTOR_OUT" | sed -n 's/^✗ Fehlende Systembibliotheken – //p' | sed -n '1p')"
  cmd="$(printf '%s\n' "$DOCTOR_OUT" | grep -E '^ *(sudo )?(apt-get|dnf|pacman|zypper) ' | sed -n '1p' | sed -e 's/^ *//' || true)"
  bad "Systembibliotheken – es fehlen: ${missing:-unbekannt}"
  note_missing
  info "Chromium braucht einige Systembibliotheken (Schriften, Grafik, Netzwerk)."
  if [ -z "$cmd" ]; then
    info "Für $DISTRO_NAME gibt es keine fertige Paketliste. Installieren Sie die Pakete, die diese"
    info "Bibliotheken enthalten, mit Ihrem Paketmanager."
    return 0
  fi
  cmd="${cmd#sudo }"
  # Fresh systems often have empty package lists; refresh first on apt.
  [ "$PKG" = "apt" ] && cmd="apt-get update && $cmd"
  if [ "$PKG" = "pacman" ]; then
    cmd="$cmd || (pacman -Sy --noconfirm && ${cmd%% ||*})"
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    info "Befehl dafür:"
    cmdline "$(root_display "$cmd")"
    info "(Dafür sind Administratorrechte nötig.)"
    return 0
  fi
  if offer_root_command "Die Systembibliotheken" "$cmd"; then
    run_doctor_quiet
    if doctor_has '✓ Systembibliotheken vollständig'; then
      OUTSTANDING=$((OUTSTANDING - 1))
      ok "Systembibliotheken installiert"
    else
      warn "Es fehlen weiterhin Bibliotheken. Details zeigt: bello doctor"
    fi
  else
    info "Bello funktioniert erst, wenn dieser Befehl ausgeführt wurde."
  fi
}

# --- step: bello command + PATH ---------------------------------------------
wrapper_content() {
  printf '#!/bin/sh\n# Generated by Bello install.sh\nexec %q %q "$@"\n' "$NODE_BIN" "$CLI_JS"
}

step_command() {
  title "7. Befehl bello"
  if [ -z "$NODE_BIN" ]; then
    bad "Befehl bello – kann erst nach Node.js eingerichtet werden"
    return 0
  fi
  local wrapper="$BIN_DIR/bello" want
  want="$(wrapper_content)"
  if [ -f "$wrapper" ] && [ "$(cat "$wrapper")" = "$want" ]; then
    ok "Befehl bello vorhanden ($wrapper)"
  else
    bad "Befehl bello – noch nicht eingerichtet"
    note_missing
    info "Ein kleines Startskript, damit bello in jedem Ordner funktioniert:"
    cmdline "$wrapper → node $CLI_JS"
    if [ "$CHECK_ONLY" = 0 ] && ask "Startskript jetzt anlegen?"; then
      mkdir -p "$BIN_DIR"
      printf '%s\n' "$want" >"$wrapper"
      chmod +x "$wrapper"
      OUTSTANDING=$((OUTSTANDING - 1))
      ok "Befehl bello angelegt"
    fi
  fi

  if [ "$ON_PATH" = 1 ]; then
    ok "$BIN_DIR ist im PATH"
    return 0
  fi
  warn "$BIN_DIR ist (noch) nicht im PATH – bello wird in neuen Terminals nicht gefunden"
  local shell_name rc="" line marker="# Bello (install.sh): Programme in ~/.local/bin finden"
  shell_name="$(basename "${SHELL:-}")"
  # shellcheck disable=SC2016
  line='export PATH="$HOME/.local/bin:$PATH"'
  case "$shell_name" in
    zsh) rc="$HOME/.zshrc" ;;
    bash)
      if [ "$OS_KIND" = "macos" ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      ;;
    fish)
      rc="$HOME/.config/fish/config.fish"
      # shellcheck disable=SC2016
      line='fish_add_path $HOME/.local/bin'
      ;;
  esac
  if [ -z "$rc" ]; then
    info "Ihre Shell ($shell_name) kenne ich nicht. Fügen Sie dies zu Ihrer Shell-Konfiguration hinzu:"
    cmdline "$line"
    return 0
  fi
  if [ -f "$rc" ] && grep -qF "$marker" "$rc"; then
    ok "Eintrag in $rc ist schon vorhanden – öffnen Sie ein neues Terminal"
    return 0
  fi
  note_missing
  info "Es wird diese Zeile an $rc angehängt:"
  cmdline "$line"
  if [ "$CHECK_ONLY" = 0 ] && ask "Jetzt eintragen?"; then
    mkdir -p "$(dirname "$rc")"
    printf '\n%s\n%s\n' "$marker" "$line" >>"$rc"
    OUTSTANDING=$((OUTSTANDING - 1))
    ok "Eingetragen in $rc"
    PATH_CHANGED=1
  fi
}
PATH_CHANGED=0

# --- step: global config (report directory) -----------------------------------
GLOBAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/bello/bello.config.yaml"
case "${XDG_CONFIG_HOME:-}" in
  /*) ;;
  *) GLOBAL_CONFIG="$HOME/.config/bello/bello.config.yaml" ;;
esac

step_global_config() {
  [ "$CHECK_ONLY" = 1 ] && return 0
  title "8. Globales Report-Verzeichnis (optional)"
  if [ -e "$GLOBAL_CONFIG" ]; then
    ok "Globale Konfiguration vorhanden ($GLOBAL_CONFIG) – wird nicht verändert"
    return 0
  fi
  info "Ohne Konfiguration landen Reports in ./bello-reports des jeweils aktuellen Ordners."
  info "Eine globale Konfiguration legt einen festen Ordner fest: ~/bello-reports"
  info "(Datei: $GLOBAL_CONFIG)"
  if ask "Globale Konfiguration jetzt anlegen?"; then
    mkdir -p "$(dirname "$GLOBAL_CONFIG")"
    if [ -e "$GLOBAL_CONFIG" ]; then return 0; fi
    printf '# Bello – globale Konfiguration (siehe bello.config.example.yaml)\ndefaults:\n  outDir: ~/bello-reports\n' >"$GLOBAL_CONFIG"
    ok "Angelegt: $GLOBAL_CONFIG"
    info "Reports landen künftig in ~/bello-reports (mit --here im aktuellen Ordner)."
  else
    info "Übersprungen. Reports landen in ./bello-reports des aktuellen Ordners."
  fi
}

# ------------------------------------------------------------------- main ---
main() {
  detect_platform
  printf '%sBello – Installation%s\n' "$C_BOLD" "$C_OFF"
  printf '%sSystem: %s, %s%s\n' "$C_DIM" "$DISTRO_NAME" "$ARCH" "$C_OFF"
  [ "$CHECK_ONLY" = 1 ] && printf '%sNur-Prüfen-Modus: es wird nichts verändert.%s\n' "$C_DIM" "$C_OFF"

  step_basics
  step_node
  step_pnpm
  step_build
  step_browser_and_data
  step_libs
  step_command
  step_global_config

  printf '\n'
  if [ "$CHECK_ONLY" = 1 ]; then
    if [ "$OUTSTANDING" -gt 0 ]; then
      printf '%s%d Punkt(e) fehlen noch.%s Zum Einrichten: ./install.sh\n' "$C_YELLOW" "$OUTSTANDING" "$C_OFF"
      exit 1
    fi
    printf '%sAlles in Ordnung.%s\n' "$C_GREEN" "$C_OFF"
    exit 0
  fi

  if [ "$OUTSTANDING" -gt 0 ]; then
    printf '%sNoch nicht fertig: %d Punkt(e) fehlen (siehe ✗ oben).%s\n' "$C_YELLOW" "$OUTSTANDING" "$C_OFF"
    printf 'Starten Sie ./install.sh erneut, wenn Sie das erledigt haben.\n'
    exit 1
  fi

  if [ -f "$CLI_JS" ]; then
    title "Abschlusstest: bello doctor"
    (cd "$REPO_DIR" && "$NODE_BIN" "$CLI_JS" doctor) || {
      warn "bello doctor meldet Probleme (siehe oben)."
      exit 1
    }
  fi

  cat <<EOF

${C_GREEN}${C_BOLD}Fertig!${C_OFF} So geht's weiter:

  1. $( [ "$PATH_CHANGED" = 1 ] || [ "$ON_PATH" = 0 ] && echo "Öffnen Sie ein neues Terminal-Fenster. Dann:" || echo "Eine Website prüfen:" )
       ${C_BOLD}bello www.beispiel.de${C_OFF}
  2. Die Ergebnisse (HTML- und JSON-Report) landen im Report-Verzeichnis. Welches das ist,
     zeigt ${C_BOLD}bello doctor${C_OFF}; ohne globale Konfiguration ist es ${C_BOLD}bello-reports/${C_OFF} im
     aktuellen Ordner. Mit ${C_BOLD}--here${C_OFF} erzwingen Sie den aktuellen Ordner.
  3. Bei Problemen: ${C_BOLD}bello doctor${C_OFF} zeigt, was fehlt, und wie es zu beheben ist.
EOF
}

main

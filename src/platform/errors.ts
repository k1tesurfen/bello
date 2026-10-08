const DOCTOR_HINT = 'Führe `bello doctor` aus, um die Umgebung zu prüfen.';

function messageOf(err: unknown): string {
  if (err instanceof Error) return `${err.message}\n${err.stack ?? ''}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Translate cryptic browser-startup / environment errors into a German message with a hint.
 * Returns `undefined` if the error is not a known startup problem.
 */
export function translateStartupError(err: unknown): string | undefined {
  const text = messageOf(err);

  const lib = /error while loading shared libraries:\s*([^\s:]+)/.exec(text);
  if (lib?.[1]) {
    return (
      `Dem Browser fehlt die Systembibliothek ${lib[1]}. ` +
      `Chromium kann deshalb nicht starten. ${DOCTOR_HINT} ` +
      'Dort steht der passende Installationsbefehl für deine Distribution.'
    );
  }

  if (
    /Executable doesn't exist|browserType\.launch: Executable|Looks like Playwright .* was just installed|please run the following command to download new browsers/i.test(
      text,
    )
  ) {
    return (
      'Chromium ist nicht installiert (oder die installierte Version passt nicht zu Bello). ' +
      'Führe `bello setup` aus, um den Browser herunterzuladen. ' +
      DOCTOR_HINT
    );
  }

  if (
    /No usable sandbox|no-sandbox|Running as root without --no-sandbox|Failed to move to new namespace|setuid sandbox|clone\(\) failed|namespace.*(?:denied|not permitted)|Operation not permitted.*namespace/i.test(
      text,
    )
  ) {
    return (
      'Chromium kann in dieser Umgebung seine Sandbox nicht starten (typisch in Containern oder ' +
      'bei root-Betrieb). Nutze das mitgelieferte Docker-Image, starte den Container mit einem ' +
      'nicht-privilegierten Benutzer und `--cap-add=SYS_ADMIN` bzw. einem passenden seccomp-Profil. ' +
      DOCTOR_HINT
    );
  }

  if (/Missing X server|\$DISPLAY|cannot open display|platform failed to initialize/i.test(text)) {
    return (
      'Es ist kein Display verfügbar, aber der Browser wurde mit sichtbarem Fenster gestartet. ' +
      'Verwende den Headless-Modus (ohne `--headful`) oder starte unter einem X-Server (z. B. xvfb-run). ' +
      DOCTOR_HINT
    );
  }

  if (
    /(easyprivacy|dbip-(country|asn)|data-meta)\b.*(ENOENT|nicht gefunden|not found)|ENOENT.*(easyprivacy|dbip-)/i.test(
      text,
    )
  ) {
    return `Die Datendateien (EasyPrivacy, DB-IP) fehlen. Führe \`bello setup\` bzw. \`bello vendors update\` aus. ${DOCTOR_HINT}`;
  }

  return undefined;
}

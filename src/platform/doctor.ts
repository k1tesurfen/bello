import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { access, constants, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import pc from 'picocolors';
import { launchScenarioBrowser } from '../browser/launch.js';
import { hostConnectionsFromFile } from '../capture/netlog/index.js';
import { Classifier, isEuEeaCountry } from '../classify/index.js';
import { dataStatus } from '../data/index.js';
import { BELLO_VERSION } from '../version.js';
import { translateStartupError } from './errors.js';
import { checkSystemLibs, chromiumExecutablePath, chromiumInstalled } from './libs.js';
import { detectOs } from './os.js';
import { printCheck, type CheckLine } from './output.js';

export interface DoctorOptions {
  /** Skip checks needing the internet (exit IP). */
  offline?: boolean;
  /** Report root to test for writability (default `<cwd>/bello-reports`). */
  outDir?: string;
  /** German reason shown next to the directory, e.g. „aus Konfiguration …“. */
  outDirReason?: string;
}

const STALE_DAYS = 30;

/** Writable if it exists, or if its nearest existing ancestor is a writable directory (nothing is created). */
async function checkWritableOrCreatable(dir: string): Promise<void> {
  let cur = dir;
  for (;;) {
    try {
      const st = await stat(cur);
      if (!st.isDirectory()) throw new Error('not a directory');
      await access(cur, constants.W_OK);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = dirname(cur);
      if (parent === cur) throw e;
      cur = parent;
    }
  }
}

/** Launch Chromium headless with NetLog against a tiny local server and verify capture works. */
async function testStart(): Promise<CheckLine> {
  const label = 'Test-Start von Chromium (headless, NetLog)';
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Bello Doctor</title><p>ok</p>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const dir = await mkdtemp(join(tmpdir(), 'bello-doctor-'));
  try {
    const sb = await launchScenarioBrowser({
      netLogPath: join(dir, 'netlog.json'),
      cdp: false,
      timeoutMs: 30_000,
    });
    let version = sb.browserVersion;
    try {
      const page = await sb.context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { timeout: 15_000 });
    } finally {
      await sb.close();
    }
    const { connections } = await hostConnectionsFromFile(sb.netLogPath, 0);
    const seen = connections.some((c) => c.host === '127.0.0.1' && c.urlRequests.length > 0);
    if (!seen) {
      return {
        status: 'fail',
        label,
        detail: 'Seite geladen, aber das NetLog enthält keine Verbindung',
        hint: 'Das Capture funktioniert nicht. Chromium neu installieren: `bello setup`.',
      };
    }
    version = version || 'unbekannt';
    return { status: 'ok', label, detail: `Capture funktioniert (Chromium ${version})` };
  } catch (err) {
    const translated = translateStartupError(err);
    return {
      status: 'fail',
      label,
      detail: (err as Error).message.split('\n')[0] ?? String(err),
      hint: translated ?? 'Chromium lässt sich nicht starten. Führe `bello setup` aus.',
    };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function exitIpCheck(): Promise<CheckLine> {
  const label = 'Exit-IP in der EU';
  let ip: string;
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ip = (await res.text()).trim();
  } catch (err) {
    return {
      status: 'warn',
      label,
      detail: `Exit-IP nicht ermittelbar (${(err as Error).message})`,
      hint: 'Keine Internetverbindung? Mit `--offline` wird diese Prüfung übersprungen.',
    };
  }
  try {
    const classifier = await Classifier.create({ skipExternalData: false });
    const info = classifier.lookupIp(ip);
    if (!info?.country) {
      return {
        status: 'warn',
        label,
        detail: `${ip}: Land unbekannt`,
        hint: 'DB-IP-Daten fehlen oder veraltet: `bello vendors update`.',
      };
    }
    const eu = isEuEeaCountry(info.country);
    return eu
      ? { status: 'ok', label, detail: `${ip} (${info.country})` }
      : {
          status: 'warn',
          label,
          detail: `${ip} (${info.country}) liegt außerhalb der EU/des EWR`,
          hint: 'Scans sollten von einer EU-IP aus laufen (sonst liefern Seiten evtl. andere Banner). Nutze `--proxy` oder einen deutschen Server.',
        };
  } catch (err) {
    return {
      status: 'warn',
      label,
      detail: (err as Error).message,
      hint: 'DB-IP-Daten laden: `bello setup`.',
    };
  }
}

/** `bello doctor` (PLAN §16). Returns 0 if no check failed, else 3 (warnings do not fail). */
export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  const checks: CheckLine[] = [];
  const add = (c: CheckLine): void => {
    checks.push(c);
    printCheck(c);
  };
  console.log(pc.bold('Bello – Umgebungsprüfung'));
  console.log();

  // Node + Bello
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  add(
    major >= 22
      ? { status: 'ok', label: 'Node.js', detail: process.versions.node }
      : {
          status: 'fail',
          label: 'Node.js',
          detail: process.versions.node,
          hint: 'Bello benötigt Node.js ≥ 22. Bitte aktualisieren.',
        },
  );
  add({ status: 'ok', label: 'Bello', detail: `Version ${BELLO_VERSION}` });

  // OS
  const os = await detectOs();
  const osDetail = `${os.label}, ${os.arch}`;
  if (os.platform === 'win32') {
    add({
      status: 'warn',
      label: 'Betriebssystem',
      detail: osDetail,
      hint: 'Windows ist nicht Ziel von v1 (ungetestet). Empfohlen: Docker oder WSL.',
    });
  } else if (os.platform === 'linux' && os.packageManager === 'unknown') {
    add({
      status: 'warn',
      label: 'Betriebssystem',
      detail: osDetail,
      hint: 'Distribution unbekannt: Best Effort. Fehlende Bibliotheken müssen manuell installiert werden.',
    });
  } else {
    add({ status: 'ok', label: 'Betriebssystem', detail: osDetail });
  }

  // Chromium present
  const exe = chromiumExecutablePath();
  const hasChromium = await chromiumInstalled(exe);
  const revision = /chromium(?:_headless_shell)?-(\d+)/.exec(exe)?.[1];
  add(
    hasChromium
      ? {
          status: 'ok',
          label: 'Chromium installiert',
          detail: revision ? `Playwright-Revision ${revision}` : exe,
        }
      : {
          status: 'fail',
          label: 'Chromium nicht installiert',
          detail: exe,
          hint: 'Führe `bello setup` aus.',
        },
  );

  // System libraries (Linux)
  let libsOk = true;
  if (os.platform === 'linux') {
    const libs = await checkSystemLibs({
      family: os.packageManager,
      ...(os.distro ? { distro: os.distro } : {}),
    });
    if (!libs.checked) {
      add({
        status: 'warn',
        label: 'Systembibliotheken',
        detail: 'nicht geprüft',
        hint:
          libs.reason === 'no-binary'
            ? 'Erst `bello setup` ausführen.'
            : '`ldd` ist nicht verfügbar.',
      });
    } else if (libs.missing.length === 0) {
      add({ status: 'ok', label: 'Systembibliotheken vollständig' });
    } else {
      libsOk = false;
      const hint = libs.installCommand
        ? `Installiere die Pakete mit:\n${libs.installCommand}`
        : `Keine Paketliste für ${os.label}. Installiere die Pakete, die diese Bibliotheken liefern.`;
      add({
        status: 'fail',
        label: 'Fehlende Systembibliotheken',
        detail: libs.missing.join(', '),
        hint: libs.unmapped.length
          ? `${hint}\nNicht zuordenbar: ${libs.unmapped.join(', ')}`
          : hint,
      });
    }
  }

  // Test start
  if (!hasChromium || !libsOk) {
    add({
      status: 'fail',
      label: 'Test-Start von Chromium',
      detail: 'übersprungen',
      hint: 'Zuerst die oben genannten Probleme beheben.',
    });
  } else {
    add(await testStart());
  }

  // Data files
  const statuses = await dataStatus();
  for (const s of statuses) {
    if (!s.present) {
      add({
        status: 'fail',
        label: `Datei ${s.id}`,
        detail: 'fehlt',
        hint: 'Führe `bello setup` bzw. `bello vendors update` aus.',
      });
    } else if ((s.ageDays ?? 0) > STALE_DAYS) {
      add({
        status: 'warn',
        label: `Datei ${s.id}`,
        detail: `${s.ageDays} Tage alt`,
        hint: 'Aktualisieren mit `bello vendors update`.',
      });
    } else {
      add({ status: 'ok', label: `Datei ${s.id}`, detail: `${s.ageDays ?? 0} Tage alt` });
    }
  }

  // Output dir
  const outDir = resolve(opts.outDir ?? './bello-reports');
  const outDetail = opts.outDirReason ? `${outDir} (${opts.outDirReason})` : outDir;
  try {
    await checkWritableOrCreatable(outDir);
    add({ status: 'ok', label: 'Report-Verzeichnis beschreibbar', detail: outDetail });
  } catch {
    add({
      status: 'fail',
      label: 'Report-Verzeichnis nicht beschreibbar',
      detail: outDetail,
      hint: 'Rechte prüfen oder mit `--out <Ordner>`, `--here` bzw. `defaults.outDir` in der Konfiguration ein anderes Verzeichnis wählen.',
    });
  }

  // Exit IP
  if (opts.offline) {
    add({ status: 'ok', label: 'Exit-IP-Prüfung', detail: 'übersprungen (--offline)' });
  } else {
    add(await exitIpCheck());
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  console.log();
  if (failed > 0) {
    console.log(
      pc.red(`${failed} Problem(e) gefunden.`) + (warned ? ` ${warned} Warnung(en).` : ''),
    );
    return 3;
  }
  console.log(pc.green('Alles in Ordnung.') + (warned ? pc.yellow(` ${warned} Warnung(en).`) : ''));
  return 0;
}

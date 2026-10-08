import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import pc from 'picocolors';
import { updateDbIp, updateEasyPrivacy } from '../data/index.js';
import { runDoctor } from './doctor.js';
import { chromiumExecutablePath, checkSystemLibs } from './libs.js';
import { detectOs } from './os.js';
import { printCheck } from './output.js';

export interface SetupOptions {
  /** Skip Chromium and dataset downloads (CI, offline). */
  skipDownloads?: boolean;
}

export function nodeMajor(version = process.versions.node): number {
  return Number.parseInt(version.split('.')[0] ?? '0', 10);
}

/** Absolute path to Playwright's CLI script inside node_modules. */
export function playwrightCliPath(): string {
  const req = createRequire(import.meta.url);
  return join(dirname(req.resolve('playwright/package.json')), 'cli.js');
}

function installChromium(): Promise<number> {
  return new Promise((resolve) => {
    // No shell: spawn the node binary with Playwright's CLI script directly.
    const child = spawn(process.execPath, [playwrightCliPath(), 'install', 'chromium'], {
      stdio: 'inherit',
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** `bello setup` (PLAN §16). Returns the process exit code (0 ok, 3 technical error). */
export async function runSetup(opts: SetupOptions = {}): Promise<number> {
  let failed = false;
  console.log(pc.bold('Bello – Einrichtung'));
  console.log();

  // 1. Node version
  const major = nodeMajor();
  if (major >= 22) {
    printCheck({ status: 'ok', label: 'Node.js', detail: process.versions.node });
  } else {
    printCheck({
      status: 'fail',
      label: 'Node.js',
      detail: process.versions.node,
      hint: 'Bello benötigt Node.js ≥ 22. Bitte aktualisieren (z. B. https://nodejs.org oder nvm).',
    });
    return 3;
  }

  // 2. Chromium
  if (opts.skipDownloads) {
    printCheck({ status: 'warn', label: 'Chromium-Download übersprungen' });
  } else {
    console.log(pc.dim('Lade Chromium (gepinnte Playwright-Version) …'));
    const code = await installChromium();
    if (code === 0) {
      printCheck({ status: 'ok', label: 'Chromium installiert', detail: chromiumExecutablePath() });
    } else {
      failed = true;
      printCheck({
        status: 'fail',
        label: 'Chromium-Download fehlgeschlagen',
        hint: 'Prüfe die Internetverbindung (und ggf. Proxy-Einstellungen) und wiederhole `bello setup`.',
      });
    }
  }

  // 3. Data files
  if (opts.skipDownloads) {
    printCheck({ status: 'warn', label: 'Datendownload übersprungen' });
  } else {
    console.log(pc.dim('Lade EasyPrivacy und DB-IP Lite …'));
    try {
      const ep = await updateEasyPrivacy();
      printCheck({
        status: 'ok',
        label: 'EasyPrivacy',
        detail: `${Math.round(ep.bytes / 1024)} KiB`,
      });
    } catch (err) {
      failed = true;
      printCheck({
        status: 'fail',
        label: 'EasyPrivacy',
        detail: (err as Error).message,
        hint: 'Internetverbindung prüfen und `bello vendors update` wiederholen.',
      });
    }
    try {
      const results = await updateDbIp();
      for (const r of results)
        printCheck({ status: 'ok', label: r.id, detail: `${Math.round(r.bytes / 1024)} KiB` });
    } catch (err) {
      failed = true;
      printCheck({
        status: 'fail',
        label: 'DB-IP Lite',
        detail: (err as Error).message,
        hint: 'Internetverbindung prüfen und `bello vendors update` wiederholen.',
      });
    }
  }

  // 4. System libraries (Linux)
  const os = await detectOs();
  if (os.platform === 'linux') {
    const libs = await checkSystemLibs({
      family: os.packageManager,
      ...(os.distro ? { distro: os.distro } : {}),
    });
    if (!libs.checked) {
      printCheck({
        status: 'warn',
        label: 'Systembibliotheken nicht geprüft',
        hint:
          libs.reason === 'no-binary'
            ? 'Chromium ist noch nicht installiert (`bello setup` ohne --skip-downloads).'
            : '`ldd` ist nicht verfügbar.',
      });
    } else if (libs.missing.length === 0) {
      printCheck({ status: 'ok', label: 'Systembibliotheken vollständig' });
    } else {
      console.log(`${pc.red('✗')} Fehlende Systembibliotheken: ${libs.missing.join(', ')}`);
      if (libs.installCommand) {
        console.log('  Installiere sie mit (Bello führt `sudo` nie selbst aus):');
        console.log(`\n    ${pc.bold(libs.installCommand)}\n`);
      } else {
        console.log(
          `  Für ${os.label} gibt es keine Paketliste. Installiere die Pakete, die diese Bibliotheken liefern.`,
        );
      }
      if (libs.unmapped.length > 0 && libs.installCommand)
        console.log(`  Nicht zuordenbar: ${libs.unmapped.join(', ')}`);
      failed = true;
    }
  }

  // 5. doctor
  console.log();
  const doctorCode = await runDoctor({ offline: opts.skipDownloads === true });
  return failed || doctorCode !== 0 ? 3 : 0;
}

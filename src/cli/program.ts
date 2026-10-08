/**
 * commander setup (PLAN §2): `bello <url>` (= scan), `scan`, `diff`, `vendors update`, `setup`,
 * `doctor`. Every action resolves to an exit code: 0 Grün, 1 Gelb, 2 Rot, 3 technical error.
 */
import pc from 'picocolors';
import { Command, InvalidArgumentError, Option } from 'commander';
import { diffReports } from '../analyze/diff.js';
import {
  describeReportRoot,
  loadConfig,
  resolveReportRoot,
  resolveScanOptions,
  type CliFlags,
} from '../config/index.js';
import { updateDbIp, updateEasyPrivacy } from '../data/index.js';
import { runDoctor } from '../platform/doctor.js';
import { runSetup } from '../platform/setup.js';
import { readJsonReport } from '../report/json.js';
import { renderTerminal } from '../report/terminal.js';
import { scanSite, type ScanSiteOptions, type ScenarioTuning } from '../scan/index.js';
import { DEFAULT_UA, discoverPages } from '../crawl/discover.js';
import type { Finding, TrafficLight } from '../types.js';
import { BELLO_VERSION } from '../version.js';
import { runBatchCommand } from './batch-command.js';
import { describeError } from './errors.js';
import { EXIT, processIo, type CliIo } from './io.js';

export interface ScanCommandOptions {
  all?: boolean;
  customer?: string;
  crawl?: boolean;
  pages?: number;
  config?: string;
  out?: string;
  here?: boolean;
  proxy?: string;
  identify?: boolean;
  rejectSelector?: string;
  acceptSelector?: string;
  wait?: number;
  pdf?: boolean;
  headful?: boolean;
  // hidden (tests / diagnostics)
  chromiumArg?: string[];
  skipIpCheck?: boolean;
  ignoreHttpsErrors?: boolean;
  fast?: boolean;
}

/** Short timings for tests and smoke runs (`--fast`, hidden). */
export const FAST_TUNING: ScenarioTuning = {
  passiveReader: {
    networkIdleTimeoutMs: 3000,
    scrollStepPx: 1500,
    scrollStepDelayMs: 60,
    bottomSettleMs: 300,
    mouseMoves: 3,
  },
  banner: { detectTimeoutMs: 4000, settleMs: 400, reappearCheckMs: 1000, secondLayerDelayMs: 300 },
  followLinkWaitSeconds: 0.3,
};

const LIGHT_EXIT: Record<TrafficLight, number> = {
  gruen: EXIT.gruen,
  gelb: EXIT.gelb,
  rot: EXIT.rot,
};

function intArg(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1)
    throw new InvalidArgumentError('Erwartet eine positive ganze Zahl.');
  return n;
}

function secondsArg(v: string): number {
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0)
    throw new InvalidArgumentError('Erwartet eine Zahl ≥ 0 (Sekunden).');
  return n;
}

function collect(v: string, prev: string[] = []): string[] {
  return [...prev, v];
}

function buildFlags(o: ScanCommandOptions): CliFlags {
  const flags: CliFlags = {};
  if (o.crawl) flags.crawl = true;
  if (o.pages !== undefined) flags.pages = o.pages;
  if (o.out !== undefined) flags.out = o.out;
  if (o.here) flags.here = true;
  if (o.proxy !== undefined) flags.proxy = o.proxy;
  if (o.identify) flags.identify = true;
  if (o.rejectSelector !== undefined) flags.rejectSelector = o.rejectSelector;
  if (o.acceptSelector !== undefined) flags.acceptSelector = o.acceptSelector;
  if (o.wait !== undefined) flags.wait = o.wait;
  if (o.pdf === false) flags.noPdf = true;
  if (o.headful) flags.headful = true;
  return flags;
}

function buildScanExtras(o: ScanCommandOptions): Partial<ScanSiteOptions> {
  return {
    ...(o.chromiumArg?.length ? { launchArgs: o.chromiumArg } : {}),
    ...(o.ignoreHttpsErrors ? { ignoreHttpsErrors: true } : {}),
    ...(o.skipIpCheck ? { skipExitIpCheck: true } : {}),
    ...(o.fast ? { scenarioTuning: FAST_TUNING, delayMs: 0 } : {}),
  };
}

export async function runScanCommand(
  url: string | undefined,
  o: ScanCommandOptions,
  io: CliIo,
  argv: string[],
): Promise<number> {
  if (!o.all && !url && !o.customer) {
    io.err('Keine URL angegeben. Beispiel: `bello example.de` oder `bello scan --customer acme`.');
    return EXIT.fehler;
  }
  try {
    const loaded = loadConfig(o.config);
    const flags = buildFlags(o);
    if (o.all) {
      const root = resolveReportRoot(loaded.config, flags);
      if (root.source === 'config') {
        io.err(pc.dim(`Reports: ${root.dir} (${describeReportRoot(root.source, loaded.path)})`));
      }
      return await runBatchCommand(
        loaded.config,
        {
          cliFlags: flags,
          scanExtras: {
            ...buildScanExtras(o),
            configPath: loaded.path,
            configSha256: loaded.sha256,
            commandLine: argv,
          },
        },
        io,
      );
    }
    const scanOpts = resolveScanOptions(loaded.config, {
      ...(o.customer !== undefined ? { customerId: o.customer } : {}),
      ...(url !== undefined ? { url } : {}),
      cliFlags: flags,
    });
    if (scanOpts.outDirSource === 'config') {
      io.err(
        pc.dim(
          `Reports: ${scanOpts.outDir} (${describeReportRoot(scanOpts.outDirSource, loaded.path)})`,
        ),
      );
    }
    let pages: string[] | undefined;
    if (scanOpts.crawl) {
      io.err(pc.dim(`Ermittle Seiten von ${scanOpts.url} (max. ${scanOpts.maxPages}) …`));
      const d = await discoverPages(scanOpts.url, {
        maxPages: scanOpts.maxPages,
        ...(scanOpts.proxy ? { proxy: scanOpts.proxy } : {}),
        delayMs: scanOpts.delayMs,
        ...(scanOpts.identify ? { userAgent: `${DEFAULT_UA} Bello/${BELLO_VERSION}` } : {}),
      });
      for (const n of d.notes) io.err(pc.dim(`  ${n}`));
      pages = d.pages;
      io.err(
        pc.dim(
          `${d.pages.length} Seite(n) werden geprüft (Quelle: ${d.source === 'sitemap' ? 'Sitemap' : 'Link-Crawl'}).`,
        ),
      );
    }
    io.err(pc.dim(`Bello ${BELLO_VERSION} – prüfe ${scanOpts.url} (Szenarien A, B, C) …`));
    const res = await scanSite({
      ...scanOpts,
      ...(pages ? { pages } : {}),
      configPath: loaded.path,
      configSha256: loaded.sha256,
      commandLine: argv,
      ...buildScanExtras(o),
      onProgress: (p) => {
        if (p.type === 'warning') io.err(pc.yellow(`⚠ ${p.message}`));
        else if (p.type !== 'done') io.err(pc.dim(`  ${p.message}`));
      },
    });
    io.out(renderTerminal(res.report, res.reportPath, { color: io.color ?? pc.isColorSupported }));
    return LIGHT_EXIT[res.report.trafficLight];
  } catch (err) {
    io.err(pc.red(await describeError(err)));
    return EXIT.fehler;
  }
}

function findingRow(f: Finding): string {
  return `  [${f.severity}] ${f.title}${f.scenarios.length ? ` (Szenario ${f.scenarios.join('/')})` : ''}`;
}

export async function runDiffCommand(
  a: string,
  b: string,
  o: { json?: boolean },
  io: CliIo,
): Promise<number> {
  try {
    const [ra, rb] = await Promise.all([readJsonReport(a), readJsonReport(b)]);
    const d = diffReports(ra, rb);
    if (o.json) {
      io.out(JSON.stringify(d, null, 2));
      return EXIT.gruen;
    }
    const lines: string[] = [];
    lines.push(
      pc.bold(`Vergleich ${ra.url} (${ra.meta.startedAt}) → ${rb.url} (${rb.meta.startedAt})`),
    );
    lines.push(`Ampel: ${d.trafficLight.before} → ${d.trafficLight.after}`);
    lines.push('');
    lines.push(pc.bold(`Neu (${d.new.length})`));
    d.new.forEach((f) => lines.push(pc.red(findingRow(f))));
    lines.push(pc.bold(`Behoben (${d.fixed.length})`));
    d.fixed.forEach((f) => lines.push(pc.green(findingRow(f))));
    lines.push(pc.bold(`Schweregrad geändert (${d.changed.length})`));
    d.changed.forEach((c) =>
      lines.push(`  ${c.after.title}: ${c.before.severity} → ${c.after.severity}`),
    );
    lines.push(pc.bold(`Unverändert (${d.unchanged.length})`));
    d.unchanged.forEach((f) => lines.push(pc.dim(findingRow(f))));
    io.out(lines.join('\n'));
    return EXIT.gruen;
  } catch (err) {
    io.err(pc.red(err instanceof Error ? err.message : String(err)));
    return EXIT.fehler;
  }
}

export async function runVendorsUpdate(io: CliIo): Promise<number> {
  try {
    io.err('Lade EasyPrivacy …');
    const ep = await updateEasyPrivacy();
    io.out(`✓ EasyPrivacy aktualisiert (${Math.round(ep.bytes / 1024)} KiB) → ${ep.path}`);
    io.err('Lade DB-IP Lite (Country + ASN) …');
    for (const r of await updateDbIp()) {
      io.out(`✓ ${r.id} aktualisiert (${Math.round(r.bytes / 1024)} KiB) → ${r.path}`);
    }
    io.out('IP-Geolokation: DB-IP.com (CC BY 4.0)');
    return EXIT.gruen;
  } catch (err) {
    io.err(
      pc.red(
        `Aktualisierung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}\nInternetverbindung prüfen und erneut versuchen.`,
      ),
    );
    return EXIT.fehler;
  }
}

/** German versions of commander's own (English) error messages. */
export function translateCommanderError(text: string): string {
  const rules: Array<[RegExp, (m: RegExpExecArray) => string]> = [
    [/unknown option '([^']+)'/, (m) => `Unbekannte Option „${m[1]}“.`],
    [/unknown command '([^']+)'/, (m) => `Unbekannter Befehl „${m[1]}“.`],
    [/missing required argument '([^']+)'/, (m) => `Pflichtargument „${m[1]}“ fehlt.`],
    [/option '([^']+)' argument missing/, (m) => `Der Option „${m[1]}“ fehlt ein Wert.`],
    [
      /option '([^']+)' argument '([^']*)' is invalid\.?\s*(.*)/,
      (m) => `Ungültiger Wert „${m[2]}“ für die Option „${m[1]}“.${m[3] ? ` ${m[3]}` : ''}`,
    ],
    [
      /too many arguments(?: for '([^']+)')?\.? ?(?:Expected (\d+) arguments? but got (\d+)\.?)?/,
      (m) =>
        `Zu viele Argumente${m[1] ? ` für „${m[1]}“` : ''}.${m[2] ? ` Erwartet: ${m[2]}, erhalten: ${m[3]}.` : ''}`,
    ],
  ];
  let out = text.trim();
  out = out.replace(/^error:\s*/i, '');
  for (const [re, fn] of rules) {
    const m = re.exec(out);
    if (m) {
      out = out.replace(re, fn(m));
      break;
    }
  }
  out = out.replace(/\(Did you mean ([^)]+)\?\)/g, '(Meinten Sie $1?)');
  out = out.replace(/\(Did you mean one of ([^)]+)\?\)/g, '(Meinten Sie eine von: $1?)');
  return `Fehler: ${out}\nHilfe: \`bello --help\`\n`;
}

/** Builds the commander program; the exit code of the executed action is stored in `result`. */
export function buildProgram(
  io: CliIo = processIo,
  result: { code: number } = { code: 0 },
): Command {
  const program = new Command()
    .name('bello')
    .description(
      'Bello – prüft, ob das Consent-Management einer Website Drittverbindungen vor bzw. ohne Einwilligung verhindert.',
    )
    .version(BELLO_VERSION, '-v, --version', 'Version anzeigen')
    .helpOption('-h, --help', 'Hilfe anzeigen')
    .helpCommand('help [befehl]', 'Hilfe zu einem Befehl anzeigen')
    .showSuggestionAfterError(true)
    .configureOutput({
      writeOut: (s) => io.out(s),
      writeErr: (s) => io.err(s),
      outputError: (str, write) => write(translateCommanderError(str)),
    })
    .exitOverride();

  const scan = program
    .command('scan [url]', { isDefault: true })
    .description(
      'Website prüfen (Standardbefehl): drei Szenarien, Terminal-Zusammenfassung + Report',
    )
    .option('--all', 'alle Kunden aus der Konfiguration prüfen (Nacht-Batch)')
    .option('--customer <id>', 'Kunden aus der Konfiguration prüfen')
    .option('--crawl', 'vollständiger Crawl (Sitemap, Fallback Link-Crawl)')
    .option('--pages <n>', 'maximale Seitenzahl beim Crawl', intArg)
    .option('--config <datei>', 'Pfad zur bello.config.yaml')
    .option(
      '--out <verzeichnis>',
      'Report-Verzeichnis (relativ zum aktuellen Verzeichnis); überschreibt --here und die Konfiguration',
    )
    .option(
      '--here',
      'Reports in ./bello-reports des aktuellen Verzeichnisses ablegen (statt im globalen Report-Verzeichnis)',
    )
    .option('--proxy <url>', 'Proxy für alle Verbindungen, z. B. http://proxy:3128')
    .option('--identify', 'User-Agent um „Bello/x.y“ ergänzen')
    .option('--reject-selector <css>', 'CSS-Selektor des Ablehnen-Buttons')
    .option('--accept-selector <css>', 'CSS-Selektor des Akzeptieren-Buttons')
    .option('--wait <sekunden>', 'Wartezeit des passiven Lesers (Standard 10)', secondsArg)
    .option('--no-pdf', 'keinen PDF-Report erzeugen')
    .option('--headful', 'Browser sichtbar starten (Debug)')
    .addOption(
      new Option('--chromium-arg <arg>', 'zusätzlicher Chromium-Schalter')
        .argParser(collect)
        .hideHelp(),
    )
    .addOption(new Option('--skip-ip-check', 'Standort-Check überspringen').hideHelp())
    .addOption(new Option('--ignore-https-errors', 'Zertifikatsfehler ignorieren').hideHelp())
    .addOption(new Option('--fast', 'kurze Wartezeiten (Tests)').hideHelp())
    .action(async (url: string | undefined, o: ScanCommandOptions) => {
      result.code = await runScanCommand(url, o, io, process.argv.slice());
    });
  void scan;

  program
    .command('diff <reportA> <reportB>')
    .description('zwei report.json vergleichen: neue, behobene und unveränderte Befunde')
    .option('--json', 'Ergebnis als JSON ausgeben')
    .action(async (a: string, b: string, o: { json?: boolean }) => {
      result.code = await runDiffCommand(a, b, o, io);
    });

  const vendors = program.command('vendors').description('Datenquellen verwalten');
  vendors
    .command('update')
    .description('EasyPrivacy und DB-IP Lite herunterladen bzw. aktualisieren')
    .action(async () => {
      result.code = await runVendorsUpdate(io);
    });

  program
    .command('setup')
    .description('Chromium und Datendateien laden, fehlende Systempakete melden')
    .option('--skip-downloads', 'keine Downloads (CI, offline)')
    .action(async (o: { skipDownloads?: boolean }) => {
      result.code = await runSetup(o.skipDownloads ? { skipDownloads: true } : {});
    });

  program
    .command('doctor')
    .description('Umgebung prüfen und Probleme mit Lösungshinweis ausgeben')
    .option('--offline', 'Prüfungen mit Internetzugriff überspringen')
    .option('--config <datei>', 'Pfad zur bello.config.yaml')
    .option('--out <verzeichnis>', 'Report-Verzeichnis prüfen (wie bei scan)')
    .option('--here', 'Verzeichnis ./bello-reports im aktuellen Verzeichnis prüfen')
    .action(async (o: { offline?: boolean; config?: string; out?: string; here?: boolean }) => {
      try {
        const loaded = loadConfig(o.config);
        const root = resolveReportRoot(loaded.config, {
          ...(o.out !== undefined ? { out: o.out } : {}),
          ...(o.here ? { here: true } : {}),
        });
        result.code = await runDoctor({
          outDir: root.dir,
          outDirReason: describeReportRoot(root.source, loaded.path),
          ...(o.offline ? { offline: true } : {}),
        });
      } catch (err) {
        io.err(pc.red(await describeError(err)));
        result.code = EXIT.fehler;
      }
    });

  return program;
}

/** Runs the CLI and returns the exit code. */
export async function main(argv: string[], io: CliIo = processIo): Promise<number> {
  const result = { code: 0 };
  const program = buildProgram(io, result);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    const e = err as { code?: string; exitCode?: number };
    if (
      e.code === 'commander.helpDisplayed' ||
      e.code === 'commander.version' ||
      e.code === 'commander.help'
    ) {
      return 0;
    }
    if (typeof e.exitCode === 'number' && e.code?.startsWith('commander.')) return EXIT.fehler;
    io.err(pc.red(await describeError(err)));
    return EXIT.fehler;
  }
  return result.code;
}

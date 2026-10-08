/** `bello scan --all`: batch over all customers with overview (PLAN §11). */
import pc from 'picocolors';
import { runBatch } from '../batch/index.js';
import type { BelloConfig, CliFlags } from '../config/index.js';
import { writeBatchSummary } from '../report/batch.js';
import type { ScanSiteOptions } from '../scan/index.js';
import { EXIT, type CliIo } from './io.js';

const LABEL = { gruen: 'Grün', gelb: 'Gelb', rot: 'Rot' } as const;

export async function runBatchCommand(
  config: BelloConfig,
  o: { customers?: string[]; cliFlags: CliFlags; scanExtras: Partial<ScanSiteOptions> },
  io: CliIo,
): Promise<number> {
  const total = o.customers?.length ?? Object.keys(config.customers).length;
  io.err(
    pc.dim(`Batch: ${total} Kunde(n), bis zu ${config.defaults.crawl.sitesInParallel} parallel …`),
  );
  const batch = await runBatch(config, {
    ...(o.customers ? { customers: o.customers } : {}),
    cliFlags: o.cliFlags,
    scanExtras: o.scanExtras,
    onProgress: (p) => {
      if (p.type === 'customer-error') io.err(pc.red(`✗ ${p.customerId}: ${p.message}`));
      else if (p.type === 'customer-done') io.err(pc.green(`✓ ${p.customerId}: ${p.message}`));
      else if (p.type === 'customer-start' || p.type === 'crawl')
        io.err(pc.dim(`[${p.customerId}] ${p.message}`));
    },
  });
  const files = await writeBatchSummary(batch, { companyName: config.company.name });
  const lines = batch.customers.map((c) => {
    const status = c.status === 'fehler' ? pc.red('Fehler') : LABEL[c.trafficLight ?? 'gelb'];
    const ch = c.change
      ? ` (${c.change.neu} neu, ${c.change.behoben} behoben, ${c.change.unveraendert} unverändert)`
      : '';
    return `  ${c.id.padEnd(20)} ${status}${ch}${c.error ? ` – ${c.error}` : ''}`;
  });
  io.out(['Batch-Ergebnis:', ...lines, '', `Übersicht: ${files.htmlPath}`].join('\n'));
  return batch.exitCode === 3 ? EXIT.fehler : batch.exitCode;
}

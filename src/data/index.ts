import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { dataPaths, type DataPaths } from '../platform/paths.js';

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_MMDB_BYTES = 300 * 1024 * 1024;

export const EASYPRIVACY_URL = 'https://easylist.to/easylist/easyprivacy.txt';

export function dbipUrl(kind: 'country' | 'asn', year: number, month: number): string {
  const mm = String(month).padStart(2, '0');
  return `https://download.db-ip.com/free/dbip-${kind}-lite-${year}-${mm}.mmdb.gz`;
}

export type DatasetId = 'easyprivacy' | 'dbip-country' | 'dbip-asn';

export interface DataOptions {
  /** Override cache directory (tests). */
  dir?: string;
  fetchImpl?: typeof fetch;
  /** Current time (tests). */
  now?: Date;
}

interface MetaEntry {
  updatedAt: string;
  source: string;
}
type Meta = Partial<Record<DatasetId, MetaEntry>>;

async function readMeta(p: DataPaths): Promise<Meta> {
  try {
    return JSON.parse(await readFile(p.meta, 'utf8')) as Meta;
  } catch {
    return {};
  }
}

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function setMeta(p: DataPaths, id: DatasetId, entry: MetaEntry): Promise<void> {
  const meta = await readMeta(p);
  meta[id] = entry;
  await writeAtomic(p.meta, JSON.stringify(meta, null, 2));
}

async function download(url: string, f: typeof fetch): Promise<Buffer | null> {
  const res = await f(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Download von ${url} fehlgeschlagen: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface UpdateResult {
  id: DatasetId;
  path: string;
  source: string;
  bytes: number;
}

export async function updateEasyPrivacy(opts: DataOptions = {}): Promise<UpdateResult> {
  const p = dataPaths(opts.dir ? { dir: opts.dir } : {});
  const f = opts.fetchImpl ?? fetch;
  const buf = await download(EASYPRIVACY_URL, f);
  if (!buf) throw new Error(`EasyPrivacy nicht gefunden: ${EASYPRIVACY_URL}`);
  const text = buf.toString('utf8');
  if (!text.includes('||'))
    throw new Error('EasyPrivacy-Liste ist ungültig (keine Domain-Regeln gefunden).');
  await mkdir(p.dir, { recursive: true });
  await writeAtomic(p.easyPrivacy, buf);
  await setMeta(p, 'easyprivacy', {
    updatedAt: (opts.now ?? new Date()).toISOString(),
    source: EASYPRIVACY_URL,
  });
  return { id: 'easyprivacy', path: p.easyPrivacy, source: EASYPRIVACY_URL, bytes: buf.length };
}

/** Download DB-IP Lite country + ASN. Falls back to the previous month(s) if not yet published. */
export async function updateDbIp(opts: DataOptions = {}): Promise<UpdateResult[]> {
  const p = dataPaths(opts.dir ? { dir: opts.dir } : {});
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  await mkdir(p.dir, { recursive: true });
  const results: UpdateResult[] = [];
  for (const kind of ['country', 'asn'] as const) {
    let done = false;
    for (let back = 0; back < 3 && !done; back++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      const url = dbipUrl(kind, d.getUTCFullYear(), d.getUTCMonth() + 1);
      const gz = await download(url, f);
      if (!gz) continue;
      const mmdb = gunzipSync(gz, { maxOutputLength: MAX_MMDB_BYTES });
      const target = kind === 'country' ? p.dbipCountry : p.dbipAsn;
      await writeAtomic(target, mmdb);
      await setMeta(p, kind === 'country' ? 'dbip-country' : 'dbip-asn', {
        updatedAt: now.toISOString(),
        source: url,
      });
      results.push({
        id: kind === 'country' ? 'dbip-country' : 'dbip-asn',
        path: target,
        source: url,
        bytes: mmdb.length,
      });
      done = true;
    }
    if (!done)
      throw new Error(
        `DB-IP Lite (${kind}) ist nicht abrufbar (aktueller und letzte Monate nicht gefunden).`,
      );
  }
  return results;
}

export interface DatasetStatus {
  id: DatasetId;
  path: string;
  present: boolean;
  /** ISO timestamp of the last download (from metadata, else file mtime). */
  updatedAt?: string;
  ageDays?: number;
  source?: string;
}

export async function dataStatus(opts: DataOptions = {}): Promise<DatasetStatus[]> {
  const p = dataPaths(opts.dir ? { dir: opts.dir } : {});
  const meta = await readMeta(p);
  const now = (opts.now ?? new Date()).getTime();
  const entries: Array<[DatasetId, string]> = [
    ['easyprivacy', p.easyPrivacy],
    ['dbip-country', p.dbipCountry],
    ['dbip-asn', p.dbipAsn],
  ];
  const out: DatasetStatus[] = [];
  for (const [id, path] of entries) {
    try {
      const st = await stat(path);
      const updatedAt = meta[id]?.updatedAt ?? st.mtime.toISOString();
      const status: DatasetStatus = {
        id,
        path,
        present: true,
        updatedAt,
        ageDays: Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 86_400_000)),
      };
      const src = meta[id]?.source;
      if (src) status.source = src;
      out.push(status);
    } catch {
      out.push({ id, path, present: false });
    }
  }
  return out;
}

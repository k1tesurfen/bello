/** Evidence manifest (PLAN §10 "Beweissicherung"): SHA-256 of every evidence file. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScanMetadata } from '../types.js';

export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_REL = `evidence/${MANIFEST_FILE}`;

export interface EvidenceManifest {
  /** Fixed marker so the file is recognisable. */
  format: 'bello-evidence-manifest';
  version: 1;
  createdAt: string;
  /** Scan metadata at the time the evidence was complete. */
  metadata: ScanMetadata;
  /** Relative posix paths (to the report directory), sorted. */
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

export function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    let bytes = 0;
    const s = createReadStream(file);
    s.on('data', (c) => {
      h.update(c);
      bytes += c.length;
    });
    s.on('error', reject);
    s.on('end', () => resolve({ sha256: h.digest('hex'), bytes }));
  });
}

async function walk(dir: string, base: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, base, out);
    else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
}

/** All evidence files (relative posix paths, sorted), excluding the manifest itself. */
export async function listEvidenceFiles(reportDir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(path.join(reportDir, 'evidence'), reportDir, out);
  return out.filter((f) => f !== MANIFEST_REL).sort();
}

/**
 * Hashes every file under `<reportDir>/evidence/` and writes `evidence/manifest.json`.
 * Returns the SHA-256 (hex) of the manifest file itself.
 */
export async function writeManifest(reportDir: string, metadata: ScanMetadata): Promise<string> {
  const files: EvidenceManifest['files'] = [];
  for (const rel of await listEvidenceFiles(reportDir)) {
    const { sha256, bytes } = await sha256File(path.join(reportDir, rel));
    files.push({ path: rel, sha256, bytes });
  }
  const manifest: EvidenceManifest = {
    format: 'bello-evidence-manifest',
    version: 1,
    createdAt: new Date().toISOString(),
    metadata,
    files,
  };
  const text = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(path.join(reportDir, MANIFEST_REL), text, 'utf8');
  return createHash('sha256').update(text).digest('hex');
}

export interface ManifestVerification {
  ok: boolean;
  manifestSha256?: string;
  /** Files whose hash differs. */
  modified: string[];
  missing: string[];
  /** Evidence files not listed in the manifest. */
  added: string[];
  /** German problem descriptions (empty if ok). */
  problems: string[];
}

/** Re-hashes the evidence and compares with the manifest (and optionally the hash in the report). */
export async function verifyManifest(
  reportDir: string,
  expectedManifestSha256?: string,
): Promise<ManifestVerification> {
  const res: ManifestVerification = {
    ok: false,
    modified: [],
    missing: [],
    added: [],
    problems: [],
  };
  let text: string;
  try {
    text = await readFile(path.join(reportDir, MANIFEST_REL), 'utf8');
  } catch {
    res.problems.push('Manifest nicht gefunden: ' + MANIFEST_REL);
    return res;
  }
  res.manifestSha256 = createHash('sha256').update(text).digest('hex');
  if (expectedManifestSha256 && expectedManifestSha256 !== res.manifestSha256) {
    res.problems.push('Der Hash des Manifests stimmt nicht mit dem Hash im Report überein.');
  }
  let manifest: EvidenceManifest;
  try {
    manifest = JSON.parse(text) as EvidenceManifest;
    if (!Array.isArray(manifest.files)) throw new Error('files');
  } catch {
    res.problems.push('Manifest ist kein gültiges JSON.');
    return res;
  }
  const listed = new Set<string>();
  for (const f of manifest.files) {
    listed.add(f.path);
    try {
      const { sha256 } = await sha256File(path.join(reportDir, f.path));
      if (sha256 !== f.sha256) res.modified.push(f.path);
    } catch {
      res.missing.push(f.path);
    }
  }
  for (const f of await listEvidenceFiles(reportDir)) if (!listed.has(f)) res.added.push(f);
  for (const f of res.modified) res.problems.push(`Datei verändert: ${f}`);
  for (const f of res.missing) res.problems.push(`Datei fehlt: ${f}`);
  for (const f of res.added) res.problems.push(`Datei nicht im Manifest: ${f}`);
  res.ok = res.problems.length === 0;
  return res;
}

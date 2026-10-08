import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyManifest, writeManifest } from '../../src/report/manifest.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'bello-man-'));
  await mkdir(path.join(dir, 'evidence/A'), { recursive: true });
  await writeFile(path.join(dir, 'evidence/A/b.txt'), 'bbb');
  await writeFile(path.join(dir, 'evidence/a.txt'), 'aaa');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const meta = {
  startedAt: '2026-01-01T00:00:00.000Z',
  belloVersion: '0',
  commandLine: [],
  crawl: false,
};

describe('manifest', () => {
  it('hashes sorted files and verifies', async () => {
    const h = await writeManifest(dir, meta);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const m = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(path.join(dir, 'evidence/manifest.json'), 'utf8'),
    );
    expect(m.files.map((f: { path: string }) => f.path)).toEqual([
      'evidence/A/b.txt',
      'evidence/a.txt',
    ]);
    expect(m.files[1].sha256).toBe(
      '9834876dcfb05cb167a5c24953eba58c4ac89b1adf57f28f2f9d09af107ee8f0',
    );
    expect((await verifyManifest(dir, h)).ok).toBe(true);
  });
  it('detects modified, missing, added files and wrong report hash', async () => {
    const h = await writeManifest(dir, meta);
    await writeFile(path.join(dir, 'evidence/a.txt'), 'x');
    await rm(path.join(dir, 'evidence/A/b.txt'));
    await writeFile(path.join(dir, 'evidence/new.txt'), 'n');
    const v = await verifyManifest(dir, 'f'.repeat(64));
    expect(v.ok).toBe(false);
    expect(v.modified).toEqual(['evidence/a.txt']);
    expect(v.missing).toEqual(['evidence/A/b.txt']);
    expect(v.added).toEqual(['evidence/new.txt']);
    expect(v.problems.length).toBe(4);
    expect(h).not.toBe(v.manifestSha256 && 'x');
  });
});

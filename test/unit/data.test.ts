import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataStatus, dbipUrl, updateDbIp, updateEasyPrivacy } from '../../src/data/index.js';
import { cacheDir, dataPaths } from '../../src/platform/paths.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bello-data-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('paths', () => {
  it('follows XDG / macOS conventions', () => {
    expect(cacheDir({ env: {}, platform: 'linux', home: '/home/u' })).toBe('/home/u/.cache/bello');
    expect(
      cacheDir({ env: { XDG_CACHE_HOME: '/x/cache' }, platform: 'linux', home: '/home/u' }),
    ).toBe('/x/cache/bello');
    expect(cacheDir({ env: {}, platform: 'darwin', home: '/Users/u' })).toBe(
      '/Users/u/Library/Caches/bello',
    );
    expect(dataPaths({ dir: '/c' }).easyPrivacy).toBe('/c/easyprivacy.txt');
  });
});

function fakeFetch(files: Record<string, Buffer | string>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const body = files[String(url)];
    if (body === undefined) return new Response('nope', { status: 404 });
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 });
  }) as typeof fetch;
}

describe('data update', () => {
  it('downloads EasyPrivacy and records status', async () => {
    const f = fakeFetch({ 'https://easylist.to/easylist/easyprivacy.txt': '||t.example^\n' });
    await updateEasyPrivacy({ dir, fetchImpl: f });
    expect(await readFile(join(dir, 'easyprivacy.txt'), 'utf8')).toContain('||t.example^');
    const st = await dataStatus({ dir });
    expect(st.find((s) => s.id === 'easyprivacy')).toMatchObject({ present: true, ageDays: 0 });
    expect(st.find((s) => s.id === 'dbip-asn')?.present).toBe(false);
  });

  it('DB-IP falls back to the previous month', async () => {
    const mmdb = Buffer.from('fake-mmdb');
    const gz = gzipSync(mmdb);
    const f = fakeFetch({
      [dbipUrl('country', 2026, 9)]: gz,
      [dbipUrl('asn', 2026, 9)]: gz,
    });
    const res = await updateDbIp({ dir, fetchImpl: f, now: new Date(Date.UTC(2026, 9, 2)) });
    expect(res.map((r) => r.source)).toEqual([
      dbipUrl('country', 2026, 9),
      dbipUrl('asn', 2026, 9),
    ]);
    expect((await readFile(join(dir, 'dbip-country.mmdb'))).toString()).toBe('fake-mmdb');
  });

  it('DB-IP fails with a German message if nothing is published', async () => {
    await expect(updateDbIp({ dir, fetchImpl: fakeFetch({}) })).rejects.toThrow(/nicht abrufbar/);
  });

  it('dataStatus reports absent files', async () => {
    await writeFile(join(dir, 'dbip-country.mmdb'), 'x');
    const st = await dataStatus({ dir });
    expect(st.map((s) => s.present)).toEqual([false, true, false]);
  });
});

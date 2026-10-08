import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  bodyToText,
  discoverPages,
  extractCanonical,
  extractLinks,
  isSameSite,
  normalizePageUrl,
  parseRobotsSitemaps,
  parseSitemap,
} from '../../src/crawl/index.js';

describe('normalizePageUrl', () => {
  it('entfernt Fragment, Tracking-Parameter und Default-Port, sortiert Query, Host klein', () => {
    expect(
      normalizePageUrl(
        'HTTP://WWW.Example.DE:80/a?b=2&utm_source=x&a=1&gclid=7&fbclid=1&mc_eid=9#top',
      ),
    ).toBe('http://www.example.de/a?a=1&b=2');
    expect(normalizePageUrl('https://example.de:443')).toBe('https://example.de/');
  });
  it('löst relative URLs auf und verwirft Nicht-HTML und fremde Schemata', () => {
    expect(normalizePageUrl('../x', 'https://example.de/a/b/c.html')).toBe(
      'https://example.de/a/x',
    );
    for (const u of [
      '/a.pdf',
      '/b.JPG',
      '/c.zip',
      'mailto:a@b.de',
      'tel:123',
      'javascript:void(0)',
    ])
      expect(normalizePageUrl(u, 'https://example.de/')).toBeNull();
  });
  it('isSameSite nutzt die registrierbare Domain', () => {
    expect(isSameSite('https://www.example.co.uk/', 'https://shop.example.co.uk/x')).toBe(true);
    expect(isSameSite('https://example.de/', 'https://example.com/')).toBe(false);
    expect(isSameSite('http://127.0.0.1:1/', 'http://127.0.0.1:2/')).toBe(true);
  });
});

describe('sitemap parsing', () => {
  it('urlset und index', () => {
    const u = parseSitemap(
      '<urlset><url><loc>https://e.de/a?x=1&amp;y=2</loc></url><url><loc> https://e.de/b </loc></url></urlset>',
    );
    expect(u).toEqual({ kind: 'urlset', locs: ['https://e.de/a?x=1&y=2', 'https://e.de/b'] });
    const i = parseSitemap(
      '<sitemapindex><sitemap><loc><![CDATA[https://e.de/s1.xml]]></loc></sitemap></sitemapindex>',
    );
    expect(i).toEqual({ kind: 'index', locs: ['https://e.de/s1.xml'] });
  });
  it('gzip', () => {
    const xml = '<urlset><url><loc>https://e.de/z</loc></url></urlset>';
    expect(parseSitemap(bodyToText(gzipSync(xml))).locs).toEqual(['https://e.de/z']);
    expect(bodyToText(Buffer.from('plain'))).toBe('plain');
  });
  it('robots.txt Sitemap-Zeilen', () => {
    const robots =
      'User-agent: *\nDisallow: /x\nsitemap: https://e.de/s.xml\nSITEMAP:https://e.de/t.xml.gz\nSitemap: /rel.xml\n';
    expect(parseRobotsSitemaps(robots)).toEqual(['https://e.de/s.xml', 'https://e.de/t.xml.gz']);
  });
});

describe('HTML', () => {
  it('Links und Canonical', () => {
    const html = `<a href="/a">A</a> <a class=x href='b.html?x=1&amp;y=2'>B</a><a name="n">x</a>
      <link rel="canonical" href="https://e.de/kanon">`;
    expect(extractLinks(html)).toEqual(['/a', 'b.html?x=1&y=2']);
    expect(extractCanonical(html)).toBe('https://e.de/kanon');
    expect(extractCanonical('<link rel="stylesheet" href="x.css">')).toBeNull();
  });
});

function fakeFetch(files: Record<string, { body: string | Buffer; type?: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const f = files[url];
    if (!f) return new Response('nicht gefunden', { status: 404 });
    return new Response(f.body, { headers: { 'content-type': f.type ?? 'text/html' } });
  }) as typeof fetch;
}

describe('discoverPages', () => {
  it('Sitemap-Index (robots + gzip), nur Same-Site, Start zuerst, maxPages', async () => {
    const fetchImpl = fakeFetch({
      'https://www.e.de/robots.txt': {
        body: 'Sitemap: https://www.e.de/index.xml',
        type: 'text/plain',
      },
      'https://www.e.de/index.xml': {
        body: '<sitemapindex><sitemap><loc>https://www.e.de/p1.xml.gz</loc></sitemap></sitemapindex>',
      },
      'https://www.e.de/p1.xml.gz': {
        body: gzipSync(
          '<urlset><url><loc>https://www.e.de/b</loc></url><url><loc>https://fremd.com/x</loc></url><url><loc>https://www.e.de/</loc></url><url><loc>https://www.e.de/c</loc></url><url><loc>https://www.e.de/d.pdf</loc></url></urlset>',
        ),
        type: 'application/gzip',
      },
    });
    const r = await discoverPages('https://www.e.de/', { maxPages: 10, fetchImpl, delayMs: 0 });
    expect(r.source).toBe('sitemap');
    expect(r.pages).toEqual(['https://www.e.de/', 'https://www.e.de/b', 'https://www.e.de/c']);
    const limited = await discoverPages('https://www.e.de/', {
      maxPages: 2,
      fetchImpl,
      delayMs: 0,
    });
    expect(limited.pages).toEqual(['https://www.e.de/', 'https://www.e.de/b']);
  });
  it('Fallback Link-Crawl (BFS, Same-Site, dedupe, Canonical)', async () => {
    const fetchImpl = fakeFetch({
      'https://e.de/': {
        body: '<a href="/a?utm_x=1">a</a><a href="/a#x">a2</a><a href="https://shop.e.de/s">s</a><a href="https://fremd.com/">f</a><a href="/f.pdf">p</a>',
      },
      'https://e.de/a': {
        body: '<link rel="canonical" href="/a-kanonisch"><a href="/b">b</a>',
      },
      'https://shop.e.de/s': { body: '<a href="/">home</a>' },
      'https://e.de/b': { body: 'x', type: 'application/json' },
    });
    const r = await discoverPages('https://e.de/', { maxPages: 20, fetchImpl, delayMs: 0 });
    expect(r.source).toBe('links');
    expect(r.pages).toEqual([
      'https://e.de/',
      'https://e.de/a-kanonisch',
      'https://shop.e.de/s',
      'https://e.de/b',
      'https://shop.e.de/',
    ]);
  });
  it('liefert bei totalem Fetch-Fehler nur die Start-URL', async () => {
    const r = await discoverPages('https://e.de/', {
      maxPages: 5,
      delayMs: 0,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    expect(r.pages).toEqual(['https://e.de/']);
  });
});

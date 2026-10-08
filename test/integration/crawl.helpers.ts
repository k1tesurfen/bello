import http from 'node:http';
import type { FixtureServer } from '../fixtures/server.js';

/** fetch replacement that resolves the fake fixture hosts to the local fixture server. */
export function fixtureFetch(server: FixtureServer): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const headers: Record<string, string> = { host: u.host };
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    return await new Promise<Response>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: server.port, path: u.pathname + u.search, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers))
              if (typeof v === 'string') h.set(k, v);
            resolve(
              new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: h }),
            );
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }) as typeof fetch;
}

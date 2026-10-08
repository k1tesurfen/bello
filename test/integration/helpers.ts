import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isChromeInternalHost, launchScenarioBrowser } from '../../src/browser/launch.js';
import { correlate } from '../../src/capture/cdp/correlate.js';
import { startRequestCapture } from '../../src/capture/cdp/requests.js';
import { hostConnectionsFromFile } from '../../src/capture/netlog/aggregate.js';
import type { HostConnection, RequestRecord } from '../../src/types.js';
import type { FixtureServer } from '../fixtures/server.js';

export interface FixtureRun {
  navigationStart: number;
  connections: HostConnection[];
  requests: RequestRecord[];
  netLogPath: string;
  dir: string;
  cleanup(): Promise<void>;
}

/** Loads `url` in a fresh browser with NetLog + CDP capture, closes it and correlates the result. */
export async function runFixturePage(
  server: FixtureServer,
  url: string,
  opts: { settleMs?: number } = {},
): Promise<FixtureRun> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bello-test-'));
  const netLogPath = path.join(dir, 'netlog.json');
  const sb = await launchScenarioBrowser({
    netLogPath,
    harPath: path.join(dir, 'network.har'),
    extraArgs: server.chromiumArgs(),
  });
  const capture = async (): Promise<{ requests: RequestRecord[]; navigationStart: number }> => {
    try {
      const cdp = await startRequestCapture(sb.cdpEndpoint!);
      const page = await sb.context.newPage();
      const navigationStart = Date.now();
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForTimeout(opts.settleMs ?? 500);
      const requests = cdp.records(navigationStart);
      await cdp.stop();
      return { requests, navigationStart };
    } finally {
      // Closing the browser finalises the NetLog file.
      await sb.close();
    }
  };
  const { requests, navigationStart } = await capture();
  const { connections } = await hostConnectionsFromFile(netLogPath, navigationStart, {
    ignoreHost: isChromeInternalHost,
  });
  correlate(connections, requests);
  return {
    navigationStart,
    connections,
    requests,
    netLogPath,
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

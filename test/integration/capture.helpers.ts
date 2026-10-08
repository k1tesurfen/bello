import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchScenarioBrowser, type ScenarioBrowser } from '../../src/browser/launch.js';
import type { FixtureServer } from '../fixtures/server.js';

export async function openBrowser(
  server: FixtureServer,
): Promise<{ sb: ScenarioBrowser; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bello-cap-'));
  const sb = await launchScenarioBrowser({
    netLogPath: path.join(dir, 'netlog.json'),
    extraArgs: server.chromiumArgs(),
  });
  return {
    sb,
    cleanup: async () => {
      await sb.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

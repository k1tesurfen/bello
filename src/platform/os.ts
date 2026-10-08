import { readFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';

export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'zypper' | 'unknown';

export interface OsRelease {
  id?: string;
  idLike: string[];
  versionId?: string;
  prettyName?: string;
}

export interface OsInfo {
  platform: NodeJS.Platform;
  arch: string;
  /** Linux only. */
  distro?: OsRelease;
  packageManager: PackageManager;
  /** Human-readable summary, e.g. `Debian GNU/Linux 13 (trixie)`. */
  label: string;
}

/** Parse the content of /etc/os-release (shell-like KEY=value, optionally quoted). */
export function parseOsRelease(text: string): OsRelease {
  const kv = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    }
    kv.set(line.slice(0, eq), val);
  }
  const out: OsRelease = {
    idLike: (kv.get('ID_LIKE') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
  };
  const id = kv.get('ID');
  if (id) out.id = id.toLowerCase();
  const v = kv.get('VERSION_ID');
  if (v) out.versionId = v;
  const pn = kv.get('PRETTY_NAME');
  if (pn) out.prettyName = pn;
  return out;
}

const APT_IDS = new Set(['debian', 'ubuntu', 'linuxmint', 'pop', 'raspbian', 'kali', 'neon']);
const DNF_IDS = new Set(['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'ol', 'amzn']);
const PACMAN_IDS = new Set(['arch', 'manjaro', 'endeavouros', 'cachyos', 'garuda']);
const ZYPPER_IDS = new Set(['opensuse', 'opensuse-leap', 'opensuse-tumbleweed', 'sles', 'suse']);

/** Map a distro (ID + ID_LIKE) to its package manager family. */
export function packageManagerFor(rel: OsRelease | undefined): PackageManager {
  if (!rel) return 'unknown';
  const ids = [rel.id, ...rel.idLike].filter((s): s is string => !!s);
  for (const id of ids) {
    if (APT_IDS.has(id)) return 'apt';
    if (PACMAN_IDS.has(id)) return 'pacman';
    if (ZYPPER_IDS.has(id) || id.startsWith('opensuse') || id.startsWith('suse')) return 'zypper';
    if (DNF_IDS.has(id)) return 'dnf';
  }
  return 'unknown';
}

export interface DetectOsOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Override for tests: content of os-release (or `null` if the file is missing). */
  osReleaseText?: string | null;
}

export async function detectOs(opts: DetectOsOptions = {}): Promise<OsInfo> {
  const plat = opts.platform ?? platform();
  const ar = opts.arch ?? arch();
  if (plat !== 'linux') {
    const names: Partial<Record<NodeJS.Platform, string>> = {
      darwin: 'macOS',
      win32: 'Windows',
    };
    return { platform: plat, arch: ar, packageManager: 'unknown', label: names[plat] ?? plat };
  }
  let text: string | null | undefined = opts.osReleaseText;
  if (text === undefined) {
    for (const f of ['/etc/os-release', '/usr/lib/os-release']) {
      try {
        text = await readFile(f, 'utf8');
        break;
      } catch {
        text = null;
      }
    }
  }
  const info: OsInfo = { platform: plat, arch: ar, packageManager: 'unknown', label: 'Linux' };
  if (text) {
    const distro = parseOsRelease(text);
    info.distro = distro;
    info.packageManager = packageManagerFor(distro);
    info.label = distro.prettyName ?? `${distro.id ?? 'Linux'} ${distro.versionId ?? ''}`.trim();
  }
  return info;
}

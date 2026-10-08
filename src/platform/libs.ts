import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { OsRelease, PackageManager } from './os.js';

/** Path where Playwright expects its Chromium binary (it may not exist yet). */
export function chromiumExecutablePath(): string {
  return chromium.executablePath();
}

export async function chromiumInstalled(path = chromiumExecutablePath()): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Parse `ldd` output and return the sonames reported as "not found". */
export function parseLddMissing(output: string): string[] {
  const missing = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+=>\s+not found\s*$/.exec(line);
    if (m?.[1]) missing.add(m[1]);
  }
  return [...missing];
}

/**
 * Run `ldd` on a binary (Linux only; the one subprocess Bello allows itself).
 * Returns `undefined` if ldd is unavailable or not applicable.
 */
export function runLdd(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('ldd', [binary], { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 }, (err, stdout) => {
      // ldd exits non-zero for static/non-ELF binaries; stdout is still useful when present.
      if (err && !stdout) resolve(undefined);
      else resolve(stdout);
    });
  });
}

/** Soname prefix (without version) -> package per family. Covers Playwright's Chromium deps. */
interface LibPackages {
  apt: string;
  dnf: string;
  pacman: string;
  zypper: string;
}

const T = (apt: string, dnf: string, pacman: string, zypper: string): LibPackages => ({
  apt,
  dnf,
  pacman,
  zypper,
});

export const LIB_PACKAGES: Record<string, LibPackages> = {
  'libnss3.so': T('libnss3', 'nss', 'nss', 'mozilla-nss'),
  'libnssutil3.so': T('libnss3', 'nss', 'nss', 'mozilla-nss'),
  'libsmime3.so': T('libnss3', 'nss', 'nss', 'mozilla-nss'),
  'libnspr4.so': T('libnspr4', 'nspr', 'nspr', 'mozilla-nspr'),
  'libplc4.so': T('libnspr4', 'nspr', 'nspr', 'mozilla-nspr'),
  'libplds4.so': T('libnspr4', 'nspr', 'nspr', 'mozilla-nspr'),
  'libatk-1.0.so': T('libatk1.0-0', 'atk', 'at-spi2-core', 'libatk-1_0-0'),
  'libatk-bridge-2.0.so': T(
    'libatk-bridge2.0-0',
    'at-spi2-atk',
    'at-spi2-core',
    'libatk-bridge-2_0-0',
  ),
  'libatspi.so': T('libatspi2.0-0', 'at-spi2-core', 'at-spi2-core', 'libatspi0'),
  'libcups.so': T('libcups2', 'cups-libs', 'libcups', 'libcups2'),
  'libdrm.so': T('libdrm2', 'libdrm', 'libdrm', 'libdrm2'),
  'libgbm.so': T('libgbm1', 'mesa-libgbm', 'mesa', 'libgbm1'),
  'libxkbcommon.so': T('libxkbcommon0', 'libxkbcommon', 'libxkbcommon', 'libxkbcommon0'),
  'libX11.so': T('libx11-6', 'libX11', 'libx11', 'libX11-6'),
  'libX11-xcb.so': T('libx11-6', 'libX11', 'libx11', 'libX11-xcb1'),
  'libxcb.so': T('libxcb1', 'libxcb', 'libxcb', 'libxcb1'),
  'libXcomposite.so': T('libxcomposite1', 'libXcomposite', 'libxcomposite', 'libXcomposite1'),
  'libXdamage.so': T('libxdamage1', 'libXdamage', 'libxdamage', 'libXdamage1'),
  'libXext.so': T('libxext6', 'libXext', 'libxext', 'libXext6'),
  'libXfixes.so': T('libxfixes3', 'libXfixes', 'libxfixes', 'libXfixes3'),
  'libXrandr.so': T('libxrandr2', 'libXrandr', 'libxrandr', 'libXrandr2'),
  'libXrender.so': T('libxrender1', 'libXrender', 'libxrender', 'libXrender1'),
  'libXi.so': T('libxi6', 'libXi', 'libxi', 'libXi6'),
  'libXtst.so': T('libxtst6', 'libXtst', 'libxtst', 'libXtst6'),
  'libpango-1.0.so': T('libpango-1.0-0', 'pango', 'pango', 'libpango-1_0-0'),
  'libpangocairo-1.0.so': T('libpango-1.0-0', 'pango', 'pango', 'libpangocairo-1_0-0'),
  'libcairo.so': T('libcairo2', 'cairo', 'cairo', 'libcairo2'),
  'libasound.so': T('libasound2', 'alsa-lib', 'alsa-lib', 'libasound2'),
  'libglib-2.0.so': T('libglib2.0-0', 'glib2', 'glib2', 'libglib-2_0-0'),
  'libgio-2.0.so': T('libglib2.0-0', 'glib2', 'glib2', 'libgio-2_0-0'),
  'libgobject-2.0.so': T('libglib2.0-0', 'glib2', 'glib2', 'libgobject-2_0-0'),
  'libgmodule-2.0.so': T('libglib2.0-0', 'glib2', 'glib2', 'libgmodule-2_0-0'),
  'libdbus-1.so': T('libdbus-1-3', 'dbus-libs', 'dbus', 'libdbus-1-3'),
  'libexpat.so': T('libexpat1', 'expat', 'expat', 'libexpat1'),
  'libfontconfig.so': T('libfontconfig1', 'fontconfig', 'fontconfig', 'libfontconfig1'),
  'libfreetype.so': T('libfreetype6', 'freetype', 'freetype2', 'libfreetype6'),
  'libgtk-3.so': T('libgtk-3-0', 'gtk3', 'gtk3', 'libgtk-3-0'),
  'libgdk-3.so': T('libgtk-3-0', 'gtk3', 'gtk3', 'libgtk-3-0'),
  'libxshmfence.so': T('libxshmfence1', 'libxshmfence', 'libxshmfence', 'libxshmfence1'),
  'libEGL.so': T('libegl1', 'libglvnd-egl', 'libglvnd', 'libEGL1'),
  'libGL.so': T('libgl1', 'libglvnd-glx', 'libglvnd', 'libGL1'),
  'libGLESv2.so': T('libgles2', 'libglvnd-gles', 'libglvnd', 'libGLESv2-2'),
  'libwayland-client.so': T(
    'libwayland-client0',
    'libwayland-client',
    'wayland',
    'libwayland-client0',
  ),
  'libudev.so': T('libudev1', 'systemd-libs', 'systemd-libs', 'libudev1'),
};

/** Packages that provide fonts; not covered by ldd, but needed for sane screenshots. */
export const FONT_PACKAGES: Record<PackageManager, string[]> = {
  apt: ['fonts-liberation'],
  dnf: ['liberation-fonts'],
  pacman: ['ttf-liberation'],
  zypper: ['liberation-fonts'],
  unknown: [],
};

/** Strip the version suffix from a soname: `libnss3.so.1` -> `libnss3.so`. */
export function sonameBase(soname: string): string {
  const i = soname.indexOf('.so');
  return i < 0 ? soname : soname.slice(0, i + 3);
}

export interface PackageMapping {
  packages: string[];
  /** Sonames without an entry in the table. */
  unmapped: string[];
}

/** Debian package names that carry a `t64` suffix since the 64-bit time_t transition. */
const T64_APT = new Set([
  'libatk1.0-0',
  'libatk-bridge2.0-0',
  'libatspi2.0-0',
  'libcups2',
  'libasound2',
  'libglib2.0-0',
  'libgtk-3-0',
]);

/** Debian >= 13 and Ubuntu >= 24.04 use the t64 names; older releases the plain ones. */
export function usesT64Names(distro: OsRelease | undefined): boolean {
  if (!distro) return true;
  const ver = Number.parseFloat(distro.versionId ?? '');
  if (!Number.isFinite(ver)) return true;
  const ids = [distro.id, ...distro.idLike];
  if (distro.id === 'debian') return ver >= 13;
  if (distro.id === 'ubuntu') return ver >= 24.04;
  // Ubuntu derivatives with Ubuntu-style versions (e.g. Pop!_OS 22.04).
  if (ids.includes('ubuntu') && /^\d\d\.\d\d$/.test(distro.versionId ?? '')) return ver >= 24.04;
  if (ids.includes('debian') && distro.id !== 'ubuntu' && !ids.includes('ubuntu')) return ver >= 13;
  return true;
}

export function mapLibsToPackages(
  sonames: string[],
  family: PackageManager,
  distro?: OsRelease,
): PackageMapping {
  const t64 = family === 'apt' && usesT64Names(distro);
  const packages = new Set<string>();
  const unmapped: string[] = [];
  for (const s of sonames) {
    const entry = LIB_PACKAGES[sonameBase(s)];
    if (!entry || family === 'unknown') unmapped.push(s);
    else {
      const pkg = entry[family];
      packages.add(t64 && T64_APT.has(pkg) ? `${pkg}t64` : pkg);
    }
  }
  return { packages: [...packages].sort(), unmapped };
}

/** Exact install command Bello prints (it never runs it). */
export function buildInstallCommand(
  family: PackageManager,
  packages: string[],
): string | undefined {
  if (packages.length === 0 || family === 'unknown') return undefined;
  const list = packages.join(' ');
  switch (family) {
    case 'apt':
      return `sudo apt-get install -y ${list}`;
    case 'dnf':
      return `sudo dnf install -y ${list}`;
    case 'pacman':
      return `sudo pacman -S --needed --noconfirm ${list}`;
    case 'zypper':
      return `sudo zypper install -y ${list}`;
  }
}

export interface LibCheckResult {
  /** `false` when not applicable (non-Linux) or the binary is missing/ldd unavailable. */
  checked: boolean;
  reason?: 'not-linux' | 'no-binary' | 'no-ldd';
  missing: string[];
  packages: string[];
  unmapped: string[];
  installCommand?: string;
}

export interface CheckLibsOptions {
  family: PackageManager;
  /** os-release data; selects `t64` vs. plain Debian/Ubuntu package names. */
  distro?: OsRelease;
  platform?: NodeJS.Platform;
  binary?: string;
  /** Test hook replacing the ldd call. */
  lddRunner?: (binary: string) => Promise<string | undefined>;
}

export async function checkSystemLibs(opts: CheckLibsOptions): Promise<LibCheckResult> {
  const empty = { missing: [], packages: [], unmapped: [] };
  if ((opts.platform ?? process.platform) !== 'linux')
    return { checked: false, reason: 'not-linux', ...empty };
  const binary = opts.binary ?? chromiumExecutablePath();
  if (!(await chromiumInstalled(binary))) return { checked: false, reason: 'no-binary', ...empty };
  const out = await (opts.lddRunner ?? runLdd)(binary);
  if (out === undefined) return { checked: false, reason: 'no-ldd', ...empty };
  const missing = parseLddMissing(out);
  const { packages, unmapped } = mapLibsToPackages(missing, opts.family, opts.distro);
  const result: LibCheckResult = { checked: true, missing, packages, unmapped };
  const cmd = buildInstallCommand(opts.family, [
    ...packages,
    ...(packages.length ? FONT_PACKAGES[opts.family] : []),
  ]);
  if (cmd) result.installCommand = cmd;
  return result;
}

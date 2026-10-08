import type { OsRelease } from '../../src/platform/os.js';
import { describe, expect, it } from 'vitest';
import {
  buildInstallCommand,
  checkSystemLibs,
  detectOs,
  mapLibsToPackages,
  packageManagerFor,
  parseLddMissing,
  parseOsRelease,
  translateStartupError,
} from '../../src/platform/index.js';

const DEBIAN = `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
ID=debian
HOME_URL="https://www.debian.org/"
`;
const UBUNTU = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
ID_LIKE=debian
`;
const FEDORA = `NAME="Fedora Linux"
VERSION_ID=42
ID=fedora
PRETTY_NAME="Fedora Linux 42 (Container Image)"
`;
const ARCH = `NAME="Arch Linux"
PRETTY_NAME="Arch Linux"
ID=arch
BUILD_ID=rolling
`;
const OPENSUSE = `NAME="openSUSE Tumbleweed"
ID="opensuse-tumbleweed"
ID_LIKE="opensuse suse"
VERSION_ID="20260101"
PRETTY_NAME="openSUSE Tumbleweed"
`;
const MINT = `ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_ID="22"\n`;

describe('os-release parsing', () => {
  it.each([
    ['debian', DEBIAN, 'debian', '13', 'apt'],
    ['ubuntu', UBUNTU, 'ubuntu', '24.04', 'apt'],
    ['fedora', FEDORA, 'fedora', '42', 'dnf'],
    ['arch', ARCH, 'arch', undefined, 'pacman'],
    ['opensuse', OPENSUSE, 'opensuse-tumbleweed', '20260101', 'zypper'],
    ['mint', MINT, 'linuxmint', '22', 'apt'],
  ] as const)('%s', (_n, text, id, version, pm) => {
    const rel = parseOsRelease(text);
    expect(rel.id).toBe(id);
    expect(rel.versionId).toBe(version);
    expect(packageManagerFor(rel)).toBe(pm);
  });

  it('parses ID_LIKE and unknown distros', () => {
    expect(parseOsRelease(OPENSUSE).idLike).toEqual(['opensuse', 'suse']);
    expect(packageManagerFor(parseOsRelease('ID=gentoo\n'))).toBe('unknown');
    expect(packageManagerFor(undefined)).toBe('unknown');
  });

  it('detectOs uses the injected os-release and handles macOS', async () => {
    const linux = await detectOs({ platform: 'linux', arch: 'x64', osReleaseText: FEDORA });
    expect(linux.packageManager).toBe('dnf');
    expect(linux.label).toContain('Fedora');
    const mac = await detectOs({ platform: 'darwin', arch: 'arm64' });
    expect(mac.label).toBe('macOS');
    expect(mac.packageManager).toBe('unknown');
    const none = await detectOs({ platform: 'linux', arch: 'x64', osReleaseText: null });
    expect(none.packageManager).toBe('unknown');
  });
});

const LDD = `	linux-vdso.so.1 (0x00007ffd)
	libdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x00007f)
	libnss3.so => not found
	libnssutil3.so => not found
	libnspr4.so => not found
	libgbm.so.1 => not found
	libnss3.so => not found
	libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)
`;

describe('ldd parsing and package mapping', () => {
  it('lists unique missing libraries', () => {
    expect(parseLddMissing(LDD)).toEqual([
      'libnss3.so',
      'libnssutil3.so',
      'libnspr4.so',
      'libgbm.so.1',
    ]);
    expect(parseLddMissing('')).toEqual([]);
  });

  it('maps to packages per family', () => {
    const libs = ['libnss3.so', 'libnspr4.so', 'libgbm.so.1', 'libasound.so.2', 'libweird.so.9'];
    expect(mapLibsToPackages(libs, 'apt')).toEqual({
      packages: ['libasound2t64', 'libgbm1', 'libnspr4', 'libnss3'],
      unmapped: ['libweird.so.9'],
    });
    expect(mapLibsToPackages(libs, 'dnf').packages).toEqual([
      'alsa-lib',
      'mesa-libgbm',
      'nspr',
      'nss',
    ]);
    expect(mapLibsToPackages(libs, 'pacman').packages).toEqual(['alsa-lib', 'mesa', 'nspr', 'nss']);
    expect(mapLibsToPackages(libs, 'zypper').packages).toContain('mozilla-nss');
    expect(mapLibsToPackages(['libnss3.so'], 'unknown').unmapped).toEqual(['libnss3.so']);
  });

  it('picks t64 or plain Debian/Ubuntu names by release', () => {
    const libs = ['libasound.so.2', 'libgtk-3.so.0'];
    const rel = (id: string, v: string): OsRelease => ({ id, idLike: [], versionId: v });
    expect(mapLibsToPackages(libs, 'apt', rel('debian', '12')).packages).toEqual([
      'libasound2',
      'libgtk-3-0',
    ]);
    expect(mapLibsToPackages(libs, 'apt', rel('ubuntu', '22.04')).packages).toEqual([
      'libasound2',
      'libgtk-3-0',
    ]);
    expect(mapLibsToPackages(libs, 'apt', rel('debian', '13')).packages).toEqual([
      'libasound2t64',
      'libgtk-3-0t64',
    ]);
    expect(mapLibsToPackages(libs, 'apt', rel('ubuntu', '24.04')).packages).toEqual([
      'libasound2t64',
      'libgtk-3-0t64',
    ]);
  });

  it('builds exact install commands', () => {
    expect(buildInstallCommand('apt', ['libnss3', 'libnspr4'])).toBe(
      'sudo apt-get install -y libnss3 libnspr4',
    );
    expect(buildInstallCommand('dnf', ['nss'])).toBe('sudo dnf install -y nss');
    expect(buildInstallCommand('pacman', ['nss'])).toBe('sudo pacman -S --needed --noconfirm nss');
    expect(buildInstallCommand('zypper', ['mozilla-nss'])).toBe(
      'sudo zypper install -y mozilla-nss',
    );
    expect(buildInstallCommand('apt', [])).toBeUndefined();
    expect(buildInstallCommand('unknown', ['x'])).toBeUndefined();
  });

  it('checkSystemLibs combines ldd output, mapping and command', async () => {
    const r = await checkSystemLibs({
      family: 'apt',
      platform: 'linux',
      binary: process.execPath,
      lddRunner: async () => LDD,
    });
    expect(r.checked).toBe(true);
    expect(r.installCommand).toBe(
      'sudo apt-get install -y libgbm1 libnspr4 libnss3 fonts-liberation',
    );
    const mac = await checkSystemLibs({ family: 'unknown', platform: 'darwin' });
    expect(mac).toMatchObject({ checked: false, reason: 'not-linux' });
  });
});

describe('translateStartupError', () => {
  it('missing shared library', () => {
    const msg = translateStartupError(
      new Error(
        'browserType.launch: Target page, context or browser has been closed\n/chrome: error while loading shared libraries: libnss3.so: cannot open shared object file',
      ),
    );
    expect(msg).toContain('libnss3.so');
    expect(msg).toContain('bello doctor');
  });

  it('chromium not installed', () => {
    const msg = translateStartupError(
      new Error("browserType.launch: Executable doesn't exist at /x/chrome"),
    );
    expect(msg).toContain('bello setup');
    expect(msg).toContain('bello doctor');
  });

  it('sandbox problems', () => {
    const msg = translateStartupError(
      new Error(
        'Failed to move to new namespace: PID namespaces supported, Network namespace supported',
      ),
    );
    expect(msg).toContain('Sandbox');
    expect(
      translateStartupError('Running as root without --no-sandbox is not supported'),
    ).toContain('Sandbox');
  });

  it('missing data files', () => {
    const msg = translateStartupError(
      new Error("ENOENT: no such file or directory, open '/home/u/.cache/bello/easyprivacy.txt'"),
    );
    expect(msg).toContain('bello setup');
  });

  it('returns undefined for unrelated errors', () => {
    expect(translateStartupError(new Error('boom'))).toBeUndefined();
    expect(translateStartupError(undefined)).toBeUndefined();
  });
});

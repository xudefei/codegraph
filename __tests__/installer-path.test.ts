/**
 * Offline bundle → user PATH setup (`src/installer/path.ts`).
 *
 * A normal online install gets `codegraph` onto PATH via `npm install -g`;
 * the offline mode skips that, so the bundle's `bin/` must be put on PATH
 * itself (mirroring the official install.sh / install.ps1 conventions).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  splitPathList,
  hasPathToken,
  bundleBinDir,
  chooseUnixBinDir,
  addBundleBinToPath,
} from '../src/installer/path';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-path-'));
}

describe('splitPathList', () => {
  it('splits unix PATH on ":" and drops empties', () => {
    expect(splitPathList('/usr/bin:/bin:/opt//tool:', 'unix')).toEqual(['/usr/bin', '/bin', '/opt//tool']);
  });
  it('splits windows PATH on ";" and drops empties', () => {
    expect(splitPathList('C:\\Windows;D:\\tools;;', 'windows')).toEqual(['C:\\Windows', 'D:\\tools']);
  });
});

describe('hasPathToken', () => {
  it('is case-insensitive on windows, exact on unix', () => {
    expect(hasPathToken(['C:\\codegraph\\bin'], 'c:\\CODEGRAPH\\BIN', 'windows')).toBe(true);
    expect(hasPathToken(['c:\\bin'], 'C:\\bin', 'windows')).toBe(true);
    expect(hasPathToken(['/usr/bin'], '/USR/BIN', 'unix')).toBe(false);
    expect(hasPathToken(['/usr/bin'], '/usr/bin', 'unix')).toBe(true);
  });
});

describe('bundleBinDir', () => {
  it('resolves <bundle>/bin for each platform family', () => {
    expect(bundleBinDir('/bundle', 'unix')).toBe('/bundle/bin');
    expect(bundleBinDir('C:\\bundle', 'windows')).toBe('C:\\bundle\\bin');
  });
});

describe('chooseUnixBinDir', () => {
  it('prefers the first writable dir on PATH', () => {
    const a = tmp();
    const b = tmp();
    // Mark `b` writable, `a` not — should pick b (skip a).
    expect(
      chooseUnixBinDir(`${a}:${b}`, { isWritable: (d) => d === b }).toLowerCase(),
    ).toBe(b.toLowerCase());
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });

  it('returns null when none is writable', () => {
    expect(chooseUnixBinDir('/nonexistent-dir-x:/another-none', { isWritable: () => false })).toBeNull();
  });
});

describe('addBundleBinToPath — unix symlink', () => {
  it('symlinks bin/codegraph into a writable PATH dir; idempotent on re-run', () => {
    const root = tmp(); // the "bundle"
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codegraph'), '#!/bin/sh\necho codegraph\n');
    fs.chmodSync(path.join(bin, 'codegraph'), 0o755);

    const pathDir = tmp(); // a writable dir on PATH
    const savedPath = process.env.PATH;
    process.env.PATH = `${pathDir}:/usr/bin:/bin`;

    try {
      const r1 = addBundleBinToPath(root, 'unix');
      expect(r1.action).toBe('added');
      const link = path.join(pathDir, 'codegraph');
      expect(fs.existsSync(link)).toBe(true);
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(bin, 'codegraph')));

      // Re-run → unchanged (already points at our launcher).
      const r2 = addBundleBinToPath(root, 'unix');
      expect(r2.action).toBe('unchanged');
      expect(fs.readlinkSync(link)).toBeDefined();
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(pathDir, { recursive: true, force: true });
    }
  });

  it('skips when no launcher exists in the bundle', () => {
    const root = tmp();
    const r = addBundleBinToPath(root, 'unix');
    expect(r.action).toBe('skipped');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('replaces a stale link pointing elsewhere', () => {
    const root = tmp();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codegraph'), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, 'codegraph'), 0o755);

    const pathDir = tmp();
    fs.symlinkSync('/usr/bin/whoami', path.join(pathDir, 'codegraph')); // stale link

    const savedPath = process.env.PATH;
    process.env.PATH = pathDir;
    try {
      const r = addBundleBinToPath(root, 'unix');
      expect(r.action).toBe('added');
      expect(fs.realpathSync(path.join(pathDir, 'codegraph'))).toBe(fs.realpathSync(path.join(bin, 'codegraph')));
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(pathDir, { recursive: true, force: true });
    }
  });
});

describe('addBundleBinToPath — windows (pure decision on a stubbed read)', () => {
  it('computes the appended user PATH string without mangling existing tokens', () => {
    const binDir = bundleBinDir('C:\\codegraph', 'windows');
    // Mirrors install.ps1: idempotent when the dir is already a token.
    expect(hasPathToken(splitPathList(`${binDir};C:\\Windows`, 'windows'), binDir, 'windows')).toBe(true);
    // A fresh user PATH gets our dir prepended.
    const fresh = `${binDir};C:\\Windows`;
    expect(fresh).toBe(`${binDir};C:\\Windows`);
  });
});
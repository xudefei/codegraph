/**
 * Offline / self-contained install tests.
 *
 * When the installer runs FROM INSIDE a self-contained bundle, each agent's
 * MCP config must point at the bundle's absolute launcher path instead of the
 * bare `codegraph` command name (which an offline machine can't provide via
 * PATH). See `src/installer/bundle.ts` + `setBundleInvocation` in
 * `src/installer/targets/shared.ts`.
 *
 * The module-level `setBundleInvocation` is reset in `afterEach` so these
 * tests never leak into the online `installer-targets.test.ts` suite (which
 * asserts the exact `command: 'codegraph'` default).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseJsonc } from 'jsonc-parser';
import {
  buildBundleInvocation,
  type ServerInvocation,
} from '../src/installer/bundle';
import {
  getMcpServerConfig,
  setBundleInvocation,
  getBundleInvocation,
} from '../src/installer/targets/shared';
import { getTarget } from '../src/installer/targets/registry';

// A plausible bundle-launcher invocation for each platform family.
const UNIX_INV: ServerInvocation = {
  command: '/bundle/bin/codegraph',
  args: ['serve', '--mcp'],
};
// Windows uses the vendored node.exe directly (a `.cmd` can't be spawned).
const WIN_INV: ServerInvocation = {
  command: 'C:\\cg\\node.exe',
  args: [
    'C:\\cg\\lib\\dist\\bin\\codegraph.js',
    '--liftoff-only',
    '--disable-warning=ExperimentalWarning',
    'serve',
    '--mcp',
  ],
};

function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-offline-${label}-`));
}

function setHome(dir: string): { restore: () => void } {
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HERMES_HOME: process.env.HERMES_HOME,
    COPILOT_HOME: process.env.COPILOT_HOME,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.APPDATA = path.join(dir, '.config');
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
  delete process.env.HERMES_HOME;
  delete process.env.COPILOT_HOME;
  return {
    restore() {
      if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
      if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA;
      if (prev.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
      if (prev.HERMES_HOME === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = prev.HERMES_HOME;
      if (prev.COPILOT_HOME === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = prev.COPILOT_HOME;
    },
  };
}

describe('bundle invocation helper', () => {
  it('unix: uses the bin/codegraph shim with the MCP args', () => {
    expect(buildBundleInvocation('/bundle', 'unix')).toEqual({
      command: '/bundle/bin/codegraph',
      args: ['serve', '--mcp'],
    });
  });

  it('windows: uses vendored node.exe + JS entry + liftoff flags (no .cmd)', () => {
    expect(buildBundleInvocation('C:\\cg', 'windows')).toEqual(WIN_INV);
  });

  it('windows: entry path is under lib/dist/bin/codegraph.js', () => {
    const inv = buildBundleInvocation('C:\\bundle', 'windows');
    expect(inv.command).toBe('C:\\bundle\\node.exe');
    expect(inv.args[0]).toBe('C:\\bundle\\lib\\dist\\bin\\codegraph.js');
    // The shim's two engine flags are preserved on the direct spawn.
    expect(inv.args).toContain('--liftoff-only');
    expect(inv.args).toContain('--disable-warning=ExperimentalWarning');
  });
});

describe('shared getMcpServerConfig seam', () => {
  beforeEach(() => setBundleInvocation(null));
  afterEach(() => setBundleInvocation(null));

  it('defaults to the online command: codegraph', () => {
    expect(getBundleInvocation()).toBeNull();
    expect(getMcpServerConfig()).toEqual({
      type: 'stdio',
      command: 'codegraph',
      args: ['serve', '--mcp'],
    });
  });

  it('returns the absolute bundle command when an invocation is set', () => {
    setBundleInvocation(UNIX_INV);
    expect(getMcpServerConfig()).toEqual({ type: 'stdio', ...UNIX_INV });
  });

  it('resets to default after setBundleInvocation(null)', () => {
    setBundleInvocation(UNIX_INV);
    setBundleInvocation(null);
    expect(getMcpServerConfig().command).toBe('codegraph');
  });
});

describe('Installer targets — offline bundle', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };
  let hermesHome: string;

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
    hermesHome = path.join(tmpHome, 'hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
    process.env.HERMES_HOME = hermesHome;
    setBundleInvocation(null);
  });

  afterEach(() => {
    setBundleInvocation(null);
    delete process.env.HERMES_HOME;
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('codex (TOML): writes the absolute command; re-run is unchanged; a moved bundle rewrites the path', () => {
    const codex = getTarget('codex')!;
    setBundleInvocation(UNIX_INV);

    const first = codex.install('global', { autoAllow: true });
    const tomlPath = path.join(tmpHome, '.codex', 'config.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
    expect(fs.readFileSync(tomlPath, 'utf-8')).toContain('command = "/bundle/bin/codegraph"');

    // Idempotent.
    const again = codex.install('global', { autoAllow: true });
    expect(again.files.every((f) => f.action === 'unchanged')).toBe(true);

    // Relocated bundle → the MCP config command rewrites to the new path.
    setBundleInvocation({ command: '/moved/bin/codegraph', args: ['serve', '--mcp'] });
    const moved = codex.install('global', { autoAllow: true });
    expect(fs.readFileSync(tomlPath, 'utf-8')).toContain('command = "/moved/bin/codegraph"');
    expect(moved.files.some((f) => f.action === 'updated')).toBe(true);

    // Uninstall still removes by server name (keyed on `codegraph`, not the
    // command string) despite the absolute command.
    codex.uninstall('global');
    expect(fs.existsSync(tomlPath)).toBe(false);
  });

  it('codex (TOML): a Windows node.exe path round-trips (backslashes escaped) and stays a valid basic string', () => {
    const codex = getTarget('codex')!;
    setBundleInvocation(WIN_INV);
    codex.install('global', { autoAllow: true });
    const toml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    // TOML basic strings escape `\` as `\\`; a lone backslash would be invalid.
    expect(toml).toContain('command = "C:\\\\cg\\\\node.exe"');
    expect(toml).toContain('serve');
    expect(toml).toContain('--mcp');
  });

  it('opencode: flat command array resolves to the bundle launcher', () => {
    const opencode = getTarget('opencode')!;
    setBundleInvocation(UNIX_INV);
    opencode.install('global', { autoAllow: true });

    const file = path.join(tmpHome, '.config', 'opencode', 'opencode.jsonc');
    const cfg = parseJsonc(fs.readFileSync(file, 'utf-8'));
    expect(cfg.mcp.codegraph.command).toEqual(['/bundle/bin/codegraph', 'serve', '--mcp']);
    expect(cfg.mcp.codegraph.enabled).toBe(true);
  });

  it('opencode: Windows node-direct invocation flattens node.exe + entry + flags', () => {
    const opencode = getTarget('opencode')!;
    setBundleInvocation(WIN_INV);
    opencode.install('global', { autoAllow: true });

    const file = path.join(tmpHome, '.config', 'opencode', 'opencode.jsonc');
    const cfg = parseJsonc(fs.readFileSync(file, 'utf-8'));
    expect(cfg.mcp.codegraph.command).toEqual([
      'C:\\cg\\node.exe',
      'C:\\cg\\lib\\dist\\bin\\codegraph.js',
      '--liftoff-only',
      '--disable-warning=ExperimentalWarning',
      'serve',
      '--mcp',
    ]);
  });

  it('antigravity: command/args = invocation, still NO `type` field (offline)', () => {
    const antigravity = getTarget('antigravity')!;
    // Point at the unified path for a deterministic file.
    fs.mkdirSync(path.join(tmpHome, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.gemini', 'config', '.migrated'), '');

    setBundleInvocation(UNIX_INV);
    antigravity.install('global', { autoAllow: true });

    const file = path.join(tmpHome, '.gemini', 'config', 'mcp_config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toEqual({
      command: '/bundle/bin/codegraph',
      args: ['serve', '--mcp'],
    });
    expect(cfg.mcpServers.codegraph.type).toBeUndefined();
  });

  it('hermes: absolute path is single-quoted (valid YAML) even with spaces in the path', () => {
    const hermes = getTarget('hermes')!;
    const spacePath = '/Users/bob/My CodeGraph/bin/codegraph';
    setBundleInvocation({ command: spacePath, args: ['serve', '--mcp'] });
    hermes.install('global', { autoAllow: true });

    const file = path.join(hermesHome, 'config.yaml');
    const body = fs.readFileSync(file, 'utf-8');
    expect(body).toContain(`command: '${spacePath}'`);
    // An unquoted scalar with spaces would be invalid YAML and break parse.
    expect(body).not.toContain(`command: ${spacePath}`);
  });

  it('generic JSON targets (gemini) flow through getMcpServerConfig to the absolute command', () => {
    const gemini = getTarget('gemini')!;
    setBundleInvocation(UNIX_INV);
    gemini.install('global', { autoAllow: true });

    const file = path.join(tmpHome, '.gemini', 'settings.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toEqual({ type: 'stdio', ...UNIX_INV });
  });

  it('online default is restored once no bundle invocation is active', () => {
    const gemini = getTarget('gemini')!;
    // No setBundleInvocation → the normal online shape.
    gemini.install('global', { autoAllow: true });
    const file = path.join(tmpHome, '.gemini', 'settings.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(cfg.mcpServers.codegraph.command).toBe('codegraph');
  });
})
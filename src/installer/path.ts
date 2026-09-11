/**
 * Put the offline bundle's `bin/` on the user's PATH.
 *
 * A normal (online) `codegraph install` satisfies `command: 'codegraph'` by
 * running `npm install -g`, which drops `codegraph` onto PATH itself. The
 * offline mode (`install --offline`) deliberately skips that npm step, so
 * the CLI shortcut is never created — agents still work (their MCP configs
 * carry the bundle's absolute launcher path), but typing `codegraph` in a
 * terminal doesn't resolve.
 *
 * This closes that gap for the in-place, extracted bundle, following the same
 * conventions as the official `install.sh` / `install.ps1`:
 *
 *   - **windows** — append `<bundle>/bin` to the user-level PATH
 *     (`[Environment]::SetEnvironmentVariable('Path', ..., 'User')`), idempotent
 *     on a token match, preserving any `%VAR%` tokens in the existing value.
 *   - **unix** — symlink `<bundle>/bin/codegraph` into the first writable
 *     directory already on PATH (no shell-rc editing), mirroring `install.sh`'s
 *     launcher symlink.
 *
 * Never a hard failure: PATH setup is a convenience, so if it can't be done
 * the offline install still succeeds and the caller only logs a hint.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export type PathAction =
  | { action: 'added'; binDir: string; for: string }
  | { action: 'unchanged'; binDir: string; for: string }
  | { action: 'skipped'; binDir: string; reason: string }
  | { action: 'failed'; binDir: string; reason: string };

/** The `<bundle>/bin` dir whose launcher should land on PATH. */
export function bundleBinDir(bundleRoot: string, osKind: 'unix' | 'windows'): string {
  const P = osKind === 'windows' ? path.win32 : path.posix;
  return P.join(bundleRoot, 'bin');
}

/** Split a PATH-style string into non-empty tokens, normalized to the OS delimiter. */
export function splitPathList(value: string, osKind: 'unix' | 'windows'): string[] {
  const sep = osKind === 'windows' ? ';' : ':';
  return value.split(sep).map((t) => t.trim()).filter((t) => t.length > 0);
}

/** Is `dir` already a token of `tokens`? (case-insensitive on Windows). */
export function hasPathToken(tokens: string[], dir: string, osKind: 'unix' | 'windows'): boolean {
  if (osKind === 'windows') {
    return tokens.some((t) => t.toLowerCase() === dir.toLowerCase());
  }
  return tokens.includes(dir);
}

// ---------------------------------------------------------------------------
// Windows: read / write the user-level PATH (preserves %VAR% tokens because
// .NET writes REG_EXPAND_SZ). Mirrors install.ps1.
// ---------------------------------------------------------------------------

function powershell(script: string): string {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

export function readWindowsUserPath(): string {
  try {
    return powershell("[Environment]::GetEnvironmentVariable('Path', 'User')") || '';
  } catch {
    return '';
  }
}

export function writeWindowsUserPath(value: string): void {
  // Single-quote the PS string; escape any inner quotes by doubling them.
  const quoted = value.replace(/'/g, "''");
  powershell(`[Environment]::SetEnvironmentVariable('Path', '${quoted}', 'User')`);
}

// ---------------------------------------------------------------------------
// Unix: symlink the launcher into a writable dir already on PATH.
// ---------------------------------------------------------------------------

export function chooseUnixBinDir(envPath: string, deps?: { isWritable?: (d: string) => boolean }): string | null {
  const isWritable = deps?.isWritable ?? ((d: string) => {
    try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; }
  });
  for (const dir of splitPathList(envPath, 'unix')) {
    // Skip empties and system-only dirs that are unlikely writable.
    if (!dir) continue;
    try {
      if (fs.existsSync(dir) && isWritable(dir)) return dir;
    } catch { /* keep looking */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Ensure the bundle's `bin/` is reachable as `codegraph` on PATH. Pure
 * decision + no-op checks are injectable for tests; the shell/fs effectors are
 * wired to the real environment by default.
 */
export function addBundleBinToPath(
  bundleRoot: string,
  osKind: 'unix' | 'windows',
): PathAction {
  const binDir = bundleBinDir(bundleRoot, osKind);
  const launcher = osKind === 'windows' ? 'codegraph.cmd' : 'codegraph';
  const launcherPath = path.join(binDir, launcher);
  if (!fs.existsSync(launcherPath)) {
    return { action: 'skipped', binDir, reason: `no ${launcher} in bundle` };
  }

  if (osKind === 'windows') {
    // Windows launches bist through PATH literally (npx/vscode/node spawn
    // resolve `codegraph` via PATH), so the user-level PATH is the one place.
    return ensureWindowsUserPath(binDir);
  }
  return ensureUnixSymlink(binDir, launcherPath);
}

function ensureWindowsUserPath(binDir: string): PathAction {
  const current = readWindowsUserPath();
  const tokens = splitPathList(current, 'windows');
  if (hasPathToken(tokens, binDir, 'windows')) {
    return { action: 'unchanged', binDir, for: 'Windows user PATH' };
  }
  try {
    // Keep any %VAR% tokens intact; put our dir first so we win any tie.
    writeWindowsUserPath(`${binDir};${current}`);
    return { action: 'added', binDir, for: 'Windows user PATH' };
  } catch (err) {
    return { action: 'failed', binDir, reason: err instanceof Error ? err.message : String(err) };
  }
}

function ensureUnixSymlink(binDir: string, launcherPath: string): PathAction {
  const envPath = process.env.PATH || '';
  const targetDir = chooseUnixBinDir(envPath);
  if (!targetDir) {
    return {
      action: 'skipped',
      binDir,
      reason: `no writable directory on your PATH; add it yourself:\n  export PATH="${binDir}:$PATH"`,
    };
  }
  const link = path.join(targetDir, 'codegraph');
  try {
    // Idempotent: already pointing at our launcher → nothing to do.
    if (fs.existsSync(link)) {
      const real = fs.realpathSync(link);
      if (real === fs.realpathSync(launcherPath)) {
        return { action: 'unchanged', binDir, for: `symlink ${link}` };
      }
      fs.unlinkSync(link);
    }
    fs.symlinkSync(launcherPath, link);
    return { action: 'added', binDir, for: `symlink ${link}` };
  } catch (err) {
    return { action: 'failed', binDir, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Writable probe used by tests. */
export function pathIsWritable(dir: string): boolean {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}
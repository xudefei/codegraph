/**
 * Offline / self-contained install mode.
 *
 * CodeGraph ships as a self-contained bundle (`scripts/build-bundle.sh`) that
 * vendors its own Node runtime + compiled app, so the MCP server it launches
 * runs with no network and no system Node. The only thing that kept a
 * machine with no internet from using it was the INSTALLER: it assumed
 * `codegraph` resolves via PATH, which today is satisfied only by a networked
 * `npm install -g` step.
 *
 * This module closes that gap. When the installer runs FROM INSIDE a bundle,
 * `resolveBundleInvocation()` returns the absolute launcher command for THIS
 * bundle, and the installer writes that absolute path into each agent's MCP
 * config instead of the bare `codegraph` command name — skipping npm entirely.
 *
 * Bundle layout (see `scripts/build-bundle.sh` and `detectInstallMethod` in
 * `src/upgrade/index.ts`):
 *
 *   <root>/
 *     node | node.exe          vendored runtime
 *     bin/codegraph(.cmd)      launcher
 *     lib/dist/bin/codegraph.js app entry
 *
 * We reuse `detectInstallMethod` rather than inventing a marker: it already
 * sniffs this exact layout (and correctly rejects npm/npx trees first).
 */

import * as path from 'path';
import * as fs from 'fs';
import { detectInstallMethod } from '../upgrade';

export interface ServerInvocation {
  command: string;
  args: string[];
}

/** Path flags a bundle's launcher already injects (single source of truth,
 *  see scripts/build-bundle.sh) — so a direct node spawn must repeat them. */
const LIFTOFF = '--liftoff-only';
const DISABLE_WARN = '--disable-warning=ExperimentalWarning';

/**
 * Pure core — the `{command, args}` an agent MCP config should use to launch
 * codegraph from `bundleRoot`. Unit-testable: `os` is forced to the TARGET
 * platform's semantics ("windows" can be tested from a POSIX host), matching
 * the convention of `deriveInstallDir` in `src/upgrade/index.ts`.
 *
 * - **unix** — the `bin/codegraph` shim. It already execs the vendored node
 *   with `--liftoff-only` (V8 WASM guard, single source of truth) and threads
 *   `CODEGRAPH_HOST_PPID` (orphan watchdog, issue #1185); reusing it avoids
 *   duplicating those constants.
 * - **windows** — a real PE image (`node.exe`). Node-based MCP hosts cannot
 *   spawn a `.cmd` directly (EINVAL since CVE-2024-27980; the repo routes
 *   around `.cmd` elsewhere too — see `npmInvocation` in upgrade/index.ts),
 *   so we bypass the `.cmd` shim and launch node with the flags the shim
 *   would have passed. The orphan watchdog is unaffected: `EARLY_PPID =
 *   process.ppid` (src/mcp/early-ppid.ts) is the host pid; we only skip the
 *   self-relaunch that would have needed `CODEGRAPH_HOST_PPID` threaded.
 */
export function buildBundleInvocation(
  bundleRoot: string,
  os: 'unix' | 'windows',
): ServerInvocation {
  const P = os === 'windows' ? path.win32 : path.posix;
  const launcher = P.join(bundleRoot, 'bin', os === 'windows' ? 'codegraph.cmd' : 'codegraph');
  const node = P.join(bundleRoot, os === 'windows' ? 'node.exe' : 'node');
  const entry = P.join(bundleRoot, 'lib', 'dist', 'bin', 'codegraph.js');
  return os === 'windows'
    ? { command: node, args: [entry, LIFTOFF, DISABLE_WARN, 'serve', '--mcp'] }
    : { command: launcher, args: ['serve', '--mcp'] };
}

/**
 * The absolute launcher command for the bundle this process is running from,
 * or `null` when NOT inside a bundle (caller then keeps the online
 * `command: 'codegraph'` behavior).
 *
 * The CLI entry is derived relative to this module so it resolves in both
 * layouts: source dev (`dist/installer/bundle.js` → `dist/bin/codegraph.js`)
 * and a bundle (`lib/dist/installer/bundle.js` →
 * `lib/dist/bin/codegraph.js`). `detectInstallMethod` then walks up from
 * `<bin>` to find the bundle root and verify a vendored node + launcher exist.
 */
export interface BundleContext {
  /** Absolute path of the bundle root (`<root>/node` siblings live here). */
  bundleRoot: string;
  os: 'unix' | 'windows';
}

/**
 * The bundle's root + platform family, or `null` when NOT running from a
 * bundle. Shared by `resolveBundleInvocation` (the MCP command) and the
 * offline PATH setup (`addBundleBinToPath` needs `bundleRoot` + `os`).
 */
export function resolveBundleContext(): BundleContext | null {
  const cliEntry = path.resolve(__dirname, '..', 'bin', 'codegraph.js');
  const method = detectInstallMethod({
    filename: cliEntry,
    platform: process.platform,
    cwd: process.cwd(),
    exists: fs.existsSync,
  });
  if (method.kind !== 'bundle') return null;
  return { bundleRoot: method.bundleRoot, os: method.os };
}

export function resolveBundleInvocation(): ServerInvocation | null {
  const ctx = resolveBundleContext();
  if (!ctx) return null;
  return buildBundleInvocation(ctx.bundleRoot, ctx.os);
}
/**
 * The terminal app's own part of the daemon service's facts: where this install keeps its packaged files and which
 * daemon program it starts. The facts themselves (the managed unit, the endpoints, the findings) are read by the
 * platform's one reader (platform/support/service-manager-posture.ts), the same one the daemon uses for every support
 * bundle, so `goodvibes service status`, `goodvibes status` and a support bundle record the same service facts.
 */
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDaemonProgram } from '@goodvibes/engine/platform/platform/runtime/client';
import type { PlatformServiceManager } from '@goodvibes/engine/platform/platform/daemon';
import {
  buildCliServicePosture as buildServiceManagerPosture,
  createPlatformServiceManager as createServiceManager,
  type CliServicePosture,
  type CliServicePostureOptions,
  type CliServiceRuntime,
} from '@goodvibes/engine/platform/platform/support/service-manager-posture';

const SOURCE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The packaged root of this install (the directory that owns `vendor/`,
 * `dist/`, and `bin/`), resolved the same way the daemon executable search
 * resolves its package paths. Exposed so the install self-check can look for
 * the vendored release binaries without re-deriving this path.
 */
export function getGoodVibesPackageRoot(): string {
  return SOURCE_PACKAGE_ROOT;
}

export interface DaemonExecutableResolutionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly execPath?: string;
  readonly packageRoot?: string;
}

export interface DaemonExecutableResolution {
  readonly command: string;
  readonly source: 'env' | 'sibling' | 'package' | 'path' | 'fallback';
  readonly absolute: boolean;
}

/** The daemon program this install starts: the platform's one lookup (runtime/client/daemon-program.ts), this package's own folders first. */
export function resolveGoodVibesDaemonExecutable(options: DaemonExecutableResolutionOptions = {}): DaemonExecutableResolution {
  const found = findDaemonProgram({
    env: options.env, argv: options.argv, execPath: options.execPath,
    packageRoots: [options.packageRoot ?? SOURCE_PACKAGE_ROOT],
  });
  if (!found) return { command: 'goodvibes-daemon', source: 'fallback', absolute: false };
  return { command: found.command, source: found.source === 'self' ? 'sibling' : found.source, absolute: isAbsolute(found.command) };
}

/** The daemon's service manager, with the daemon program this install starts. */
export function createPlatformServiceManager(runtime: CliServiceRuntime, workingDirectory?: string): PlatformServiceManager {
  return createServiceManager(runtime, workingDirectory, resolveGoodVibesDaemonExecutable().command);
}

/** The daemon service's facts, with the daemon program this install starts named in the unit's command. */
export function buildCliServicePosture(runtime: CliServiceRuntime, options: CliServicePostureOptions = {}): Promise<CliServicePosture> {
  return buildServiceManagerPosture(runtime, { ...options, daemonCommand: options.daemonCommand ?? resolveGoodVibesDaemonExecutable().command });
}

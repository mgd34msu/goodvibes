/**
 * shell-env.ts — Hydrate missing user environment variables when the daemon
 * starts under a service manager (systemd on Linux, launchd on macOS).
 *
 * Service managers launch `goodvibes-daemon` directly without sourcing the
 * user's shell rc files (`~/.bashrc`, `~/.zshrc`, `~/.profile`,
 * `~/.config/fish/config.fish`), so environment variables exported there
 * (provider API keys, `TYPESAFE_API_KEY`, custom tool tokens, `PATH` additions)
 * are absent from `process.env` inside the daemon even though they are present
 * in every interactive terminal.
 *
 * This module queries the user's login shell once at startup, parses the
 * sentinel-delimited environment in memory, and fills in only keys that are
 * missing from `process.env`. Nothing is ever written to disk, unit files,
 * logs, or secret stores, and service-manager/unit variables are never
 * overwritten.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename, delimiter } from 'node:path';

/** Maximum time to wait for the user's login shell to report its environment. */
const SHELL_ENV_TIMEOUT_MS = 3_000;
const SHELL_ENV_MAX_BUFFER = 1024 * 1024;

/**
 * Shell-session internals and daemon-home routing vars that must never be
 * imported from a shell rc into the daemon process.
 */
const EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  '_', 'SHLVL', 'PWD', 'OLDPWD', 'PPID', 'RANDOM', 'SECONDS', 'LINENO',
  'PS1', 'PS2', 'PS3', 'PS4', 'PROMPT_COMMAND', 'IFS',
  'HISTFILE', 'HISTSIZE', 'HISTFILESIZE',
  'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM', 'NO_COLOR',
  'SSH_TTY', 'GPG_TTY', 'LS_COLORS', 'DIRCOLORS',
  'GOODVIBES_NO_SHELL_ENV', 'GOODVIBES_HOME', 'GOODVIBES_DAEMON_HOME',
]);

/** True when `goodvibes-daemon` is starting to serve under a service manager that strips shell rc env. */
export function shouldHydrateServiceShellEnv(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return false;
  if (env['GOODVIBES_NO_SHELL_ENV'] === '1') return false;
  const first = args[0];
  if (first !== undefined && !first.startsWith('-') && first !== 'serve') return false;
  const systemd = Boolean(env['INVOCATION_ID']?.trim()) || Boolean(env['JOURNAL_STREAM']?.trim());
  const launchd = Boolean(env['XPC_SERVICE_NAME']?.trim()) && env['XPC_SERVICE_NAME'] !== '0';
  return systemd || launchd;
}

/** Resolve the user's configured login shell path. */
export function resolveUserLoginShell(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  passwdShell?: string | null,
): string {
  const fromPasswd = passwdShell?.trim();
  if (fromPasswd) return fromPasswd;
  const fromEnv = env['SHELL']?.trim();
  if (fromEnv) return fromEnv;
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

/** Build shell arguments that emit sentinel-wrapped `env -0` (falling back to `env`). */
export function shellEnvArgs(shellPath: string, marker: string): readonly string[] {
  const name = basename(shellPath).toLowerCase();
  const start = `__GV_ENV_START_${marker}__`;
  const end = `__GV_ENV_END_${marker}__`;
  if (name === 'fish') {
    const cmd = `printf '${start}'; env -0 2>/dev/null; or env; printf '${end}'`;
    return ['-l', '-c', cmd];
  }
  const cmd = `printf '${start}'; (env -0 2>/dev/null || env); printf '${end}'`;
  if (name === 'bash' || name === 'zsh') {
    // Interactive + login so standard `~/.bashrc` (`[[ $- != *i* ]] && return`) and `~/.zshrc` exports run.
    return ['-i', '-l', '-c', cmd];
  }
  return ['-l', '-c', cmd];
}

/** Parse environment key/value pairs captured between the start and end sentinels. */
export function parseMarkedShellEnv(output: string, marker: string): Record<string, string> {
  const startToken = `__GV_ENV_START_${marker}__`;
  const endToken = `__GV_ENV_END_${marker}__`;
  const start = output.indexOf(startToken);
  if (start < 0) return {};
  const payloadStart = start + startToken.length;
  const end = output.indexOf(endToken, payloadStart);
  if (end < 0) return {};
  const payload = output.slice(payloadStart, end);
  if (!payload) return {};

  const parsed: Record<string, string> = {};
  const entries = payload.includes('\0') ? payload.split('\0') : payload.split(/\r?\n/u);
  for (const entry of entries) {
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    parsed[key] = entry.slice(eq + 1);
  }
  return parsed;
}

/**
 * Merge hydrated shell variables into `targetEnv` without overwriting existing
 * non-empty variables or importing volatile shell internals. Missing `PATH`
 * segments are appended after existing ones. Returns the count of keys added.
 */
export function mergeHydratedEnv(
  targetEnv: Record<string, string | undefined>,
  shellEnv: Readonly<Record<string, string>>,
): number {
  let added = 0;
  for (const [key, value] of Object.entries(shellEnv)) {
    if (EXCLUDED_KEYS.has(key) || value === '') continue;
    if (key === 'PATH') {
      const current = (targetEnv['PATH'] ?? '').split(delimiter).filter(Boolean);
      const seen = new Set(current);
      const extra = value.split(delimiter).filter((segment) => segment.length > 0 && !seen.has(segment));
      if (extra.length > 0) {
        targetEnv['PATH'] = [...current, ...extra].join(delimiter);
        added += 1;
      }
      continue;
    }
    const existing = targetEnv[key];
    if (existing !== undefined && existing !== '') continue;
    targetEnv[key] = value;
    added += 1;
  }
  return added;
}

export interface HydrateServiceShellEnvOptions {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly timeoutMs?: number | undefined;
  readonly passwdShell?: string | null | undefined;
}

/**
 * Hydrate `process.env` (or `options.env`) from the user's login shell when
 * `goodvibes-daemon` starts under a service manager. Never throws.
 */
export function hydrateServiceShellEnvironment(
  args: readonly string[],
  options: HydrateServiceShellEnvOptions = {},
): number {
  const targetEnv = options.env ?? (process.env as Record<string, string | undefined>);
  const platform = options.platform ?? process.platform;
  if (!shouldHydrateServiceShellEnv(args, targetEnv, platform)) return 0;

  try {
    let passwdShell = options.passwdShell;
    if (passwdShell === undefined) {
      try { passwdShell = userInfo().shell; } catch { passwdShell = null; }
    }
    const shellPath = resolveUserLoginShell(targetEnv, platform, passwdShell);
    const marker = randomBytes(8).toString('hex');
    const childEnv: Record<string, string> = {
      TERM: 'dumb',
      NO_COLOR: '1',
      SHELL: shellPath,
    };
    for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
      const val = targetEnv[key];
      if (val) childEnv[key] = val;
    }
    const run = spawnSync(shellPath, [...shellEnvArgs(shellPath, marker)], {
      encoding: 'utf8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: options.timeoutMs ?? SHELL_ENV_TIMEOUT_MS,
      maxBuffer: SHELL_ENV_MAX_BUFFER,
    });
    if (run.error || typeof run.stdout !== 'string' || !run.stdout) return 0;
    return mergeHydratedEnv(targetEnv, parseMarkedShellEnv(run.stdout, marker));
  } catch {
    return 0;
  }
}

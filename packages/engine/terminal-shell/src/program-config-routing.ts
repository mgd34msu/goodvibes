/**
 * program-config-routing.ts, the one way a terminal program (the terminal app and the Agent) reaches the daemon for a
 * daemon-owned setting: where it listens and which credential it presents. Both programs' tool registries (the model's
 * `goodvibes_settings` and `goodvibes_context`) and their spawned agents are built with it, so a setting the model
 * writes goes to the daemon the same way from either program.
 *
 * The daemon home is consulted only to find where the daemon listens and which token to present, never to read
 * settings out of the daemon's settings file: values always come from the daemon over the wire.
 */
import { join } from 'node:path';
import {
  readControlPlaneBinding,
  readDaemonTierFile,
  readDotPath,
  type DaemonConfigRouterDeps,
  type DaemonWritePress,
} from '@goodvibes/engine/platform/platform/config';
import { bearerFor, type DaemonTarget } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target';
import { readOperatorTokenFile, resolveDaemonHomeDir } from '@goodvibes/engine/platform/platform/workspace/daemon-home';

export interface ProgramConfigRoutingOptions {
  /**
   * The home directory the caller's ConfigManager is rooted at. The daemon home is derived from it, so a process
   * running against a non-default home (a test, a second profile) never reaches the machine's real daemon. Only an
   * explicit GOODVIBES_DAEMON_HOME overrides it.
   */
  readonly homeDir?: string | undefined;
  /**
   * The daemon on another machine, as the one daemon target resolver chose it (daemon-target-resolver.ts): its address
   * and the credential bound to it. This machine's operator token is never presented to it.
   */
  readonly target?: DaemonTarget | undefined;
  /** Override the daemon home (honors GOODVIBES_DAEMON_HOME by default). */
  readonly daemonHomeDir?: string | undefined;
  /** True only when THIS process hosts the daemon. A terminal program normally does not. */
  readonly hostsDaemon?: boolean | undefined;
  /** Who decided the write (the person's press, the program's gate on the model's call), from the call site. */
  readonly press?: DaemonWritePress | undefined;
  /**
   * The daemon's whole config through the connection this program already holds, so a value just written is read
   * back from the runtime that applied it (reads and writes on one resolution). Absent: address discovery.
   */
  readonly readDaemonSnapshot?: (() => Promise<Record<string, unknown> | null>) | undefined;
}

/** The routing dependencies for a terminal program: the daemon's address from its own binding, its operator token. */
export function buildProgramConfigRouting(options: ProgramConfigRoutingOptions = {}): DaemonConfigRouterDeps {
  const daemonHomeDir = options.daemonHomeDir ?? resolveProgramDaemonHome(options.homeDir);
  const token = readOperatorToken(daemonHomeDir);
  const target = options.target;
  return {
    hostsDaemon: options.hostsDaemon ?? false,
    daemonHomeDir,
    token,
    // Where the daemon listens is DERIVED from its own control-plane binding, never from a stored base-URL string
    // (control-plane-base-url.ts). This is also what makes a foreground daemon discoverable: it writes no
    // detached-daemon record.
    readDaemonBinding: () => readDaemonBindingFromStore(daemonHomeDir),
    ...(options.readDaemonSnapshot ? { readDaemonSnapshot: options.readDaemonSnapshot } : {}),
    // A named daemon gets only its own bound credential, never this machine's token.
    ...(target
      ? { endpoint: { baseUrl: target.origin.baseUrl, token: target.credential ? bearerFor(target.credential, target.origin.baseUrl) : undefined, source: `the daemon at ${target.origin.baseUrl}` } }
      : {}),
    ...(options.press ? { press: options.press } : {}),
  };
}

/**
 * The daemon home for a caller rooted at `homeDir`. An explicit GOODVIBES_DAEMON_HOME still wins; otherwise the daemon
 * home follows the CALLER's home rather than the process user's.
 */
function resolveProgramDaemonHome(homeDir: string | undefined): string {
  if (process.env['GOODVIBES_DAEMON_HOME']?.trim()) return resolveDaemonHomeDir();
  if (homeDir?.trim()) return join(homeDir, '.goodvibes', 'daemon');
  return resolveDaemonHomeDir();
}

/** The bearer token the daemon's admin routes require, if present (a JSON record, a JSON string, or the raw token). */
function readOperatorToken(daemonHomeDir: string): string | undefined {
  const raw = readOperatorTokenFile(daemonHomeDir);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { token?: unknown }).token === 'string') {
      return (parsed as { token: string }).token;
    }
  } catch {
    return raw.trim() || undefined;
  }
  return undefined;
}

/** The daemon's control-plane binding out of its own settings store: address discovery, not value reading. */
function readDaemonBindingFromStore(daemonHomeDir: string) {
  try {
    const stored = readDaemonTierFile(join(daemonHomeDir, 'settings.json'));
    const read = (key: string): unknown => readDotPath(stored, key).value;
    if (readDotPath(stored, 'controlPlane.port').present === false
      && readDotPath(stored, 'controlPlane.hostMode').present === false) {
      return null;
    }
    return readControlPlaneBinding(read);
  } catch {
    return null;
  }
}

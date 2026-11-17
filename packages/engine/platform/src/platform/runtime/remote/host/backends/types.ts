import type { RemoteHostCredentialStore, RemoteHostLogger } from '../context.js';
import type { PeerRecord } from '../peer-registry.js';

/**
 * Payload accepted alongside a command on remote.peers.invoke. All fields are
 * optional; backends interpret what they support.
 */
export interface DispatchPayload {
  /** Positional args appended to the command (already tokenized). */
  args?: string[];
  /** Data piped to the process stdin. */
  stdin?: string;
  /**
   * Per-invocation environment for the command that runs (never includes
   * secrets). Names that change which program runs or how it loads are
   * refused when the payload is read. The shell-style backends set it inside
   * the remote shell; it never reaches the local docker, ssh or cloud CLI.
   */
  env?: Record<string, string>;
  /** Hard timeout for synchronous execution, in milliseconds. */
  timeoutMs?: number;
  /** Working directory of the command that runs (the shell-style backends change to it in the remote shell). */
  cwd?: string;
}

export interface BackendDispatchResult {
  exitCode?: number;
  workId?: string;
  stdout: string;
  stderr: string;
}

export interface BackendContext {
  credentials: RemoteHostCredentialStore;
  logger: RemoteHostLogger;
  /** Daemon home dir, used for ephemeral key material under a 0700 subdir. */
  homeDirectory: string;
}

/**
 * A remote execution backend. Each backend dispatches a single command for a
 * given peer and returns the captured stdout/stderr plus an exit code.
 *
 * Backends must NEVER place raw credentials in the returned stdout/stderr or in
 * any thrown error message. Credentials are resolved internally from the daemon
 * credential store via secret references on the peer's backendConfig.
 */
export interface Backend {
  readonly kind: PeerRecord['backendKind'];
  dispatch(
    peer: PeerRecord,
    command: string,
    payload?: DispatchPayload,
  ): Promise<BackendDispatchResult>;
  /**
   * Best-effort cleanup of any on-disk material the backend created (ephemeral
   * key/credential files and their containing dirs). Called from the surface
   * teardown so secrets do not outlive the daemon process. Optional: backends
   * that write nothing to disk omit it.
   */
  teardown?(): Promise<void>;
}

export const DEFAULT_SYNC_TIMEOUT_MS = 120_000;
export const MAX_SYNC_TIMEOUT_MS = 600_000;

export function resolveTimeout(payload?: DispatchPayload): number {
  const requested = payload?.timeoutMs;
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return Math.min(requested, MAX_SYNC_TIMEOUT_MS);
  }
  return DEFAULT_SYNC_TIMEOUT_MS;
}

/**
 * A refused or failed backend run. `status` is set when the caller's request is
 * what was wrong (400 bad input, 404 no such backend, 409 a name already taken),
 * so a route answers with it; a failure of the backend itself carries none.
 */
export class BackendDispatchError extends Error {
  readonly code: string;
  readonly status?: number | undefined;
  constructor(message: string, code = 'REMOTE_BACKEND_DISPATCH_FAILED', status?: number) {
    super(message);
    this.name = 'BackendDispatchError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Compose the remote-shell command line for the shell-style backends
 * (docker `sh -c`, ssh remote command, cloud-CLI `--command`/`--scripts`).
 *
 * REMOTE-SHELL SEMANTICS (intentional, documented asymmetry vs local-process):
 * positional `payload.args` are joined onto the command with a single space and
 * are NOT shell-escaped, because these backends hand a single command STRING to
 * a remote shell, the operator's `command` may itself contain pipes, redirects,
 * globs, or quoting that must survive the hop verbatim. The local-process
 * backend, by contrast, never invokes a shell and passes args as discrete argv.
 *
 * The route is admin-only and a model's call is judged by the permission gate
 * on its `command` before it is sent, so callers that need literal arguments
 * pre-quote them inside `command` or `args`.
 *
 * `payload.env` and `payload.cwd` are applied inside the remote shell, quoted,
 * ahead of the command, so they reach the command that runs and never the
 * local CLI that carries it (where a variable such as DOCKER_HOST would send
 * the command somewhere else).
 */
export function buildRemoteShellCommand(command: string, payload?: DispatchPayload): string {
  const line = payload?.args && payload.args.length > 0 ? `${command} ${payload.args.join(' ')}` : command;
  const exports = Object.entries(payload?.env ?? {}).map(([name, value]) => `export ${name}=${quoteShell(value)}; `).join('');
  const cd = payload?.cwd !== undefined ? `cd ${quoteShell(payload.cwd)} && ` : '';
  return `${exports}${cd}${line}`;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** An environment variable name a shell accepts. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether a payload environment variable would change which program runs or
 * what it loads, so a command allowed by name could run something else.
 */
export function isProgramChangingEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (PROGRAM_CHANGING_ENV_NAMES.has(upper)) return true;
  return PROGRAM_CHANGING_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
    || upper.endsWith('_PROXY');
}

const PROGRAM_CHANGING_ENV_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'ENV', 'BASH_ENV', 'IFS', 'CDPATH', 'ZDOTDIR', 'PROMPT_COMMAND',
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PERL5LIB', 'PERL5OPT',
  'PERLLIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'GIT_EXEC_PATH', 'GIT_PROXY_COMMAND', 'EDITOR', 'VISUAL', 'PAGER',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
  'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'KUBECONFIG',
]);

const PROGRAM_CHANGING_ENV_PREFIXES = ['LD_', 'DYLD_', 'BUN_', 'GIT_SSH', 'GIT_CONFIG', 'CLOUDSDK_', 'AWS_', 'AZURE_', 'GOOGLE_'];

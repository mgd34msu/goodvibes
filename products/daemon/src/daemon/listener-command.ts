/**
 * listener-command.ts, `goodvibes-daemon listener token [--show] [--json]`.
 *
 * The webhook listener (`danger.httpListener`) accepts its own bearer token,
 * never the operator token: `GOODVIBES_HTTP_TOKEN` when the daemon's
 * environment sets it, otherwise the token the daemon keeps in
 * `<daemon home>/http-listener-token.json`. This command says which applies,
 * where the file is, and with `--show` prints the token for a webhook sender.
 * It reads only: it creates no token (the daemon does, the first time it starts
 * with the listener on) and contacts no daemon.
 */
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { httpListenerTokenPath, readHttpListenerTokenValue } from '@goodvibes/engine/platform/platform/pairing';
import { readEnvHttpListenerToken } from '../cli/daemon-tokens.js';

export const LISTENER_USAGE = 'Usage: goodvibes-daemon listener token [--show] [--json]';

export interface ListenerCommandResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

export interface ListenerCommandDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Injected in tests; the token file reader otherwise. */
  readonly readStoredToken?: ((daemonHomeDir: string) => string | null) | undefined;
}

export function runListenerCommand(argv: readonly string[], deps: ListenerCommandDeps): ListenerCommandResult {
  const json = argv.includes('--json');
  const show = argv.includes('--show');
  const words = argv.filter((arg) => arg !== '--json' && arg !== '--show');
  const fail = (exitCode: number, code: string, error: string, fix: string): ListenerCommandResult => ({
    exitCode,
    lines: json ? [JSON.stringify({ ok: false, code, error, fix }, null, 2)] : [error, `  ${fix}`],
  });
  if (words.length !== 1 || words[0] !== 'token') return fail(2, 'COMMAND_REFUSED', `listener: ${words.length === 0 ? 'name what to show' : `unknown arguments: ${words.join(' ')}`}`, LISTENER_USAGE);

  const enabled = deps.configManager.get('danger.httpListener') === true;
  const path = httpListenerTokenPath(deps.daemonHomeDir);
  const fromEnv = readEnvHttpListenerToken(deps.env);
  const stored = fromEnv === undefined ? (deps.readStoredToken ?? readHttpListenerTokenValue)(deps.daemonHomeDir) : null;
  const token = fromEnv ?? stored ?? undefined;
  const source = fromEnv !== undefined ? 'environment' : 'file';

  if (show && token === undefined) {
    return fail(1, 'LISTENER_TOKEN_MISSING', `no webhook listener token is stored at ${path} yet`,
      enabled ? 'start the daemon; it creates the token as it starts with the listener on'
        : 'turn the listener on (goodvibes-daemon config set danger.httpListener true) and start the daemon; it creates the token then');
  }

  if (json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: {
          listenerEnabled: enabled,
          source,
          tokenFile: path,
          tokenStored: stored !== null,
          ...(show && token !== undefined ? { token } : {}),
        },
      }, null, 2)],
    };
  }

  const lines = [
    `webhook listener: ${enabled ? 'on' : 'off'} (danger.httpListener)`,
    source === 'environment'
      ? '  token: GOODVIBES_HTTP_TOKEN in this command\'s environment (a daemon started with it set uses it instead of the file)'
      : `  token file: ${path}${stored === null ? ' (not created yet; the daemon creates it the first time it starts with the listener on)' : ''}`,
    '  webhook senders send this token as their bearer token; the operator token is refused at the listener.',
  ];
  if (show && token !== undefined) lines.push(token);
  else if (token !== undefined) lines.push('  print it with: goodvibes-daemon listener token --show');
  return { exitCode: 0, lines };
}

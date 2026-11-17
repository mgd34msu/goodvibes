import { isAbsolute, resolve } from 'node:path';
import type { PeerRecord } from '../peer-registry.js';
import type { LocalProcessBackendConfig } from '../peer-registry.js';
import {
  type Backend,
  type BackendContext,
  type BackendDispatchResult,
  type DispatchPayload,
  BackendDispatchError,
  resolveTimeout,
} from './types.js';
import { runProcess } from './process-runner.js';
import { BackendLifetime } from './backend-lifetime.js';

/** Split a command string into argv, honoring single/double quotes. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (escaped) {
    throw new BackendDispatchError('Trailing escape in command string.', 'REMOTE_BACKEND_BAD_COMMAND', 400);
  }
  if (started) tokens.push(current);
  if (quote) {
    throw new BackendDispatchError('Unterminated quote in command string.', 'REMOTE_BACKEND_BAD_COMMAND', 400);
  }
  return tokens;
}

function resolveExecutable(executable: string, registeredCwd: string | undefined): string | null {
  if (isAbsolute(executable)) return executable;
  if (executable.includes('/')) return resolve(registeredCwd ?? process.cwd(), executable);
  return Bun.which(executable, registeredCwd !== undefined ? { cwd: registeredCwd } : undefined);
}

/**
 * Local-process backend: spawns the command directly on the daemon host. This is
 * the lowest-friction backend, used for self-hosted peers. An optional
 * allowlist on backendConfig restricts which executables may run.
 */
export function createLocalProcessBackend(ctx: BackendContext): Backend {
  const lifetime = new BackendLifetime();
  return {
    kind: 'local-process',
    dispatch(
      peer: PeerRecord,
      command: string,
      payload?: DispatchPayload,
    ): Promise<BackendDispatchResult> {
      return lifetime.run(async (signal) => {
        if (peer.backendConfig.kind !== 'local-process') {
          throw new BackendDispatchError(
            `Peer '${peer.peerId}' is not a local-process peer.`,
            'REMOTE_BACKEND_KIND_MISMATCH',
          );
        }
        const config = peer.backendConfig as { kind: 'local-process' } & LocalProcessBackendConfig;
        const tokens = tokenizeCommand(command);
        if (tokens.length === 0 || tokens[0]!.length === 0) {
          throw new BackendDispatchError('Empty command.', 'REMOTE_BACKEND_BAD_COMMAND', 400);
        }
        const executable = tokens[0]!;
        if (config.allowedCommands !== undefined) {
          if (!config.allowedCommands.includes(executable)) {
            throw new BackendDispatchError(
              `Command '${executable}' is not in the peer allowlist.`,
              'REMOTE_BACKEND_COMMAND_DENIED',
              403,
            );
          }
        }
        // The program is found here, from the daemon's own PATH and the
        // registered directory, before the payload's directory or environment
        // apply, so neither can put a different program under an allowed name.
        const program = resolveExecutable(executable, config.cwd);
        if (program === null) {
          throw new BackendDispatchError(`Command '${executable}' was not found on this host.`, 'REMOTE_BACKEND_BAD_COMMAND', 400);
        }
        const args = [program, ...tokens.slice(1), ...(payload?.args ?? [])];
        const cwd = payload?.cwd ?? config.cwd;
        ctx.logger.info('remote local-process dispatch', { peerId: peer.peerId, executable });
        const result = await runProcess({
          args,
          timeoutMs: resolveTimeout(payload),
          signal,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(payload?.env !== undefined ? { env: payload.env } : {}),
          ...(payload?.stdin !== undefined ? { stdin: payload.stdin } : {}),
        });
        return {
          exitCode: result.timedOut ? 124 : result.exitCode,
          stdout: result.stdout,
          stderr: result.timedOut ? `${result.stderr}\n[remote] command timed out` : result.stderr,
        };
      });
    },
    teardown: () => lifetime.close(async () => {}),
  };
}

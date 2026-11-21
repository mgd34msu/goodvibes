/**
 * Which memory store a `goodvibes-agent memory` command (and `import openclaw`)
 * reads and writes, decided once per command and the same for every subcommand.
 *
 * The canonical store has one writer. When the connected host answers, every
 * subcommand runs on the host's store over the wire and this process never
 * opens the file. When it does not answer and the host is this machine, the
 * command opens the local file (the daemon reads the same file when it starts).
 * When the host is another machine and does not answer, a command that writes is
 * refused: storing it here would start a second store the host never sees.
 */
import { isLoopbackHost } from '@goodvibes/engine/platform/platform/utils/reachable-base-url';
import { resolveCanonicalMemoryDbPath, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes/engine/platform/platform/state';
import type { LocalMemoryStore, MemoryAccess } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import { MemorySpineClient, createLocalMemoryAccess } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import { createSessionSpineRestProbe } from '@goodvibes/engine/platform/platform/runtime/session-spine';
import { createSpineConnectionResolver } from '../runtime/session-spine-rest-transport.ts';
import { createMemorySpineRestTransport } from '../runtime/memory-spine-rest-transport.ts';
import { resolveConnectedHostAddress } from '@goodvibes/engine/terminal-shell/agent-turn/connected-host-dial';
import type { CliCommandRuntime } from './management.ts';

/** The label a command prints for the host's store. */
export const WIRE_STORE_LABEL = 'wire:connected-daemon';
const PROBE_TIMEOUT_MS = 800;

export interface MemoryCommandStore {
  readonly access: MemoryAccess;
  /** `wire:connected-daemon`, or the local file's path. */
  readonly label: string;
  /** The local registry, present only when this process holds the file (vector rebuild needs it). */
  readonly local?: MemoryRegistry;
  /** Set when a host is configured on another machine and did not answer: reads come from this machine's file. */
  readonly hostUnanswered?: string;
}

/** Thrown when the store a write needs is not reachable. */
export class MemoryHostUnavailableError extends Error {
  override readonly name = 'MemoryHostUnavailableError';
}

/**
 * The client routes every verb to the transport once one is attached, so the
 * local side is never reached; it fails loudly if that guarantee ever breaks
 * rather than touching a file this process must not write.
 */
function unreachableLocalStore(): LocalMemoryStore {
  const unreachable = (): never => {
    throw new Error('memory: the wire client reached its local side; this process must not open the host-owned store.');
  };
  return {
    add: unreachable, honestSearch: unreachable, get: unreachable, review: unreachable, delete: unreachable,
    search: unreachable, searchSemantic: unreachable, update: unreachable, link: unreachable, linksFor: unreachable,
    reviewQueue: unreachable, exportBundle: unreachable, importBundle: unreachable, vectorStats: unreachable, doctor: unreachable,
  };
}

/** The one loopback rule (parsed, not prefix-matched): a name such as `127.example.test` is another machine. */
function hostIsThisMachine(baseUrl: string): boolean {
  return isLoopbackHost(new URL(baseUrl).hostname);
}

/**
 * Run `fn` against the one store this command uses. `writes` says whether the
 * command changes memory: a local file is saved after it only then, and a
 * write is refused when the configured host is another machine that did not answer.
 */
export async function withMemoryCommandStore<T>(
  runtime: CliCommandRuntime,
  writes: boolean,
  fn: (store: MemoryCommandStore) => Promise<T> | T,
): Promise<T> {
  const resolveConnection = createSpineConnectionResolver(runtime.configManager, runtime.homeDirectory);
  // Without a credential the host's store cannot be used even when it answers, so it is not probed.
  const reachable = resolveConnection().token !== null
    && await createSessionSpineRestProbe({ resolveConnection, probeTimeoutMs: PROBE_TIMEOUT_MS })();
  if (reachable) {
    const transport = createMemorySpineRestTransport({ resolveConnection });
    const access = new MemorySpineClient({ local: createLocalMemoryAccess(unreachableLocalStore()), transport });
    return await fn({ access, label: WIRE_STORE_LABEL });
  }
  const { baseUrl, refusal } = resolveConnectedHostAddress(runtime.configManager);
  const remote = refusal !== null || !hostIsThisMachine(baseUrl);
  if (remote && writes) {
    throw new MemoryHostUnavailableError(refusal
      ? `${refusal} Nothing was stored.`
      : `The connected host ${baseUrl} did not answer; nothing was stored. Start the GoodVibes daemon there or check daemon.connectedHost.url, then rerun the command.`);
  }
  return await withMemory(runtime, async ({ registry, path }) => fn({
    access: createLocalMemoryAccess(registry),
    label: path,
    local: registry,
    ...(remote ? { hostUnanswered: baseUrl } : {}),
  }), { save: writes });
}

/**
 * Open this machine's canonical store, run `fn`, then save only when `save` is
 * set, so a read never writes and a read's answer is never turned into an
 * error by a failed commit.
 */
export async function withMemory<T>(
  runtime: CliCommandRuntime,
  fn: (context: { readonly registry: MemoryRegistry; readonly store: MemoryStore; readonly path: string }) => Promise<T> | T,
  options: { readonly save: boolean } = { save: true },
): Promise<T> {
  const path = resolveCanonicalMemoryDbPath(runtime.homeDirectory);
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager: runtime.configManager });
  const store = new MemoryStore(path, { embeddingRegistry });
  await store.init();
  const registry = new MemoryRegistry(store);
  try {
    return await fn({ registry, store, path });
  } finally {
    try {
      if (options.save) await store.save();
    } finally {
      store.close();
    }
  }
}

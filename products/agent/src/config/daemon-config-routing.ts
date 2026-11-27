/**
 * daemon-config-routing.ts, the agent's single entry point to config
 * ownership routing.
 *
 * Every setting has an OWNER: the runtime that ACTS on it, not the client that
 * edits it. The agent is a CLIENT of the daemon, so:
 *
 *   - a daemon-owned key (all `surfaces.*`, control-plane binding, `watchers.*`,
 *     `device.*`, `automation.*`, `checkin.*`, `integrations.*`, `atRest.*`,
 *     `relay.*`, `voice.local.*`, `danger.httpListener`) is WRITTEN to and READ
 *     from the daemon, live;
 *   - an agent-owned key (rendering, theme, transcript display, `daemon.*`,
 *     `service.*`, `voice.wake.*`) stays in the agent's own settings file;
 *   - a user-level key (`tts.*`, `provider.model`, `provider.reasoningEffort`)
 *     rides the cross-client shared tier.
 *
 * This exists because writing a setting to the wrong store silently costs real
 * behavior: a Telegram bot username written to the agent's own settings file
 * reports success, lands in `~/.goodvibes/agent/settings.json`, and configures
 * nothing, Telegram runs in the daemon, which reads a different file. The
 * same asymmetry runs backwards too: asked to confirm the value, the agent
 * reads its own store, finds it blank, and reports the setting as not set.
 *
 * Ownership itself is defined ONCE, in the platform (`config-ownership.ts`). Nothing
 * in this repo re-derives it, `isDaemonOwnedConfigKey` / `configKeyScope` are
 * re-exported here so callers (including the settings policy guard) share one
 * table rather than maintaining a parallel one that will drift.
 */

import {
  applyConfigWrite,
  configKeyScope,
  createEffectiveConfigView,
  isDaemonOwnedConfigKey,
  isClientOwnedConfigKey,
  isUserLevelConfigKey,
  type ConfigScope,
  type ConfigWriteOutcome,
  type DaemonConfigRouterDeps,
  type EffectiveConfigView,
  type LocalConfigReader,
  type LocalConfigWriter,
  type DaemonWritePress,
} from '@goodvibes/engine/platform/platform/config';
import type { DaemonConfigClient } from '@goodvibes/engine/platform/platform/runtime/client';
import type { DaemonTarget } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target';
import { buildProgramConfigRouting } from '@goodvibes/engine/terminal-shell/program-config-routing';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

export {
  configKeyScope,
  isClientOwnedConfigKey,
  isDaemonOwnedConfigKey,
  isUserLevelConfigKey,
};
export type { ConfigScope, ConfigWriteOutcome, EffectiveConfigView };

// ---------------------------------------------------------------------------
// The connected-host config client
//
// `applyConfigWrite` below discovers the daemon from its own files and dials it
// directly. That worked, and it is a second way to reach a host this process
// already knows how to reach: the client seams all speak one verb route through
// ONE resolved connection (runtime/client/daemon-verbs.ts), and a daemon-owned
// setting is a verb, `config.set`. Installing the client here means the
// settings modal, the settings tool and the harness all write through the same
// connection, with the same refusal text, instead of three discovery paths that
// can disagree about whether a daemon is reachable.
//
// Installed once by the composition root and cleared by its `dispose()`; a
// process that composed no runtime keeps the file-discovery path, which is the
// honest fallback for a one-shot CLI rather than a silent local write. Clearing
// on dispose is what stops one composed runtime from changing the behaviour of
// code that has nothing to do with it.
// ---------------------------------------------------------------------------

let installedConfigClient: DaemonConfigClient | null = null;
let installedConfigClientRevision = 0;
/** Installation incarnation catches replacement and A→B→A without value comparison. */
export function agentDaemonConfigClientRevision(): number { return installedConfigClientRevision; }

/** Install the client daemon-owned config writes route through. */
export function installAgentDaemonConfigClient(client: DaemonConfigClient | null): void {
  installedConfigClientRevision++;
  installedConfigClient = client;
}

/** The installed client, or null when this process composed no runtime. */
export function agentDaemonConfigClient(): DaemonConfigClient | null {
  return installedConfigClient;
}

/** Whether daemon-owned config writes will go over `config.set`. */
export function agentDaemonConfigClientInstalled(): boolean {
  return installedConfigClient !== null;
}

/**
 * Write one daemon-owned setting over `config.set`.
 *
 * Returns `null` when this key is not the daemon's, or when no client is
 * installed, the caller then runs its own local path unchanged. Throws with
 * the refusal reason when the daemon owns the key and could not be reached: a
 * setting that configures nothing must not report success.
 */
export async function routeDaemonOwnedConfigWrite(key: string, value: unknown, press?: DaemonWritePress): Promise<'daemon' | null> {
  const client = installedConfigClient;
  if (!client || !client.ownsKey(key)) return null;
  // Who decided it (the person's press, the Agent's gate on the model's call), from the call site: sent with it.
  await client.set(key, value, press);
  return 'daemon';
}

export interface AgentConfigRoutingOptions {
  /**
   * The home directory the caller's ConfigManager is rooted at. The daemon home
   * is derived from it, so a process running against a non-default home (a
   * test, a second profile) never reaches the machine's real daemon. Only an
   * explicit GOODVIBES_DAEMON_HOME overrides it.
   */
  readonly homeDir?: string | undefined;
  /**
   * The daemon on another machine, as the one daemon target resolver chose it
   * (daemon-target-resolver.ts): its address and the credential bound to it.
   * No local file or runtime record exists to discover such a daemon, and this
   * machine's operator token is never presented to it.
   */
  readonly target?: DaemonTarget | undefined;
  /** Override the daemon home (honors GOODVIBES_DAEMON_HOME by default). */
  readonly daemonHomeDir?: string | undefined;
  /** True only when THIS process hosts the daemon. The agent normally does not. */
  readonly hostsDaemon?: boolean | undefined;
  /** Who decided the write (the person's press, the Agent's gate on the model's call), from the call site: sent with it. */
  readonly press?: DaemonWritePress | undefined;
}

/**
 * Build the routing dependencies for this process. Discovery is deliberately
 * file-free for the VALUE path: the daemon home is consulted only to find where
 * the daemon is listening and which token to present, never to read settings
 * out of the daemon's settings file behind its back.
 */
export function buildAgentConfigRouting(options: AgentConfigRoutingOptions = {}): DaemonConfigRouterDeps {
  // The one routing both terminal programs build (terminal-shell program-config-routing.ts): the daemon's address from
  // its own control-plane binding, this machine's operator token, a named daemon's own credential.
  return buildProgramConfigRouting({
    ...options,
    // READS COME BACK FROM THE HOST THE WRITES WENT TO.
    //
    // `routeConfigWrite` below prefers the installed connected-host client: one
    // already-resolved connection, reached through the runtime's verb route.
    // This leg was left on address discovery, so the two directions resolved the
    // daemon INDEPENDENTLY, and independent resolution is free to disagree.
    //
    // It did. A settings read answered against `http://127.0.0.1:4444`, a port
    // this machine's daemon genuinely used for weeks (installer-era daemon home,
    // daemon versions 1.27.0 through 1.28.4) and had since left, while writes
    // in the SAME process, in the same minutes, reached the live daemon on 3421
    // through the connected client. Every daemon-owned key read back
    // `unavailable` against an address nothing had listened on for days.
    //
    // Discovery's own staleness recovery could not save it: a runtime record is
    // reaped when it does not answer, but the fallback is the control-plane
    // binding in the daemon's config, and that named the same dead port. Both
    // rungs of the ladder were stale together. The connection this process was
    // ALREADY holding knew the right answer the whole time; it was simply never
    // asked. So it is asked first now, and discovery becomes what it should have
    // been all along: the path for a process that holds no connection, not a
    // second opinion for one that does.
    // Presence is decided when the deps are built (it is what makes the route
    // 'daemon' at all), but the CLIENT is resolved when the snapshot is actually
    // taken. A runtime that installs its client after a caller built its routing
    // still answers through it, and one that disposed its client reports an
    // honest "no snapshot" rather than dereferencing a connection that is gone.
    ...(installedConfigClient
      ? { readDaemonSnapshot: async () => await (agentDaemonConfigClient()?.snapshot() ?? null) }
      : {}),
  });
}

/**
 * A synchronous, ownership-aware view over config: daemon-owned keys carry the
 * DAEMON's live value, everything else the agent's own. One daemon round-trip
 * up front, so a settings listing stays a single call.
 *
 * `view.unavailable` names the keys whose live value could not be read. Callers
 * must report those as unknown rather than falling back to a default, a
 * default presented as the current setting is indistinguishable from a lie.
 */
export async function openEffectiveConfigView(
  configManager: LocalConfigReader,
  options: AgentConfigRoutingOptions = {},
): Promise<EffectiveConfigView> {
  return await createEffectiveConfigView(configManager, buildAgentConfigRouting(options));
}

/**
 * Write a config value to whichever runtime owns it.
 *
 * Daemon-owned → the daemon. Agent-owned → the agent's own store. The ONLY
 * failure case is the daemon genuinely being unreachable, and it is reported
 * plainly: the write throws rather than persisting locally and claiming
 * success, because a local write does not reach the runtime that acts on the
 * key.
 */
export async function routeConfigWrite(
  configManager: LocalConfigWriter,
  key: string,
  value: unknown,
  options: AgentConfigRoutingOptions = {},
): Promise<ConfigWriteOutcome> {
  // Prefer the connected-host client when one is installed: one resolved
  // connection, one refusal message, one code path shared with every other
  // client seam. It throws rather than falling back when the daemon owns the
  // key and is unreachable, which is the whole point.
  //
  // Checked SYNCHRONOUSLY, and skipped entirely when nothing is installed. An
  // unconditional `await` here would add a microtask tick to every local write
  //, including the ones a keystroke handler fires and reads back in the same
  // turn, which then read the old value. That is a real ordering change for a
  // path that has no daemon in it at all.
  // The host the write goes to, captured once: the read-back asks the same host.
  const host = agentDaemonConfigClientInstalled() ? agentDaemonConfigClient() : null;
  const routed = host ? await routeDaemonOwnedConfigWrite(key, value, options.press) : null;
  if (routed === 'daemon') {
    logger.debug('[config] routed write over config.set', { key });
    // The write is already applied; a failed read-back must not turn it into a reported failure.
    let readBack: unknown;
    try {
      readBack = await host?.get(key);
    } catch (error) {
      logger.warn('[config] daemon applied config.set but the read-back failed', { key, error: summarizeError(error) });
    }
    return {
      key,
      scope: 'daemon',
      appliedBy: 'daemon',
      persistedTo: 'the connected host\'s own settings',
      // The value the owning runtime holds after the write. Read back rather
      // than echoed: the daemon may coerce or clamp what it was sent, and
      // reporting what we asked for would describe a value nobody holds. An
      // unreadable value is reported as unknown, never as the value sent.
      value: readBack,
      reason: readBack === undefined
        ? 'applied by the connected host over config.set; the value it holds now is unknown because reading it back failed'
        : 'applied by the connected host over config.set',
    };
  }
  const outcome = await applyConfigWrite(key, value, configManager, buildAgentConfigRouting(options));
  logger.debug('[config] routed write by ownership', {
    key,
    scope: outcome.scope,
    appliedBy: outcome.appliedBy,
    persistedTo: outcome.persistedTo,
  });
  return outcome;
}

/** One-line description of where a key lives, for tool output and help text. */
export function describeConfigStore(outcome: ConfigWriteOutcome): string {
  return outcome.appliedBy === 'daemon'
    ? `Applied by the daemon and stored in ${outcome.persistedTo}; it takes effect for every client.`
    : `Stored in ${outcome.persistedTo}.`;
}

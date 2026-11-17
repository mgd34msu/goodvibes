/**
 * What each built-in surface can be SEEN to be doing.
 *
 * Split by how the surface actually receives, because that is what decides
 * whether liveness is knowable at all:
 *
 * - Telegram runs a supervisor on this node, which already tracks its own mode
 *   and the named reason it is not receiving. That supervisor's status is the
 *   answer to "is Telegram working", and until this file existed nothing read
 *   it, `BuiltinChannelRuntime.telegramIngressStatus()` had no caller while
 *   the reported state was computed from the token's presence instead.
 * - Slack, Discord and ntfy hold a long-lived connection managed by
 *   `ChannelProviderRuntimeManager`, which knows whether it is up and what
 *   last broke it.
 * - Every other built-in surface receives by having an HTTP route registered
 *   and waiting to be called. Nothing on this node distinguishes "the provider
 *   is delivering" from "the provider stopped delivering", so those surfaces
 *   report `unknown` and say that configuration is all they know.
 */
import type { ProviderRuntimeStatus, ProviderRuntimeSurface } from '../provider-runtime.js';
import type { TelegramIngressStatus } from '../telegram/ingress.js';
import { observedRuntime, resolveChannelHealthState, unobservableRuntime } from '../health.js';
import type {
  ChannelAccountRecord,
  ChannelAccountState,
  ChannelAuthState,
  ChannelHealthState,
  ChannelRuntimeObservation,
  ChannelSecretStatus,
  ChannelStatusSnapshot,
  ChannelSurface,
} from '../types.js';
import { builtinSendCredentials } from './setup-schema.js';

/**
 * Surfaces whose inbound path is a webhook this daemon merely registers.
 *
 * Kept as a predicate over the surface rather than a list of names so a surface
 * added later is unobservable by default, the safe direction. A new surface
 * that CAN be observed has to say so by getting its own branch in
 * `observeBuiltinRuntime`, which is a change a reader will notice.
 */
function describeUnobservableSurface(surface: ChannelSurface): string {
  return `nothing on this node watches ${surface}: it receives through a registered webhook, so a provider that `
    + 'stopped delivering looks exactly like a quiet one. Configuration is all this status knows.';
}

/**
 * Telegram's supervisor state, read as health.
 *
 * `running` is false in webhook mode by design, the supervisor runs no loop
 * once Telegram has been told where to POST, so mode, not the loop flag,
 * decides. Reading the flag alone would report a correctly armed webhook as
 * dead, which is the same class of wrong answer in the other direction.
 *
 * `status.lastError` is carried into every RUNNING branch, and that is the
 * whole point of it. A poll loop can be turning over perfectly while every
 * update it hands on fails to be processed, which is precisely what happened:
 * mode 'polling', running true, reason "long-polling", reported healthy, and
 * every message the owner sent was being skipped. Running is not the same
 * question as working, so a supervisor that is receiving but not processing now
 * reports `degraded` with the reason attached.
 */
export function observeTelegramRuntime(status: TelegramIngressStatus | null): ChannelRuntimeObservation {
  if (!status) {
    return observedRuntime(
      false,
      'Telegram ingress has not been started on this node, so no message can arrive. '
      + 'The daemon arms it at startup; if it is enabled and this persists, the composition root never called startIngress().',
    );
  }
  if (status.mode === 'webhook') {
    return observedRuntime(true, status.reason, status.lastError);
  }
  if (status.mode === 'polling') {
    return status.running
      ? observedRuntime(true, status.reason, status.lastError)
      : observedRuntime(false, `Telegram polling is not running: ${status.reason}`, status.lastError);
  }
  return observedRuntime(false, status.reason, status.lastError);
}

/**
 * A provider connection this node holds open.
 *
 * A host that wired no provider runtime at all gets `unknown`, not `dead`: the
 * connection is not down, it is unwatched, and those are different sentences.
 */
export function observeProviderRuntime(
  surface: ProviderRuntimeSurface,
  status: ProviderRuntimeStatus | null,
  processingFailure?: string | undefined,
): ChannelRuntimeObservation {
  if (!status) {
    return unobservableRuntime(
      `no provider runtime is wired into this host, so the ${surface} connection is unwatched. `
      + 'Configuration is all this status knows.',
    );
  }
  if (!status.configured && !status.running) {
    // A surface served by webhook has no socket to watch; "no connection" is
    // its normal state, and calling it dead would alarm the owner for nothing.
    return unobservableRuntime(`no socket is configured for ${surface}; inbound arrives by webhook`);
  }
  if (status.running) {
    // An open connection whose messages are being skipped is not working: the
    // owner has already been told the surface is degraded, and status must not
    // say otherwise.
    return observedRuntime(
      true,
      `the ${surface} ${status.transport} connection is open`,
      status.lastError ?? processingFailure,
    );
  }
  return observedRuntime(
    false,
    status.lastError
      ? `the ${surface} ${status.transport} connection is not running: ${status.lastError}`
      : `the ${surface} ${status.transport} connection is not running, so nothing inbound is being read`,
    status.lastError,
  );
}

export interface BuiltinRuntimeObservers {
  /** The Telegram supervisor's current state, or null when it was never built. */
  readonly telegramIngressStatus: () => TelegramIngressStatus | null;
  /** The provider connection manager's state, or null when none is wired. */
  readonly providerRuntimeStatus: (surface: ProviderRuntimeSurface) => ProviderRuntimeStatus | null;
  /** The live run of skipped inbound messages for a surface, if any. */
  readonly processingFailure?: ((surface: ChannelSurface) => string | undefined) | undefined;
  /** When a surface whose processing had failed last processed a message, if it did. */
  readonly processingRecoveredAt?: ((surface: ChannelSurface) => number | undefined) | undefined;
  /**
   * Whether this node is the one meant to read `surface`. Absent means it is:
   * without clustering every node reads everything it is configured for.
   */
  readonly isResponsible?: ((surface: ChannelSurface) => boolean) | undefined;
}

/** The live observation for one built-in surface. */
export function observeBuiltinRuntime(
  observers: BuiltinRuntimeObservers,
  surface: ChannelSurface,
): ChannelRuntimeObservation {
  const received = surface === 'telegram' || surface === 'slack' || surface === 'discord' || surface === 'ntfy';
  if (received && observers.isResponsible && !observers.isResponsible(surface)) {
    // A standby is not reading by design. Calling that dead would have every
    // standby in a cluster alarm the owner about a surface a peer is serving.
    return unobservableRuntime(
      `another node in the cluster is responsible for ${surface}; this node is standing by and does not read it. `
      + 'Ask the node that holds it for its state.',
    );
  }
  if (surface === 'telegram') return observeTelegramRuntime(observers.telegramIngressStatus());
  if (surface === 'slack' || surface === 'discord' || surface === 'ntfy') {
    return observeProviderRuntime(surface, observers.providerRuntimeStatus(surface), observers.processingFailure?.(surface));
  }
  if (surface === 'tui') {
    return observedRuntime(true, 'the terminal surface is served in this process; it has no remote path that can fail');
  }
  if (surface === 'web') {
    return unobservableRuntime(
      'nothing here confirms the control-plane listener is accepting connections; web.enabled reflects '
      + 'configuration only. Configuration is all this status knows.',
    );
  }
  // A webhook surface is otherwise unwatched, but a message it delivered that
  // could not be processed is seen here, and so is the next one that was.
  const failure = observers.processingFailure?.(surface);
  if (failure) {
    return observedRuntime(true, `${surface} is delivering messages by webhook, but they are not being processed`, failure);
  }
  if (observers.processingRecoveredAt?.(surface) !== undefined) {
    return observedRuntime(true, `the last message that arrived on ${surface} was processed`);
  }
  return unobservableRuntime(describeUnobservableSurface(surface));
}

export interface BuiltinSnapshotInput {
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly enabled: boolean;
  /** The account record, read for credential presence, never for health. */
  readonly account: ChannelAccountRecord;
  readonly runtime: ChannelRuntimeObservation;
  readonly metadata: Record<string, unknown>;
}

/** What a surface's credentials say about whether it can send, by the setup schema's rule. */
export interface BuiltinCredentialFacts {
  /** The credentials the surface needs to send are declared (or it needs none and has its settings). */
  readonly declared: boolean;
  /** Those credentials resolve in the store this process reads. */
  readonly resolves: boolean;
  /** Declared credentials that resolve to nothing here. */
  readonly unresolved: readonly ChannelSecretStatus[];
}

/** The account fields the credential rule reads. */
export type BuiltinCredentialAccount = Pick<ChannelAccountRecord, 'surface' | 'configured' | 'secrets' | 'metadata'>;

/**
 * Read the account's credentials against `builtinSendCredentials`, the setup
 * schema's statement of what the surface needs to send. A surface that needs
 * none is declared when its settings are (an ntfy topic), and resolves unless
 * a credential it does carry points at nothing.
 */
export function builtinCredentialFacts(account: BuiltinCredentialAccount): BuiltinCredentialFacts {
  const unresolved = account.secrets.filter((secret) => secret.configured && secret.resolved === false);
  const alternatives = builtinSendCredentials(account.surface, {
    provider: account.metadata['provider'],
    mode: account.metadata['mode'],
  });
  if (alternatives.length === 0) {
    return { declared: account.configured, resolves: unresolved.length === 0, unresolved };
  }
  const byField = new Map(account.secrets.map((secret) => [secret.field, secret]));
  const declared = alternatives.some((fields) => fields.every((field) => byField.get(field)?.configured === true));
  const resolves = alternatives.some((fields) => fields.every((field) => {
    const secret = byField.get(field);
    return secret !== undefined && (secret.resolved ?? secret.configured);
  }));
  return { declared, resolves, unresolved };
}

/** The account's posture, read off the one health answer rather than decided again. */
export function accountStateForHealth(state: ChannelHealthState): ChannelAccountState {
  switch (state) {
    case 'healthy':
    case 'unknown':
      return 'healthy';
    case 'degraded':
    case 'dead':
    case 'unresolved':
      return 'degraded';
    case 'unconfigured':
      return 'unconfigured';
    case 'disabled':
      return 'disabled';
  }
}

/** The credential posture, from the same facts the health answer used. */
export function authStateForCredentials(facts: BuiltinCredentialFacts, enabled: boolean): ChannelAuthState {
  if (!facts.declared) return 'not-configured';
  if (facts.resolves) return 'linked';
  return enabled ? 'degraded' : 'configured';
}

/** The health answer for an account, the rule `buildBuiltinStatusSnapshot` applies. */
export function builtinHealthState(
  account: BuiltinCredentialAccount,
  enabled: boolean,
  runtime: ChannelRuntimeObservation,
): { readonly state: ChannelHealthState; readonly facts: BuiltinCredentialFacts } {
  const facts = builtinCredentialFacts(account);
  return {
    facts,
    state: resolveChannelHealthState({ enabled, configured: facts.declared, credentialResolves: facts.resolves, runtime }),
  };
}

/**
 * Say which fields are declared and do not resolve, so the reported reason
 * names the setting to fix instead of the symptom.
 */
function describeUnresolvedCredentials(account: ChannelAccountRecord, facts: BuiltinCredentialFacts): string {
  const fields = facts.unresolved.map((secret) => secret.label);
  const named = fields.length > 0 ? fields.join(', ') : 'its credential';
  return `${account.label} is configured but cannot send: ${named} names a secret that does not resolve in the store `
    + 'this process reads. A goodvibes://secrets/... reference pointing at a key held in another surface\'s store '
    + '(or an empty store) reads as configured and delivers nothing. Put the secret in THIS surface\'s store, or '
    + 'point the setting at one that resolves here.';
}

/** One snapshot, built the same way for every built-in surface. */
export function buildBuiltinStatusSnapshot(input: BuiltinSnapshotInput): ChannelStatusSnapshot {
  const { state, facts } = builtinHealthState(input.account, input.enabled, input.runtime);
  // An unresolvable credential IS an observation, we looked in the store and
  // the secret was not there, so it replaces the live-path reason rather than
  // leaving the reader with "nothing watches this surface" as the account of a
  // channel that provably cannot send.
  const runtime = state === 'unresolved'
    ? observedRuntime(false, describeUnresolvedCredentials(input.account, facts))
    : input.runtime;
  return {
    id: `surface:${input.surface}`,
    surface: input.surface,
    label: input.label,
    state,
    enabled: input.enabled,
    configured: facts.declared,
    credentialResolves: facts.resolves,
    runtime,
    ...(input.account.accountId ? { accountId: input.account.accountId } : {}),
    metadata: input.metadata,
  };
}

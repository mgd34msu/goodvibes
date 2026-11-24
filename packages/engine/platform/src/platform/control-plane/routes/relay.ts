/**
 * routes/relay.ts, the handlers behind `relay.reachability.get`,
 * `relay.pairing.mint` and the per-device relay codes (`relay.codes.list`,
 * `relay.codes.revoke`).
 *
 * Both read the SAME controller the facade's `getRelayReachability()` hands
 * back, so an in-process surface and a client over the wire cannot disagree
 * about whether the relay is up. The controller is composed at start and torn
 * down at stop, so it is genuinely absent some of the time; absence is reported
 * as `disabled`, which is what a daemon with no relay controller is.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import type { RelayCodeStore } from '../../relay/relay-codes.js';
import { pairingTokenIdOfPrincipal } from '../../pairing/principal-ids.js';
import { AuthorityRecordUnavailableError } from '../../cluster/authority-record-file.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { describeRelayStatus } from '../../relay/status-words.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';

/** The controller surface these verbs need, declared rather than imported whole. */
export interface RelayReachabilityService {
  readonly status: string;
  /** The rendezvous id the live registration is registered under, or null when none is running. */
  readonly rendezvousId?: string | null | undefined;
  /** The relay's last refusal of the registration, with what is true and what to do. */
  readonly lastRefusal?: RelayRefusalReading | null | undefined;
  /** A pairing payload carrying `code`, or null when there is no live registration. */
  mintPairing(code: string): Promise<unknown>;
  /** End every relay connection that presented a code `revoked` answers true for. */
  closeConnectionsPresenting?(revoked: (code: string) => boolean, reason: string): Promise<number>;
  /** Be told each time `status` may have changed; returns the unsubscribe. */
  onStatusChange?(listener: () => void): () => void;
  /** The relay address in `relay.url` now. */
  readonly relayUrl?: string | undefined;
}

/** The status in plain words, with the relay's address. */
function wordsOf(service: RelayReachabilityService | null): string {
  return describeRelayStatus(statusOf(service), service?.relayUrl ?? '', service?.lastRefusal ?? null);
}

/**
 * Turns the relay on for this daemon (`relay.enabled`, which also backs the
 * relay-connect capability, and `relay.url` when given): the owner's yes to
 * letting devices reach this machine through the relay. Answers false, and
 * changes nothing, when no relay address is set and none was given.
 */
export type RelayTurnOn = (url: string | undefined) => boolean;

/** The statuses a registration rests in: a pairing is minted, or refused with the reason, once one is reached. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set(['registered', 'refused', 'failed', 'disabled', 'stopped']);

/**
 * The registration's status once it rests: at once when it already does,
 * else at the first status change that rests (the host's own answer), or the
 * caller leaving. No timer.
 */
function settledStatus(accessor: RelayReachabilityAccessor, signal: AbortSignal | undefined): Promise<string> {
  const current = (): string => statusOf(accessor());
  const service = accessor();
  if (SETTLED_STATUSES.has(current()) || !service?.onStatusChange) return Promise.resolve(current());
  return new Promise<string>((resolve, reject) => {
    const finish = (): void => {
      unsubscribe();
      signal?.removeEventListener('abort', leave);
    };
    const leave = (): void => { finish(); reject(signal?.reason instanceof Error ? signal.reason : new Error('The pairing request was cancelled.')); };
    const unsubscribe = service.onStatusChange!(() => {
      if (SETTLED_STATUSES.has(current())) { finish(); resolve(current()); }
    });
    if (signal?.aborted) { leave(); return; }
    signal?.addEventListener('abort', leave, { once: true });
    if (SETTLED_STATUSES.has(current())) { finish(); resolve(current()); }
  });
}

function readTurnOn(params: Record<string, unknown>): { readonly turnOn: boolean; readonly url: string | undefined } {
  const turnOn = params.turnOn;
  if (turnOn !== undefined && typeof turnOn !== 'boolean') throw new GatewayVerbError('turnOn must be true or false', 'INVALID_ARGUMENT', 400, 'turnOn');
  const url = params.url;
  if (url !== undefined && typeof url !== 'string') throw new GatewayVerbError('url must be a string', 'INVALID_ARGUMENT', 400, 'url');
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (trimmed.length > 0 && !/^wss?:\/\//i.test(trimmed)) {
    throw new GatewayVerbError('url must be the relay\'s wss:// address', 'INVALID_ARGUMENT', 400, 'url');
  }
  return { turnOn: turnOn === true, url: trimmed.length > 0 ? trimmed : undefined };
}

/** A relay refusal as the verbs report it. */
export interface RelayRefusalReading {
  readonly code: string;
  readonly message: string;
  readonly state: string;
  readonly next: readonly string[];
  readonly retryable: boolean;
}

/**
 * How the verbs reach the controller. A FUNCTION, not the controller itself:
 * the daemon builds one at start and drops it at stop, so a handler holding the
 * instance would keep answering for a relay that is no longer running.
 */
export type RelayReachabilityAccessor = () => RelayReachabilityService | null;

/** All three gates open. `disabled` is the controller's word for "one is not". */
function isConfigured(service: RelayReachabilityService | null): boolean {
  return service !== null && service.status !== 'disabled';
}

function statusOf(service: RelayReachabilityService | null): string {
  return service?.status ?? 'disabled';
}

export function createRelayReachabilityHandler(accessor: RelayReachabilityAccessor): GatewayMethodHandler {
  return () => {
    const service = accessor();
    const refusal = service?.lastRefusal ?? null;
    const rendezvousId = service?.rendezvousId ?? null;
    return {
      status: statusOf(service),
      configured: isConfigured(service),
      words: wordsOf(service),
      ...(service?.relayUrl ? { relayUrl: service.relayUrl } : {}),
      ...(rendezvousId ? { rendezvousId } : {}),
      ...(refusal ? { refusal: { code: refusal.code, message: refusal.message, state: refusal.state, next: [...refusal.next], retryable: refusal.retryable } } : {}),
    };
  };
}

/** The relay codes the verbs issue, list and revoke (relay/relay-codes.ts). */
export type RelayCodes = Pick<RelayCodeStore, 'mint' | 'list' | 'revoke' | 'holds'>;

function optionalName(params: Record<string, unknown>): string | undefined {
  const raw = params.name;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new GatewayVerbError('name must be a string', 'INVALID_ARGUMENT', 400);
  return raw;
}

export function createRelayPairingMintHandler(accessor: RelayReachabilityAccessor, codes: RelayCodes, turnOnRelay?: RelayTurnOn): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const name = optionalName(params);
    const { turnOn, url } = readTurnOn(params);
    // The owner's yes, asked by the caller: the relay is turned on here, and the
    // pairing below waits for the registration that follows.
    if (turnOn && statusOf(accessor()) === 'disabled') {
      if (!turnOnRelay) throw new GatewayVerbError('This daemon cannot turn its relay on from a call', 'UNAVAILABLE', 409);
      if (!turnOnRelay(url)) {
        throw new GatewayVerbError('No relay address is set on this daemon, so the relay was not turned on; send the relay\'s wss:// address as url', 'RELAY_URL_REQUIRED', 400, 'url');
      }
    }
    // A registration on its way (idle, connecting, reconnecting) is waited for:
    // the host's own answer, registered or refused, decides the pairing.
    await settledStatus(accessor, invocation.signal);
    const service = accessor();
    // Null rather than a refusal, and the status alongside it: "there is
    // nothing to pair against" is an answer a caller renders, and the status
    // says why (turned off, refused, failed).
    if (!service) return { pairing: null, status: statusOf(service), words: wordsOf(service) };
    // Each pairing carries a relay code of its own, so one device's relay
    // access can be revoked without touching any other's.
    // A paired device asking for its own relay code: revoking that device revokes the code with it.
    const deviceTokenId = pairingTokenIdOfPrincipal(invocation.context.principalId);
    let minted: Awaited<ReturnType<RelayCodes['mint']>>;
    try { minted = await codes.mint(name, deviceTokenId); }
    catch (error) {
      const status = (error as { status?: unknown }).status;
      if (status === 409) throw new GatewayVerbError((error as Error).message, 'RELAY_CODE_LIMIT', 409);
      if (error instanceof AuthorityRecordUnavailableError) {
        throw new GatewayVerbError(`The authority record could not be read, so no relay code was issued and nothing was paired. ${error.message}`, 'AUTHORITY_RECORD_UNAVAILABLE', 503);
      }
      throw error;
    }
    // The code is withdrawn on every path that does not hand it to the caller, so no unused code is left listed.
    let pairing: unknown;
    try { pairing = (await service.mintPairing(minted.code)) ?? null; }
    catch (error) {
      await withdrawMinted(codes, minted.id);
      throw error;
    }
    // No live registration to pair against.
    if (pairing === null) await withdrawMinted(codes, minted.id);
    return { pairing, status: statusOf(service), words: wordsOf(service), ...(pairing !== null ? { codeId: minted.id, codeName: minted.name } : {}) };
  };
}

/** Withdraw a code minted for a pairing that was not handed out; a failed withdrawal is logged, the code was never seen. */
async function withdrawMinted(codes: RelayCodes, id: string): Promise<void> {
  try { await codes.revoke(id); }
  catch (error) { logger.warn('A relay code minted for a pairing that was not handed out could not be withdrawn', { id, error: summarizeError(error) }); }
}

export function createRelayCodesListHandler(codes: RelayCodes): GatewayMethodHandler {
  return () => ({ codes: codes.list() });
}

export function createRelayCodeRevokeHandler(codes: RelayCodes, accessor?: RelayReachabilityAccessor): GatewayMethodHandler {
  return async (invocation) => {
    const id = requireStringValue(readInvocationParams(invocation).id, 'id');
    let revoked = false;
    let failure: unknown;
    try { revoked = await codes.revoke(id); }
    catch (error) { failure = error; }
    // Every connection a code no longer held opened ends now, even when the revoke's save failed:
    // its streams get their close, its requests stop.
    const closedConnections = await accessor?.()?.closeConnectionsPresenting?.((code) => !codes.holds(code), 'relay-code-revoked') ?? 0;
    if (failure !== undefined) {
      const coded = failure as { code?: unknown; status?: unknown };
      throw new GatewayVerbError(`${failure instanceof Error ? failure.message : String(failure)} ${closedConnections} relay connection(s) were closed.`,
        typeof coded.code === 'string' ? coded.code : 'RELAY_CODE_REVOKE_FAILED', typeof coded.status === 'number' ? coded.status : 500);
    }
    if (!revoked) throw new GatewayVerbError('Unknown relay code', 'RELAY_CODE_NOT_FOUND', 404);
    return { id, revoked: true, closedConnections };
  };
}

/** Every verb this module owns. */
export const RELAY_METHOD_IDS: readonly string[] = ['relay.reachability.get', 'relay.pairing.mint', 'relay.codes.list', 'relay.codes.revoke'];

export function registerRelayGatewayMethods(
  catalog: GatewayMethodCatalog,
  accessor: RelayReachabilityAccessor,
  codes: RelayCodes,
  turnOnRelay?: RelayTurnOn,
): void {
  const handlers: Readonly<Record<string, GatewayMethodHandler>> = {
    'relay.reachability.get': createRelayReachabilityHandler(accessor),
    'relay.pairing.mint': createRelayPairingMintHandler(accessor, codes, turnOnRelay),
    'relay.codes.list': createRelayCodesListHandler(codes),
    'relay.codes.revoke': createRelayCodeRevokeHandler(codes, accessor),
  };
  for (const id of RELAY_METHOD_IDS) {
    const descriptor = catalog.get(id);
    const handler = handlers[id];
    if (descriptor && handler) catalog.register(descriptor, handler, { replace: true });
  }
}

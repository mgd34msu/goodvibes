import { createRequestReceiptTable, servingIdOf } from './single-use-reference-table.js';

/**
 * One request writes one setting. The caller sends the key, the value and the
 * settings revision it last saw (`ifIncarnation`, with `ifServing`, the id of
 * the daemon serving period it was read in, since a restarted daemon counts
 * revisions again); the owner refuses when either moved, otherwise it writes
 * and answers with what the write touched and a receipt. A `requestId` makes the request safe to send
 * again: a repeat is answered with the first answer and never writes twice.
 *
 * `capture` is the read half for a caller that must show the effect before
 * deciding (the agent's settings tool): it answers the same facts, including
 * the revision to send back, and holds nothing on the daemon.
 */
export interface SettingsPreconditionRequest {
  readonly operation: 'set' | 'reset-default';
  readonly key: string;
  readonly value?: unknown;
  /** Remove only this setting's derived credential in its owning scope. */
  readonly credentialClear?: true;
}
export interface SettingsPreconditionFacts extends SettingsPreconditionRequest {
  readonly value: unknown;
  readonly destinations: readonly { readonly path: string; readonly operation: 'set' | 'remove'; readonly tier: string }[];
  readonly incarnation: number;
  readonly credential?: {
    readonly key: string;
    readonly scope: 'daemon' | 'user';
    readonly destinations: readonly { readonly path: string; readonly operation: 'remove'; readonly tier: string }[];
  };
}
export interface SettingsPreconditionReceipt {
  readonly status: 'committed' | 'partial' | 'unknown';
  readonly completedPaths: readonly string[];
  readonly uncertainPath?: string;
  /** Reporting only, required on committed wire receipts. Failure never undoes publication. */
  readonly verifiedInOwningStore?: boolean;
  /**
   * Client-side only, never on the wire: set on an `unknown` receipt when the
   * owner answered with a precondition refusal, which every handler returns
   * before any effect. Nothing was applied; a fresh capture may try again.
   */
  readonly refused?: true;
  /** Client-side only: why the owner refused (see {@link SettingsRefusalReason}); present only with `refused`. */
  readonly refusalReason?: SettingsRefusalReason;
}
/**
 * Value-free reason on a refusal that happened before any effect, so a caller can
 * choose its next step without parsing text:
 * - `stale`: the settings moved since the caller read them (or the serving owner changed); read again and resend.
 * - `spent`: this capture was already used; capture again, do not resend it.
 * - `managed`: managed policy locks the setting; stop, only the policy owner can change it.
 * - `read-only`: the settings owner is read-only here; stop, or use a writable owner.
 * - `owner-fault`: an owner store (pairing store, configuration lock) is faulted or busy; see the message; retry only for a busy lock.
 */
export type SettingsRefusalReason = 'stale' | 'spent' | 'managed' | 'read-only' | 'owner-fault';
export const SETTINGS_REFUSAL_REASONS: readonly SettingsRefusalReason[] = ['stale', 'spent', 'managed', 'read-only', 'owner-fault'];
/** The reason an owner error carries (`refusalReason`), or `owner-fault` for a faulted pairing store. */
export function settingsRefusalReason(error: unknown): SettingsRefusalReason | undefined {
  if (isPairingStoreFault(error)) return 'owner-fault';
  const reason = error instanceof Error ? (error as Error & { readonly refusalReason?: unknown }).refusalReason : undefined;
  return SETTINGS_REFUSAL_REASONS.find(known => known === reason);
}
export interface SettingsPreconditionHandler {
  /** Read before the body await, so a stop or rebind during the read is seen. */
  lifetime(): object | null;
  handle(req: Request, payload: Record<string, unknown>, requestLifetime: object | null): Response | Promise<Response>;
}
interface Options<Prepared, Transition, Authority> {
  readonly owner: {
    prepare(request: SettingsPreconditionRequest): Prepared;
    inspect(prepared: Prepared): SettingsPreconditionFacts;
    assert(prepared: Prepared): void;
    begin(prepared: Prepared): Transition;
    assertTransition(prepared: Prepared, transition: Transition): void;
    finish(prepared: Prepared, transition: Transition, assertCurrent: () => void): SettingsPreconditionReceipt;
    /** Acquire physical ownership before entering the synchronous auth/effect tail. */
    withPrepared?<T>(prepared: Prepared, operation: () => T): Promise<T>;
  };
  readonly lifetime: () => object | null;
  readonly captureAuthority: (req: Request) => Authority | null;
  readonly withAuthority: <T>(req: Request, authority: Authority, callback: (assertCurrent: () => void) => T) => T;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every(key => fields.includes(key));
}
/** The daemon's pairing store is faulted: a retry of the same request will not help until it recovers. */
export function isPairingStoreFault(error: unknown): boolean {
  return error instanceof Error && (error as Error & { readonly code?: unknown }).code === 'PAIRING_STORE_FAULTED';
}

interface Answer { readonly status: number; readonly body: Record<string, unknown> }
function answer(status: number, body: Record<string, unknown>): Answer { return { status, body }; }
function refusal(status: number, code: string, reason?: SettingsRefusalReason, extra: Record<string, unknown> = {}): Answer {
  // Never echo body, normalized values, credentials, paths or owner errors.
  return answer(status, { error: 'Settings owner precondition unavailable', code, ...(reason ? { reason } : {}), ...extra });
}
function staleIncarnation(current: number, serving: string): Answer {
  return refusal(409, 'SETTINGS_PRECONDITION_STALE', 'stale', {
    state: 'the setting is unchanged; the settings moved since the caller read them',
    next: ['Read the setting again and resend the change with the new ifIncarnation and ifServing'],
    currentIncarnation: current, serving,
  });
}
function respond(result: Answer): Response { return Response.json(result.body, { status: result.status }); }

/** The validated request in a `capture` or `write` arm, or undefined when the arm is malformed. */
function readRequest(arm: Record<string, unknown>, extra: readonly string[]): SettingsPreconditionRequest | undefined {
  const fields = [...(arm.operation === 'set' ? ['version', 'action', 'operation', 'key', 'value'] : ['version', 'action', 'operation', 'key']), ...extra];
  if (Object.hasOwn(arm, 'credentialClear')) fields.push('credentialClear');
  if (!exact(arm, fields) || (Object.hasOwn(arm, 'credentialClear') && arm.credentialClear !== true)
    || (arm.operation !== 'set' && arm.operation !== 'reset-default')
    || typeof arm.key !== 'string' || !arm.key || arm.key === 'runtime.workingDir') return undefined;
  return { operation: arm.operation, key: arm.key, ...(arm.operation === 'set' ? { value: arm.value } : {}),
    ...(arm.credentialClear === true ? { credentialClear: true as const } : {}) };
}

export function createSettingsPreconditionHandler<Prepared, Transition, Authority>(
  options: Options<Prepared, Transition, Authority>,
): SettingsPreconditionHandler {
  const answered = createRequestReceiptTable<Answer>();

  const capture = (request: SettingsPreconditionRequest, requestLifetime: object | null): Answer => {
    const lifetime = options.lifetime();
    if (lifetime === null || lifetime !== requestLifetime) return refusal(409, 'SETTINGS_PRECONDITION_STALE', 'stale');
    try {
      const prepared = options.owner.prepare(request);
      const facts = options.owner.inspect(prepared);
      // A locked or read-only setting is refused here, before the caller decides.
      options.owner.assert(prepared);
      return answer(200, { settingsPrecondition: { version: 1, action: 'captured', facts, serving: servingIdOf(lifetime) } });
    } catch (error) { return refusal(409, isPairingStoreFault(error) ? 'PAIRING_STORE_FAULTED' : 'SETTINGS_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error)); }
  };

  const write = async (req: Request, request: SettingsPreconditionRequest, expected: { readonly incarnation?: number; readonly serving?: string },
    requestId: string | undefined, requestLifetime: object | null): Promise<Answer> => {
    const lifetime = options.lifetime();
    if (lifetime === null || lifetime !== requestLifetime) return refusal(409, 'SETTINGS_PRECONDITION_STALE', 'stale');
    const serving = servingIdOf(lifetime);
    let prepared: Prepared; let facts: SettingsPreconditionFacts; let authority: Authority | null;
    try {
      prepared = options.owner.prepare(request);
      facts = options.owner.inspect(prepared);
      if ((expected.serving !== undefined && expected.serving !== serving)
        || (expected.incarnation !== undefined && facts.incarnation !== expected.incarnation)) return staleIncarnation(facts.incarnation, serving);
      authority = options.captureAuthority(req);
    } catch (error) { return refusal(409, isPairingStoreFault(error) ? 'PAIRING_STORE_FAULTED' : 'SETTINGS_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error)); }
    if (authority === null) return refusal(409, 'SETTINGS_PRECONDITION_STALE', 'stale');
    const held = authority;
    const apply = (): Answer => {
      // Everything from here to the write is synchronous: one owner check (it
      // also covers the lock await in withPrepared), and one authority and
      // transition check after begin, whose validators run callbacks.
      const receipt = options.withAuthority(req, held, (assertCurrent) => {
        options.owner.assert(prepared);
        const transition = options.owner.begin(prepared);
        assertCurrent();
        options.owner.assertTransition(prepared, transition);
        return options.owner.finish(prepared, transition, assertCurrent);
      });
      // Only the physical owner's receipt is acknowledged; nothing after the effect can turn it into a refusal.
      return answer(200, { settingsPrecondition: { version: 1, action: 'written', ...(requestId ? { requestId } : {}), facts, serving, receipt } });
    };
    try {
      return options.owner.withPrepared ? await options.owner.withPrepared(prepared, apply) : apply();
    } catch (error) { return refusal(409, 'SETTINGS_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error)); }
  };

  return {
    lifetime: options.lifetime,
    handle(req, payload, requestLifetime) {
      const arm = payload.settingsPrecondition;
      if (!exact(payload, ['settingsPrecondition']) || !record(arm) || arm.version !== 1) {
        return respond(refusal(400, 'SETTINGS_PRECONDITION_INVALID'));
      }
      if (arm.action === 'capture') {
        const request = readRequest(arm, []);
        return respond(request ? capture(request, requestLifetime) : refusal(400, 'SETTINGS_PRECONDITION_INVALID'));
      }
      if (arm.action !== 'write') return respond(refusal(400, 'SETTINGS_PRECONDITION_INVALID'));
      const extra = ['ifIncarnation', 'ifServing', 'requestId'].filter(field => Object.hasOwn(arm, field));
      const request = readRequest(arm, extra);
      const { ifIncarnation, ifServing, requestId } = arm;
      if (!request || (ifIncarnation !== undefined && (!Number.isSafeInteger(ifIncarnation) || Number(ifIncarnation) < 0))
        || (ifServing !== undefined && (typeof ifServing !== 'string' || !ifServing || ifServing.length > 128))
        || (requestId !== undefined && (typeof requestId !== 'string' || !requestId || requestId.length > 128))) {
        return respond(refusal(400, 'SETTINGS_PRECONDITION_INVALID'));
      }
      const expected = { ...(ifIncarnation !== undefined ? { incarnation: Number(ifIncarnation) } : {}),
        ...(typeof ifServing === 'string' ? { serving: ifServing } : {}) };
      const run = () => write(req, request, expected, typeof requestId === 'string' ? requestId : undefined, requestLifetime);
      if (typeof requestId !== 'string') return run().then(respond);
      const remembered = answered.answer(requestId, `${request.operation}\u0000${request.key}`, run);
      if (remembered === 'mismatch') {
        return respond(refusal(400, 'SETTINGS_PRECONDITION_INVALID', undefined, {
          state: 'nothing was applied', next: ['Send a new requestId for a different change'] }));
      }
      return remembered.then(respond);
    },
  };
}

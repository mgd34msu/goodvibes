import { readFeatureRestartStatus, type FeatureRestartStatus } from './feature-restart-status';
import {
  createBrowserKnowledgePlatform,
  forSession,
  KNOWLEDGE_BROWSER_ROUTES,
} from '@goodvibes/engine/platform/browser/knowledge';
import type { BrowserKnowledgeMethodId } from '@goodvibes/engine/platform/browser/knowledge';
import { WEBUI_METHOD_ROUTES } from '@goodvibes/engine/contracts/generated/webui-facade';
import { getClientLifetime, heldBearerSync, invalidateClientLifetime, isClientLifetimeCurrent, readSignedInIdentity, tokenStore } from './client-lifetime';
import { clearHeldInputs } from './held-input';
export { hasSignInSync, tokenStore } from './client-lifetime';
import { isRuntimeEventDomain } from '@goodvibes/engine/contracts';
import { getActiveRoute, routedFetch } from './relay-connection';
import { acceptOwnerApprovalAnswer, type AppliedAnswer } from './owner-approval';
import { readTelegramCursorPreview, readTelegramCursorMigrationResult, type TelegramCursorPreview } from '@goodvibes/engine/platform/platform/channels/telegram-cursor';
import { DecisionModelsDisabledError } from '@goodvibes/engine/platform/browser/decision-policy';
import { browserDecisionPolicy } from './decision-policy';
import type { PaymentWindowView, PaymentWindowAnswer, PaymentPurchaseStatus, PaymentOperationView, PaymentOperationCancellation } from '@goodvibes/engine/platform/platform/payments';
import type { PaymentSecurityCodeRequestView, PaymentSecurityCodeAcceptance } from '@goodvibes/engine/platform/platform/payments/browser';
import { readPaymentWindowStatus, readPaymentWindowAnswer, readPaymentSecurityCodeAcceptance, readPaymentOperation, readPaymentOperationCancellation, PAYMENT_PURCHASE_RECONCILE_HTTP } from '@goodvibes/engine/platform/platform/payments/browser';
import { readClientCompatibilityFloor, recordObservedClientCompatibilityFloor } from './client-compatibility';
// The union profile.forget accepts as a target (a field id OR a raw line index), named in
// lib/owner-profile.ts beside the readers for the same verbs' output. The generated
// OperatorMethodInput<'profile.forget'> has both properties optional, so this narrower
// type is what stops a caller passing neither. Type-only import: no runtime dependency.
import type { ProfileForgetInput } from './owner-profile';
import type {
  JsonValue,
  OperatorMethodId,
  OperatorMethodInput,
  OperatorMethodOutput,
  OperatorTypedMethodId,
  RuntimeEventDomain,
} from '@goodvibes/engine/contracts';
import type {
  ContractsSummariesInput,
  ContractsSummariesResult,
  ContractSummaryRecord,
  ContractsStatusResult,
  ContractRecord,
  CheckpointsCreateInput,
  CheckpointsCreateResult,
  CheckpointsDiffInput,
  CheckpointsDiffResult,
  CheckpointsListInput,
  CheckpointsListResult,
  CheckpointsRestoreInput,
  CheckpointsRestoreResult,
  CheckpointsRestorePreviewInput,
  CheckpointsRestorePreviewResult,
  CheckpointsRevertHunkPreviewInput,
  CheckpointsRevertHunkPreviewResult,
  CheckpointsRevertHunkInput,
  CheckpointsRevertHunkResult,
  CostAttributionGetInput,
  CostAttributionGetResult,
  CostAttributionRow,
  FleetArchivedListResult,
  FleetArchiveFinishedResult,
  FleetArchiveResult,
  FleetAttemptsListInput,
  FleetAttemptsListResult,
  FleetAttemptGroup,
  FleetAttemptCandidate,
  FleetAttemptJudgment,
  FleetAttemptsPickResult,
  FleetAttemptsJudgeResult,
  FleetObservedSteerResult,
  FleetListInput,
  FleetListResult,
  FleetProcessNode,
  FleetSnapshotResult,
  FleetUnarchiveResult,
  RewindPlanInput,
  RewindPlanResult,
  RewindApplyInput,
  RewindApplyResult,
  SessionParticipant,
  SessionsChangesGetInput,
  SessionsChangesGetResult,
  SessionsDetachInput,
  SessionsDetachResult,
  SessionsSearchInput,
  SessionsSearchResult,
  WorkspaceCheckpoint,
  SessionsHostedListInput,
  SessionsHostedListResult,
  HostedSessionRecord,
  SessionsHostedCreateInput,
  SessionsHostedCreateResult,
  SessionsHostedAttachInput,
  SessionsHostedAttachResult,
  HostedSessionHistoryMessage,
  SessionsHostedDetachInput,
  SessionsHostedDetachResult,
  SessionsHostedKillInput,
  SessionsHostedKillResult,
  SessionsHostedShareInput,
  SessionsHostedShareResult,
} from './contract-bridge-types';

// Re-exported so consumers (lib/fleet.ts, lib/checkpoints.ts, FleetView.tsx, ...) import
// every wire type from './goodvibes'. Definitions live in contract-bridge-types.ts, as
// aliases of the generated contract.
export type {
  ContractsSummariesInput,
  ContractsSummariesResult,
  ContractSummaryRecord,
  ContractsStatusResult,
  ContractRecord,
  CheckpointsCreateInput,
  CheckpointsCreateResult,
  CheckpointsDiffInput,
  CheckpointsDiffResult,
  CheckpointsListInput,
  CheckpointsListResult,
  CheckpointsRestoreInput,
  CheckpointsRestoreResult,
  CheckpointsRestorePreviewInput,
  CheckpointsRestorePreviewResult,
  CheckpointsRevertHunkPreviewInput,
  CheckpointsRevertHunkPreviewResult,
  CheckpointsRevertHunkInput,
  CheckpointsRevertHunkResult,
  CostAttributionGetInput,
  CostAttributionGetResult,
  CostAttributionRow,
  FleetArchivedListResult,
  FleetArchiveFinishedResult,
  FleetArchiveResult,
  FleetAttemptsListInput,
  FleetAttemptsListResult,
  FleetAttemptGroup,
  FleetAttemptCandidate,
  FleetAttemptJudgment,
  FleetAttemptsPickResult,
  FleetAttemptsJudgeResult,
  FleetObservedSteerResult,
  FleetListInput,
  FleetListResult,
  FleetProcessNode,
  FleetSnapshotResult,
  FleetUnarchiveResult,
  RewindPlanInput,
  RewindPlanResult,
  RewindApplyInput,
  RewindApplyResult,
  SessionParticipant,
  SessionsChangesGetInput,
  SessionsChangesGetResult,
  SessionsDetachInput,
  SessionsDetachResult,
  SessionsSearchInput,
  SessionsSearchResult,
  WorkspaceCheckpoint,
  SessionsHostedListInput,
  SessionsHostedListResult,
  HostedSessionRecord,
  SessionsHostedCreateInput,
  SessionsHostedCreateResult,
  SessionsHostedAttachInput,
  SessionsHostedAttachResult,
  HostedSessionHistoryMessage,
  SessionsHostedDetachInput,
  SessionsHostedDetachResult,
  SessionsHostedKillInput,
  SessionsHostedKillResult,
  SessionsHostedShareInput,
  SessionsHostedShareResult,
};

/**
 * One undelivered daemon receipt, served by control.status only when called with a
 * `receipts` mode. The daemon pre-renders the human line (a crash restart, a
 * self-update, a migration) in `text`; the webui renders it verbatim as a one-line
 * dismissible notice. `at` is the epoch-ms the event happened; `id` is the dedupe key.
 */
export type DaemonReceipt = NonNullable<OperatorMethodOutput<'control.status'>['receipts']>[number];

/** Names an object type declares, leaving out an index signature such as the `[key: string]: unknown` the generated inputs carry. */
type DeclaredKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };
/** A session verb's input without `sessionId`, which the wrapper takes as its own argument. */
type WithoutSessionId<T> = Pick<T, Exclude<DeclaredKeys<T>, 'sessionId'>>;

export const WEBUI_SURFACE_KIND = 'webui';
export const WEBUI_SURFACE_ID = 'goodvibes-webui';
// The daemon-served world is one origin: the web UI's own bundle and the API it calls
// are served by the same control-plane listener, whose default port is 3421. A browser
// context always has `window.location.origin`; the 3421 fallback below is reached only
// outside one (tests, SSR-style module evaluation).
export const GOODVIBES_BASE_URL = import.meta.env.VITE_GOODVIBES_BASE_URL
  || (typeof window === 'undefined' ? 'http://127.0.0.1:3421' : window.location.origin);

/** This build's own version (vite.config.ts's `define`, from package.json), for
 * comparison against a daemon-announced client-build floor, see client-compatibility.ts.
 * Undefined outside a Vite-built bundle (bun test, a bare module eval). */
export const WEBUI_VERSION: string | undefined = import.meta.env.VITE_WEBUI_VERSION;


type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type JsonRecord = Record<string, unknown>;

interface RouteDefinition {
  method: HttpMethod;
  path: string;
}

interface RequestOptions {
  /** Set only by a handler for an explicit owner gesture. */
  readonly explicitUserRequest?: boolean;
  method?: HttpMethod;
  body?: unknown;
  query?: JsonRecord;
  authenticated?: boolean;
  signal?: AbortSignal;
}

/**
 * The webui's transport layer is GENERATED, not hand-maintained. The mechanical facts,
 * which operator methods carry a plain-REST http binding, at what path, and which are
 * reachable only through the generic gateway-method invoke endpoint, come from the
 * contract-emitted facade artifact (@goodvibes/engine/contracts/generated/webui-facade):
 * WEBUI_METHOD_ROUTES (every REST-routed method id → route). The ergonomic layer below
 * (the platform.operator.* call shapes, error normalization, auth handling, and the
 * routedFetch relay integration) stays hand-written on top; every request and reply type
 * is the generated contract's.
 *
 * EXTRA_METHOD_ROUTES is DERIVED (buildExtraMethodRoutes): WEBUI_METHOD_ROUTES minus every
 * id the browser platform route maps already cover (those resolve natively through
 * scopedPlatform.operator.invoke, the no-route fall-through in invokeOperator below). No route
 * path or http method is written by hand here, the drift test in goodvibes.test.ts pins
 * this table against the generated artifact so a hand-written row can never shadow or
 * diverge from a generated one.
 *
 * The retirement invariant the previous hand-table documented still holds structurally:
 * sessions.get / steer / followUp / messages.* / inputs.* are covered by the browser platform
 * (SHARED_BROWSER_ROUTES) and so are subtracted out, they resolve natively, never through
 * a generated REST row (see goodvibes.test.ts's EXTRA_METHOD_ROUTES retirement suite).
 */

// The browser platform owns these routes natively (its SHARED_BROWSER_ROUTES ∪
// KNOWLEDGE_BROWSER_ROUTES maps, the set scopedPlatform is built from). invokeOperator must let
// them fall through to scopedPlatform.operator.invoke rather than shadow them with a generated
// REST row (the fall-through carries the scoped transport: relay, auth, observer, SSE).
// KNOWLEDGE_BROWSER_ROUTES is a public runtime export; SHARED_BROWSER_ROUTES is not, so its
// ids are listed here and pinned to the platform's own BrowserKnowledgeMethodId type by
// SHARED_COVERAGE_IS_COMPLETE below: a browser-covered method this list has not accounted
// for stops the build until the list is updated.
const SHARED_BROWSER_METHOD_IDS = [
  'accounts.snapshot',
  'control.auth.current',
  'control.auth.login',
  'control.snapshot',
  'control.status',
  'providers.get',
  'providers.list',
  'providers.usage.get',
  'sessions.create',
  'sessions.followUp',
  'sessions.get',
  'sessions.inputs.cancel',
  'sessions.inputs.list',
  'sessions.list',
  'sessions.messages.create',
  'sessions.messages.list',
  'sessions.steer',
] as const;

type BrowserCoveredMethodId =
  | (typeof SHARED_BROWSER_METHOD_IDS)[number]
  | Extract<keyof typeof KNOWLEDGE_BROWSER_ROUTES, string>;
// Compile-time half of the drift protection: fails to compile if BrowserKnowledgeMethodId
// (the platform's own SHARED ∪ KNOWLEDGE union) gains a member this module does not subtract,
// otherwise a generated REST row could silently shadow a natively-covered method.
const SHARED_COVERAGE_IS_COMPLETE: [BrowserKnowledgeMethodId] extends [BrowserCoveredMethodId] ? true : never = true;
void SHARED_COVERAGE_IS_COMPLETE;

/** The method ids the browser platform routes natively (scopedPlatform.operator.invoke). */
const BROWSER_COVERED_METHOD_IDS: ReadonlySet<string> = new Set<string>([
  ...SHARED_BROWSER_METHOD_IDS,
  ...Object.keys(KNOWLEDGE_BROWSER_ROUTES),
]);

function buildExtraMethodRoutes(): Record<string, RouteDefinition | undefined> {
  const table: Record<string, RouteDefinition> = {};
  for (const [methodId, def] of Object.entries(WEBUI_METHOD_ROUTES)) {
    if (BROWSER_COVERED_METHOD_IDS.has(methodId)) continue;
    table[methodId] = { method: def.method, path: def.path };
  }
  return table;
}

const EXTRA_METHOD_ROUTES: Record<string, RouteDefinition | undefined> = buildExtraMethodRoutes();

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

/**
 * The daemon's own words about an HTTP failure (category, hint, recoverable,
 * retryAfterMs) lifted onto the thrown error, where formatError reads them. A body
 * category never decides the two answers the app keys off: only a 401 is
 * 'authentication' and only a transport failure is 'network'. A relay step-up 401
 * (`code: 'step-up-required'`) is its own category: the change needs a passkey, the
 * session did not expire.
 */
export function daemonErrorFields(status: number, body: unknown): { category: string; hint?: string; recoverable?: boolean; retryAfterMs?: number } {
  const record = asRecord(body);
  const bodyCategory = typeof record.category === 'string' ? record.category.trim() : '';
  const category = status === 401
    ? record.code === 'step-up-required' ? 'step-up' : 'authentication'
    : bodyCategory && bodyCategory !== 'authentication' && bodyCategory !== 'network' ? bodyCategory : 'service';
  return {
    category,
    ...(typeof record.hint === 'string' && record.hint.trim() ? { hint: record.hint } : {}),
    ...(typeof record.recoverable === 'boolean' ? { recoverable: record.recoverable } : {}),
    ...(typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs) ? { retryAfterMs: record.retryAfterMs } : {}),
  };
}

function buildUrl(path: string, query?: JsonRecord): string {
  const url = new URL(path, `${GOODVIBES_BASE_URL.replace(/\/+$/, '')}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') {
          url.searchParams.append(key, String(item));
        }
      }
    } else if (typeof value === 'object') {
      url.searchParams.set(key, JSON.stringify(value));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- value is not an object (handled above), array (handled above), null/undefined/'' (skipped above)
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await tokenStore.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requestJson<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const failureLifetime = getClientLifetime();
  const lifetime = options.signal ? getClientLifetime() : undefined;
  const check = () => {
    options.signal?.throwIfAborted();
    if (lifetime && !isClientLifetimeCurrent(lifetime)) throw new DOMException('Request identity changed', 'AbortError');
  };
  check();
  const method = options.method ?? 'GET';
  const headers: HeadersInit = {
    ...(options.authenticated === false ? {} : await authHeaders()),
    ...(method === 'GET' || options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(options.explicitUserRequest === true ? { 'x-goodvibes-explicit-user-request': 'true' } : {}),
  };
  const url = buildUrl(path, options.query);
  check();
  // routedFetch (not the bare global fetch) so REST-routed methods traverse the relay when
  // the active route is relay, otherwise a mutating call (permission respond, session
  // control) would hit an unreachable direct URL over relay and never reach the daemon's
  // step-up gate. On the direct/LAN route routedFetch IS the plain global fetch (no change).
  const response = await routedFetch(url, {
    method,
    credentials: 'include',
    headers,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(method === 'GET' || options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  check();
  // Every response, success or failure, is a chance to learn the daemon's current
  // client-build floor (see client-compatibility.ts), recorded here rather than only
  // on one dedicated probe, since this is the one HTTP helper nearly every operator
  // call passes through.
  recordObservedClientCompatibilityFloor(readClientCompatibilityFloor(response.headers));
  if (options.authenticated !== false && isClientLifetimeCurrent(failureLifetime)) browserDecisionPolicy.observe(response.headers);
  const body = await readJson(response);
  check();
  if (!response.ok) {
    const error = Object.assign(new Error(`${method} ${path} failed: ${response.status} ${response.statusText}`.trim()), {
      status: response.status,
      url,
      method,
      body,
      ...daemonErrorFields(response.status, body),
    });
    throw error;
  }
  return body as T;
}

/**
 * requestStream, a POST whose SUCCESS body is raw bytes, not JSON (voice.tts.stream
 * returns streamed audio). Returns the live Response so the caller can read
 * arrayBuffer()/body without this helper eagerly draining it. On a non-2xx it drains and
 * throws the SAME error shape requestJson does (status/category), so the TTS request
 * policy's transient-429 detection (src/lib/voice/request-policy.ts keys off `status`)
 * works identically on both paths.
 */
async function requestStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  // Accept names audio so a relay-routed request opens a streamed answer and playback
  // starts with the first bytes, rather than after the whole clip is buffered.
  const headers: HeadersInit = { ...(await authHeaders()), 'Content-Type': 'application/json', Accept: 'audio/*, application/json' };
  const url = buildUrl(path);
  // routedFetch so this streamed POST also traverses the relay when routed (see requestJson).
  const response = await routedFetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  recordObservedClientCompatibilityFloor(readClientCompatibilityFloor(response.headers));
  if (!response.ok) {
    const errBody = await readJson(response).catch(() => null);
    throw Object.assign(new Error(`POST ${path} failed: ${response.status} ${response.statusText}`.trim()), {
      status: response.status,
      url,
      method: 'POST' as HttpMethod,
      body: errBody,
      ...daemonErrorFields(response.status, errBody),
    });
  }
  return response;
}

/**
 * hostedSessionDetachBeacon, best-effort detach for a page teardown (pagehide /
 * visibilitychange-to-hidden, see HostedSessionsView.tsx), for when there is no time
 * left to await the ordinary async platform.operator.sessions.hosted.detach round trip. Fires
 * one `fetch` with `keepalive: true`, so the browser completes the request after the page
 * itself has gone away. On the direct route the browser adds the HttpOnly sign-in cookie by
 * itself; a bearer held in memory (signed in over the relay) is added as the header.
 *
 * SAME-ORIGIN ONLY: this always targets GOODVIBES_BASE_URL directly, never routedFetch's
 * relay path, a relay round trip involves its own encryption/signing handshake that
 * cannot complete synchronously at teardown either, so a relay-routed session gets no
 * keepalive detach here. That is an accepted, honestly-reported limitation (see this
 * function's callers), not a silent gap: the ordinary async detach still covers every
 * case where the page stays alive long enough for it to settle.
 *
 * Never throws and never rejects visibly, by the time this fires there is often no view
 * left to report a failure to.
 */
export function hostedSessionDetachBeacon(sessionId: string, clientId: string): void {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
  const token = heldBearerSync();
  try {
    void fetch(buildUrl('/api/control-plane/methods/sessions.hosted.detach/invoke'), {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ body: { sessionId, clientId } }),
    }).catch(() => undefined);
  } catch {
    // A synchronous throw (fetch unavailable, a keepalive body-size limit, ...),
    // nothing more can be done at teardown.
  }
}

function interpolateRoute(route: RouteDefinition, input: unknown): { path: string; rest: JsonRecord } {
  const record = asRecord(input);
  const consumed = new Set<string>();
  const path = route.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = record[key];
    if (value === undefined || value === null || value === '') throw new Error(`Missing route parameter: ${key}`);
    consumed.add(key);
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- value is a non-null, non-undefined, non-empty string URL param; the throw guard above rejects undefined/null/'' but does not exclude objects, so String() may yield "[object Object]" for non-primitive route values
    return encodeURIComponent(String(value));
  });
  const rest = Object.fromEntries(Object.entries(record).filter(([key, value]) => !consumed.has(key) && value !== undefined));
  return { path, rest };
}

/**
 * True when a method resolves via a hand-written EXTRA_METHOD_ROUTES row rather than
 * natively through scopedPlatform.operator.invoke. Exported so the retirement contract is
 * test-enforced: sessions.get/steer/followUp must be native (false); sessions.close /
 * reopen must still be table-routed (true).
 */
export function isExtraRoutedMethod(methodId: string): boolean {
  return Boolean(EXTRA_METHOD_ROUTES[methodId]);
}

/**
 * The resolved REST route for a table-routed method id, or undefined when the method falls
 * through to the browser platform / generic invoke path. Exported for the drift test that pins
 * this derived table against the generated WEBUI_METHOD_ROUTES artifact, proving no
 * hand-written row shadows or diverges from a generated one.
 */
export function webuiRouteFor(methodId: string): RouteDefinition | undefined {
  return EXTRA_METHOD_ROUTES[methodId];
}

/**
 * invokeOperator, the single dispatcher for every operator method id, contract-typed.
 *
 * The `input` parameter is typed `OperatorMethodInput<TMethodId>` directly, so a contract
 * change to any verb fails this app's compile instead of reaching the daemon as a stale
 * body. A write the daemon put to the owner rejects (lib/owner-approval.ts), so the
 * pending answer is not part of the reply type. `TOutput` may be overridden only to
 * narrow the reply a view reads.
 */
async function invokeOperator<
  TMethodId extends OperatorMethodId,
  TOutput = AppliedAnswer<OperatorMethodOutput<TMethodId>>,
>(methodId: TMethodId, input?: OperatorMethodInput<TMethodId>, signal?: AbortSignal): Promise<TOutput>;
async function invokeOperator(methodId: string, input?: unknown, signal?: AbortSignal): Promise<unknown> {
  const answer = await invokeOperatorOnce(methodId, input, signal);
  // A loosening change asked from a token minted for automation is put to the
  // owner (202 OWNER_APPROVAL_PENDING): it is shown as waiting for him, never as saved.
  return OWNER_APPROVAL_WRITES.has(methodId) ? acceptOwnerApprovalAnswer(answer) : answer;
}

/**
 * An operator method the owner ran by pressing a sheet's button (a slash
 * command action drawn from lib/generated/command-actions.ts), so it carries
 * the explicit-user-request claim the payment and grant handlers require. By
 * the method's REST route when it has one, else through the generic method
 * invoke (a method newer than the generated routes goes there too). A method
 * the browser platform routes itself (sessions.*, accounts.snapshot) goes
 * there; none of those reads the claim.
 */
export async function invokeOwnerMethod(methodId: string, input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
  const route = EXTRA_METHOD_ROUTES[methodId];
  if (route) {
    const { path, rest } = interpolateRoute(route, input);
    if (route.method === 'GET') return requestJson(path, { method: route.method, query: rest, signal });
    if (route.method === 'DELETE' && !Object.keys(rest).length) return requestJson(path, { method: route.method, signal, explicitUserRequest: true });
    return requestJson(path, { method: route.method, body: rest, signal, explicitUserRequest: true });
  }
  if (BROWSER_COVERED_METHOD_IDS.has(methodId)) return invokeOperator(methodId as OperatorMethodId, input as OperatorMethodInput<OperatorMethodId>, signal);
  return requestJson(`/api/control-plane/methods/${methodId}/invoke`, { method: 'POST', body: { body: input }, signal, explicitUserRequest: true });
}

/** The writes the daemon can put to the owner instead of applying (see lib/owner-approval.ts). */
const OWNER_APPROVAL_WRITES: ReadonlySet<string> = new Set(['config.set', 'config.setMany', 'config.reset', 'sessions.permissionMode.set']);

async function invokeOperatorOnce(methodId: string, input?: unknown, signal?: AbortSignal): Promise<unknown> {
  const route = EXTRA_METHOD_ROUTES[methodId];
  if (!route) {
    // A method with no REST binding that the browser platform does not route either
    // (inbox.list, inbox.answer, update.status, update.check) is reachable only through
    // the generic method invoke; handing it to scopedPlatform would refuse it in the
    // browser and no request would ever leave.
    if (!BROWSER_COVERED_METHOD_IDS.has(methodId)) {
      return invokeGatewayMethod(methodId as OperatorMethodId, input as OperatorMethodInput<OperatorMethodId>, signal);
    }
    // Every methodId that reaches this point is a member of BrowserKnowledgeMethodId
    // (SHARED_BROWSER_ROUTES ∪ KNOWLEDGE_BROWSER_ROUTES), a runtime invariant the type
    // system cannot see through a string-keyed table lookup.
    return scopedPlatform.operator.invoke(
      methodId as BrowserKnowledgeMethodId,
      input as OperatorMethodInput<BrowserKnowledgeMethodId>,
      { signal },
    );
  }
  const { path, rest } = interpolateRoute(route, input);
  if (route.method === 'GET') return requestJson(path, { method: route.method, query: rest, signal });
  if (route.method === 'DELETE' && !Object.keys(rest).length) return requestJson(path, { method: route.method, signal });
  return requestJson(path, { method: route.method, body: rest, signal });
}

/** Routes remain derived from the canonical catalog/facade, never a second
 * hand-written URL table. Explicit-user metadata belongs only to answer clicks. */
function purchaseWindowRoute(action: 'status' | 'approve' | 'deny' | 'cancel'): RouteDefinition {
  const route = EXTRA_METHOD_ROUTES[`payments.purchase.${action}`];
  if (!route || route.method !== (action === 'status' ? 'GET' : 'POST')) {
    throw new Error('The connected client does not provide the purchase-window route.');
  }
  return route;
}
async function readPurchaseWindows(signal?: AbortSignal): Promise<PaymentPurchaseStatus> {
  const route = purchaseWindowRoute('status');
  return readPaymentWindowStatus(await requestJson(route.path, { method: 'GET', signal }));
}
async function answerPurchaseWindow(action: 'approve' | 'deny' | 'cancel', input: Pick<PaymentWindowView, 'purchaseId' | 'windowId'>, signal?: AbortSignal): Promise<PaymentWindowAnswer> {
  const route = purchaseWindowRoute(action);
  const purchaseId = input.purchaseId, windowId = input.windowId;
  const result = readPaymentWindowAnswer(await requestJson(route.path, { method: 'POST', body: { purchaseId, windowId, confirm: true }, explicitUserRequest: true, signal }));
  if (result.purchaseId !== purchaseId || result.windowId !== windowId) throw new Error('The purchase answer did not match the selected window. Refresh its status.');
  return result;
}
/** The owner's own POST payment acts other than window answers, by their catalog route. */
function ownerPaymentRoute(methodId: 'payments.purchase.securityCode' | 'payments.checkout.approve'): RouteDefinition {
  const route = EXTRA_METHOD_ROUTES[methodId];
  if (!route || route.method !== 'POST') throw new Error(`The connected daemon does not provide ${methodId}.`);
  return route;
}
/** Hand the typed card security code to the one purchase waiting for it. The code is sent once and kept nowhere here. */
async function supplyPurchaseSecurityCode(input: Pick<PaymentSecurityCodeRequestView, 'purchaseId' | 'windowId'>, code: string, signal?: AbortSignal): Promise<PaymentSecurityCodeAcceptance> {
  const route = ownerPaymentRoute('payments.purchase.securityCode');
  const purchaseId = input.purchaseId, windowId = input.windowId;
  const result = readPaymentSecurityCodeAcceptance(await requestJson(route.path, { method: 'POST',
    body: { purchaseId, windowId, code, confirm: true }, explicitUserRequest: true, signal }));
  if (result.purchaseId !== purchaseId || result.windowId !== windowId) throw new Error('The acknowledgement did not match the selected purchase. Refresh its status.');
  return result;
}
/** What payments.checkout.approve recorded: one single-use approval bound to these three fields. */
export interface PaymentAdvanceApproval {
  readonly merchantDomain: string;
  readonly item: string;
  readonly amount: string;
  readonly expiresAt: string;
}
/** Approve one purchase in advance: the merchant's domain, the item, and the most it may cost. */
async function approvePurchaseInAdvance(input: { merchantDomain: string; item: string; amount: string }, signal?: AbortSignal): Promise<PaymentAdvanceApproval> {
  const route = ownerPaymentRoute('payments.checkout.approve');
  const raw = asRecord(await requestJson(route.path, { method: 'POST', body: { ...input, confirm: true }, explicitUserRequest: true, signal }));
  const field = (key: string): string => { const value = raw[key]; return typeof value === 'string' ? value : ''; };
  const result = { merchantDomain: field('merchantDomain'), item: field('item'), amount: field('amount'), expiresAt: field('expiresAt') };
  if (raw.approved !== true || !result.merchantDomain || !result.item || !result.amount || !result.expiresAt) {
    throw new Error('The daemon did not confirm the approval. Nothing is known to be approved; try again.');
  }
  return result;
}
async function stopPurchaseOperation(input: Pick<PaymentOperationView, 'purchaseId' | 'operationId'>, signal?: AbortSignal): Promise<PaymentOperationCancellation> {
  const route = purchaseWindowRoute('cancel');
  const purchaseId = input.purchaseId, operationId = input.operationId;
  const result = readPaymentOperationCancellation(await requestJson(route.path, { method: 'POST',
    body: { purchaseId, operationId, confirm: true }, explicitUserRequest: true, signal }));
  if (result.purchaseId !== purchaseId || result.operationId !== operationId) throw new Error('The stop acknowledgement did not match the selected purchase. Refresh its status.');
  return result;
}
async function reconcilePurchaseOperation(input: Pick<PaymentOperationView, 'purchaseId' | 'operationId'>,
  outcome: 'purchased' | 'not-purchased', signal?: AbortSignal): Promise<PaymentOperationView> {
  const purchaseId = input.purchaseId, operationId = input.operationId;
  const result = readPaymentOperation(await requestJson(PAYMENT_PURCHASE_RECONCILE_HTTP.path, { method: PAYMENT_PURCHASE_RECONCILE_HTTP.method,
    body: { purchaseId, operationId, outcome, inspectedMerchantHistory: true, confirm: true },
    explicitUserRequest: true, signal }));
  if (result.purchaseId !== purchaseId || result.operationId !== operationId || result.outcome !== `owner-confirmed-${outcome}`) {
    throw new Error('The reconciliation did not match the selected purchase. Refresh its status before taking action.');
  }
  return result;
}

async function telegramCursorAction(actionId: 'cursor-migration-preview' | 'cursor-migration-commit', body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const route = EXTRA_METHOD_ROUTES['channels.actions.invoke'];
  if (!route || route.method !== 'POST') throw new Error('The connected client does not provide channel recovery actions.');
  const { path } = interpolateRoute(route, { surface: 'telegram', actionId });
  const result = await requestJson(path, { method: 'POST', body, signal, explicitUserRequest: true });
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('actionId' in result) || result.actionId !== actionId
    || !('surface' in result) || result.surface !== 'telegram' || !('result' in result)) throw new Error('The channel recovery response did not match this request.');
  return result.result;
}

// ---------------------------------------------------------------------------
// Compile-time conformance for the profile write bodies.
//
// `profile.forget` is the one profile verb whose body is a local type rather than the
// generated input (the generated one makes fieldId, section and text all optional, so it
// cannot express "a target is required"). These two guards close the gap that let two
// breaking changes land silently:
//
//   * OnlyDeclaredKeys catches a property we send that the contract does not declare,
//     which is exactly how the retired `lineIndex` would have surfaced, and how a future
//     retirement will. Assignability alone does NOT catch this: excess properties are
//     only rejected on fresh object literals, and these bodies are built as variables.
//   * The assignment below catches the other direction, a required property we omit,
//     which is how the newly-required `authority` would have surfaced.
//
// AllKeys distributes over the union so each member's keys are checked, not just the
// keys the members share (plain `keyof` on a union yields only the common ones).
//
// DO NOT REPLACE THIS WITH "just type the parameter". Measured against a closed union
// parameter type, tsc rejects a stale property in only two of the four ways a body gets
// built:
//
//   fresh literal, stale field written inline ......... rejected (excess-property check)
//   spread + stale field written inline ............... rejected (same check still applies)
//   built as a variable ............................... SLIPS THROUGH
//   stale field carried in by the spread .............. SLIPS THROUGH
//
// The last two rows are the ones that matter here, because `profile.forget`'s body IS a
// spread-built literal: `{ ...forgetTargetInput(target), authority }`. If a retired
// property returns to the spread SOURCE's type, no amount of parameter typing at the call
// site sees it, and rewriting the call into branched fresh literals does not help either,
// since the spread still carries it.
//
// This guard covers both of them, measured rather than assumed. Seeding the retired
// `lineIndex` back onto ProfileForgetTarget fails HERE, at this assertion, and does so
// identically whether the body is spread-built or assigned to a variable first: the guard
// reads the DECLARED type and never looks at a call site, so how the body is constructed
// cannot affect it.
//
// What it deliberately does not cover: a key invented at one call site and never declared
// anywhere. That is not contract drift, it is a typo, and the runtime conformance test in
// hooks/useOwnerProfile.test.tsx catches it by checking each sent body against the
// contract's own inputSchema, verified, four failures. So the division is:
// this guard catches the TYPE going stale, that test catches a body going rogue.
// ---------------------------------------------------------------------------
type AllKeys<T> = T extends unknown ? keyof T : never;

type OnlyDeclaredKeys<TMethodId extends OperatorMethodId, TBody> =
  [Exclude<AllKeys<TBody>, keyof OperatorMethodInput<TMethodId>>] extends [never] ? true : never;

const PROFILE_FORGET_SENDS_ONLY_DECLARED_KEYS: OnlyDeclaredKeys<'profile.forget', ProfileForgetInput> = true;
void PROFILE_FORGET_SENDS_ONLY_DECLARED_KEYS;

const PROFILE_FORGET_BODY_IS_ACCEPTED: OperatorMethodInput<'profile.forget'> = {} as ProfileForgetInput;
void PROFILE_FORGET_BODY_IS_ACCEPTED;

/**
 * invokeGatewayMethod, typed direct call to the generic invoke-by-id endpoint
 * (POST /api/control-plane/methods/{methodId}/invoke).
 *
 * WHY THIS EXISTS: fleet.*, checkpoints.*, push.*, pairing.* and the other ws-only verbs
 * have NO `http` route binding, so they are reachable ONLY through this generic invoke
 * mechanism, not through scopedPlatform.operator.invoke (fixed browser route tables) and
 * not through EXTRA_METHOD_ROUTES (REST routes only).
 *
 * `body` is the contract's input for the id and the reply defaults to its output, so a
 * catalog change to any of these verbs fails this app's compile. Keep the wrappers'
 * parameter types as aliases of the contract (contract-bridge-types.ts does), so a newly
 * required field arrives through them instead of being hidden by a hand-written copy.
 */
async function invokeGatewayMethod<TMethodId extends OperatorMethodId, TOutput = OperatorMethodOutput<TMethodId>>(
  methodId: TMethodId,
  body?: OperatorMethodInput<TMethodId>,
  signal?: AbortSignal,
): Promise<TOutput> {
  return requestJson<TOutput>(`/api/control-plane/methods/${methodId}/invoke`, {
    method: 'POST',
    body: { body: body ?? {} },
    signal,
  });
}

/** Read-only, cancellable contract requests use the generated REST binding. */
async function readContractMethod<M extends 'contracts.get'>(
  methodId: M,
  input: OperatorMethodInput<M>,
  signal?: AbortSignal,
): Promise<OperatorMethodOutput<M>> {
  const route = webuiRouteFor(methodId);
  if (route?.method !== 'GET') throw new Error('Contract inspection is unavailable.');
  const { path, rest } = interpolateRoute(route, input);
  return requestJson(path, { method: route.method, query: rest, signal });
}

// ─── Wire shapes ─────────────────────────────────────────────────────────────
//
// Every request and reply shape below is the generated contract's, named for the views
// that import it. A local type exists only where it narrows the contract (a literal
// `confirm: true`, a required field the contract leaves optional) or adds what the
// published schema does not carry yet, and each one says which.

/** `Omit` that keeps the declared names of an open generated object (one with an index signature). */
type OmitDeclared<T, K extends PropertyKey> = Pick<T, Exclude<DeclaredKeys<T>, K>>;

// ─── Approvals (approvals.*) ─────────────────────────────────────────────────

/**
 * One edit hunk of an `edit`-tool approval's `request.args.edits` array, as the
 * platform's approval-hunk-apply.ts reads it (lib/approvals.ts). A request whose args
 * are not edit-shaped has no hunks to render.
 */
export interface ApprovalEditHunk {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
  readonly id?: string;
}

type ContractApprovalRecord = OperatorMethodOutput<'approvals.list'>['approvals'][number];
type ContractApprovalRequest = ContractApprovalRecord['request'];

export type ApprovalAttribution = NonNullable<ContractApprovalRequest['attribution']>;
export type ApprovalAnalysis = ContractApprovalRequest['analysis'];
export type ApprovalRememberOption = NonNullable<ContractApprovalRequest['rememberOptions']>[number];
export type ApprovalRequest = ContractApprovalRequest;
export type ApprovalDecision = NonNullable<ContractApprovalRecord['decision']>;
export type ApprovalStatus = ContractApprovalRecord['status'];
export type ApprovalAuditRecord = ContractApprovalRecord['audit'][number];
export type ApprovalRecord = ContractApprovalRecord;
/** What the broker recorded for the decision: the tier, whether the reason was stored, whether modifiedArgs reached the run. */
export type ApprovalRecordedOutcome = NonNullable<OperatorMethodOutput<'approvals.approve'>['recorded']>;
/** The reply of approvals.approve, deny, claim and cancel (one shape for all four). */
export type ApprovalActionResult = OperatorMethodOutput<'approvals.approve'>;

/**
 * Optional per-hunk selection and remember tier for `approvals.approve`. Omitting
 * `selectedHunks` approves the whole request; when present the daemon filters the
 * approval's own edit list to those indices, so the web UI only ever sends indices.
 */
export type ApprovalApproveInput = Omit<OperatorMethodInput<'approvals.approve'>, 'approvalId' | 'rememberTier'> & {
  /** A tier from the approval's own remember options; checked against the contract's tiers before sending. */
  readonly rememberTier?: string;
};

type ApprovalRememberTier = NonNullable<OperatorMethodInput<'approvals.approve'>['rememberTier']>;
const APPROVAL_REMEMBER_TIERS: readonly ApprovalRememberTier[] = ['session', 'exact', 'command-class', 'path', 'tool'];

/** The approve body: the contract's input, with an unknown remember tier refused before anything is sent. */
function approveInput(approvalId: string, input: ApprovalApproveInput): OperatorMethodInput<'approvals.approve'> {
  // The owner pressed approve: say so, so a decision that must be the owner's own (trusting a workspace) counts it.
  const { rememberTier, ...rest } = input;
  if (rememberTier === undefined) return { ...rest, approvalId, disposition: 'approved' };
  const tier = APPROVAL_REMEMBER_TIERS.find((candidate) => candidate === rememberTier);
  if (!tier) throw new Error(`This daemon offers no remember tier "${rememberTier}"; nothing was approved. Choose another remember option.`);
  return { ...rest, approvalId, disposition: 'approved', rememberTier: tier };
}

/** Whether a value survives JSON as it is: no function, symbol, class instance, NaN or Infinity silently changed on the way. */
function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 64) return false;
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  // An undefined field is left out of the JSON, as the daemon reads it.
  return Object.values(value).every((entry) => entry === undefined || isJsonValue(entry, depth + 1));
}

/** The config.set value: one JSON cannot carry as it is is refused before anything is sent. */
function configSetValue(key: string, value: unknown): JsonValue {
  if (isJsonValue(value)) return value;
  throw new Error(`The value for ${key} is not plain JSON (text, numbers, true/false, null, and lists or objects of those), so nothing was written. Enter it again.`);
}

/** Optional deny payload: `note` rides the audit trail; `reason` is the broker's structured user-declined feedback. */
export type ApprovalDenyInput = Pick<OperatorMethodInput<'approvals.deny'>, 'expectedRevision' | 'note' | 'reason'>;

/** One durable approval rule (permissions.rules.list): a remembered decision at a generalizing tier. Deleting it makes matching asks prompt again. */
export type PermissionRuleRecord = OperatorMethodOutput<'permissions.rules.list'>['rules'][number];

// ─── Tasks and watchers ──────────────────────────────────────────────────────

export type TaskSnapshotResult = OperatorMethodOutput<'tasks.list'>;
export type RuntimeTaskSummary = TaskSnapshotResult['tasks'][number];
export type TaskActionResult = OperatorMethodOutput<'tasks.cancel'>;
export type TaskCreateInput = OperatorMethodInput<'tasks.create'>;
export type TaskCreateResult = OperatorMethodOutput<'tasks.create'>;
export type WatcherActionResult = OperatorMethodOutput<'watchers.stop'>;

// ─── Calendar (calendar.*) ───────────────────────────────────────────────────
// The two writes narrow `confirm` to literal `true`, so a caller cannot pass
// `confirm: false` and meet the daemon's refusal at run time instead.

export type CalendarEventsListResult = OperatorMethodOutput<'calendar.events.list'>;
export type CalendarEventSummary = CalendarEventsListResult['events'][number];
export type CalendarEventsListInput = OperatorMethodInput<'calendar.events.list'>;
export type CalendarEventDetail = OperatorMethodOutput<'calendar.events.get'>;
export type CalendarEventCreateInput = OperatorMethodInput<'calendar.events.create'> & { readonly confirm: true };
export type CalendarEventCreateResult = OperatorMethodOutput<'calendar.events.create'>;
export type CalendarIcsImportInput = OperatorMethodInput<'calendar.ics.import'> & { readonly confirm: true };
export type CalendarIcsImportResult = OperatorMethodOutput<'calendar.ics.import'>;
export type CalendarIcsExportInput = OperatorMethodInput<'calendar.ics.export'>;
export type CalendarIcsExportResult = OperatorMethodOutput<'calendar.ics.export'>;

// ─── Email (email.*) ─────────────────────────────────────────────────────────
// `unreadable` lists the messages the daemon could not parse, each with its reason;
// MailView renders it, so a window where every message failed is not shown as an
// empty inbox.

export type EmailInboxListInput = OperatorMethodInput<'email.inbox.list'>;
export type EmailInboxListResult = OperatorMethodOutput<'email.inbox.list'>;
export type EmailInboxMessage = EmailInboxListResult['messages'][number];
export type EmailUnreadableMessage = NonNullable<EmailInboxListResult['unreadable']>[number];
export type EmailMessageDetail = OperatorMethodOutput<'email.inbox.read'>;
export type EmailAttachment = NonNullable<EmailMessageDetail['attachments']>[number];
/**
 * email.send is an irreversible external send: `confirm` is literal `true`, and the view
 * sets it only from a confirmation sheet that showed the recipients.
 */
export type EmailSendInput = OperatorMethodInput<'email.send'> & { readonly confirm: true };
export type EmailSendResult = OperatorMethodOutput<'email.send'>;
/** Drafts append to the account's Drafts folder and need no `confirm`: nothing leaves the account. */
export type EmailDraftCreateInput = OperatorMethodInput<'email.draft.create'>;
export type EmailDraftCreateResult = OperatorMethodOutput<'email.draft.create'>;
/** `email.draft.update`: replace the saved draft named by `uid` in the Drafts generation `uidValidity`. */
export interface EmailDraftUpdateInput {
  readonly uid: number;
  readonly uidValidity: number;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly references?: string;
}
export interface EmailDraftUpdateResult {
  readonly draftId: string;
  readonly uid?: number;
  readonly uidValidity?: number;
  readonly mailbox: string;
  readonly replaced: number;
}

// ─── Sessions and companion chat ─────────────────────────────────────────────

/** `deleted: true` means the record and its messages were removed, not merely closed. */
export type SessionDeleteResult = OperatorMethodOutput<'sessions.delete'>;

/**
 * Regenerate (companion.chat.messages.retry): the prior response and any turns after it
 * are superseded, kept and flagged, never deleted; `supersededMessageIds` is that retained
 * history and `turnStarted` says whether a new turn is streaming back.
 */
export type CompanionRegenerateResult = OperatorMethodOutput<'companion.chat.messages.retry'>;

/**
 * Edit-and-branch (companion.chat.messages.edit): the edited user message and everything
 * after it are superseded; `messageId` is the new active user message, `editedFrom` the original.
 */
export type CompanionEditResult = OperatorMethodOutput<'companion.chat.messages.edit'>;

/**
 * One hit of `chat.messages.search` (companion.chat.messages.search): the chat, the
 * message, a snippet around the match and when it was written. The daemon matches
 * message text across every chat in one scan, newest first, paged by `nextCursor`.
 */
export interface CompanionMessageSearchHit {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly messageId: string;
  readonly role: string;
  readonly snippet: string;
  readonly createdAt: number;
}

export interface CompanionMessageSearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly includeClosed?: boolean;
}

export interface CompanionMessageSearchResult {
  readonly query: string;
  readonly items: readonly CompanionMessageSearchHit[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

/** Input for `chat.messages.edit`: the replacement text is required here, where the contract also accepts `body` or attachments alone. */
export interface CompanionEditInput {
  readonly content: string;
  readonly attachments?: readonly { artifactId: string; label?: string }[];
  readonly metadata?: Record<string, unknown>;
}

/**
 * Explicit capped-exponential reconnect policy for every SSE consumer. Without it the
 * platform falls back to its own defaults and a dropped stream can appear "live"; with it a
 * dropped stream reconnects with backoff and, once attempts are exhausted, degrades to
 * the honest "SSE error/off" strip state and the 15s health-probe fallback.
 */
export const DEFAULT_SSE_RECONNECT = {
  enabled: true,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffFactor: 2,
  maxAttempts: 10,
} as const;

// ─── Memory (memory.records.*, memory.review-queue, memory.consolidation.receipts) ──

/** One point-in-time copy of the memory store (memory.snapshots.list). */
export interface MemoryCopy {
  readonly name: string;
  readonly reason: string;
  readonly createdAt: number;
  readonly sizeBytes: number;
  readonly recordCount: number | null;
}

/** What a restore did (memory.snapshots.restore). */
export interface MemoryRestoreOutcome {
  readonly restored: string;
  readonly restoredReason: string;
  readonly restoredCreatedAt: number;
  readonly recordsBefore: number;
  readonly recordsAfter: number;
  readonly linksAfter: number;
  readonly undoSnapshot: string;
  readonly vectorIndex: 'updating' | 'off';
}

function readMemoryCopies(raw: unknown): readonly MemoryCopy[] {
  const list = (raw as { snapshots?: unknown } | null)?.snapshots;
  if (!Array.isArray(list)) throw new Error('The daemon returned an unreadable list of memory copies.');
  return list.map((entry): MemoryCopy => {
    const copy = entry as Partial<Record<keyof MemoryCopy, unknown>>;
    if (typeof copy.name !== 'string' || typeof copy.reason !== 'string' || typeof copy.createdAt !== 'number' || typeof copy.sizeBytes !== 'number'
      || (copy.recordCount !== null && typeof copy.recordCount !== 'number')) throw new Error('The daemon returned an unreadable memory copy.');
    return { name: copy.name, reason: copy.reason, createdAt: copy.createdAt, sizeBytes: copy.sizeBytes, recordCount: copy.recordCount ?? null };
  });
}

function readMemoryRestore(raw: unknown): MemoryRestoreOutcome {
  const r = (raw ?? {}) as Partial<Record<keyof MemoryRestoreOutcome, unknown>>;
  const numbers = [r.restoredCreatedAt, r.recordsBefore, r.recordsAfter, r.linksAfter];
  if (typeof r.restored !== 'string' || typeof r.restoredReason !== 'string' || typeof r.undoSnapshot !== 'string'
    || numbers.some((value) => typeof value !== 'number') || (r.vectorIndex !== 'updating' && r.vectorIndex !== 'off')) {
    throw new Error('The daemon returned an unreadable restore answer; list the copies to see what is there now.');
  }
  return {
    restored: r.restored, restoredReason: r.restoredReason, restoredCreatedAt: r.restoredCreatedAt as number,
    recordsBefore: r.recordsBefore as number, recordsAfter: r.recordsAfter as number, linksAfter: r.linksAfter as number,
    undoSnapshot: r.undoSnapshot, vectorIndex: r.vectorIndex,
  };
}

export type MemoryRecordEntityResult = OperatorMethodOutput<'memory.records.get'>;
export type MemoryRecord = MemoryRecordEntityResult['record'];
export type MemoryScope = MemoryRecord['scope'];
export type MemoryClass = MemoryRecord['cls'];
export type MemoryReviewState = MemoryRecord['reviewState'];
export type MemoryProvenanceLink = MemoryRecord['provenance'][number];
export type MemoryProvenanceKind = MemoryProvenanceLink['kind'];

/**
 * The search reply. `mode` is the path that actually ran ('literal' even when semantic
 * was asked for but the index could not be consulted), and `indexUnavailableReason` is
 * then shown verbatim, never swallowed into a silent empty result. The recall fields are
 * the receipt for `recall: true`; `recallFloor` is the store's confidence floor, so a
 * label states it without hardcoding a number.
 */
export type MemorySearchResult = OperatorMethodOutput<'memory.records.search'>;
/** `deleted: false` when nothing existed under that id. */
export type MemoryRecordDeleteResult = OperatorMethodOutput<'memory.records.delete'>;
/** The contract leaves the queue's items open; they are memory records, which the review views read field by field. */
export interface MemoryReviewQueueResult {
  readonly records: readonly MemoryRecord[];
}

/**
 * What each consolidation pass scanned, merged, archived, decayed and PROPOSED. A
 * proposal's records are already in the review queue, so "route to review" means finding
 * those ids there. `route` is an agent-tool invocation string, never rendered as a link.
 */
export type MemoryConsolidationReceiptsResult = OperatorMethodOutput<'memory.consolidation.receipts'>;
export type MemoryConsolidationRunReceipt = MemoryConsolidationReceiptsResult['receipts'][number];
export type MemoryConsolidationProposal = MemoryConsolidationReceiptsResult['pendingProposals'][number];

/** `recall: true` applies the recall-injection contract server-side; a browse/review caller leaves it off to see flagged records too. */
export type MemorySearchInput = OperatorMethodInput<'memory.records.search'>;
export type MemoryAddInput = OperatorMethodInput<'memory.records.add'>;
/** The record's own words and scope, edited in place (memory.records.update); omitted fields stay as they are. */
export type MemoryUpdateInput = Pick<OperatorMethodInput<'memory.records.update'>, 'summary' | 'detail' | 'tags' | 'scope'>;
export type MemoryUpdateReviewInput = OmitDeclared<OperatorMethodInput<'memory.records.update-review'>, 'id'>;
export type MemoryReviewQueueInput = OperatorMethodInput<'memory.review-queue'>;

// ─── Web Push (push.*) ───────────────────────────────────────────────────────
// The daemon never returns a subscription's endpoint or keys: the read shape is the
// redacted public view (origin and a hash). The browser holds the full endpoint and keys
// only transiently, from its own PushManager, to hand to push.subscriptions.create.

export type PushSubscriptionCreateInput = OperatorMethodInput<'push.subscriptions.create'>;
export type PushSubscriptionKeys = PushSubscriptionCreateInput['keys'];
/** Reconcile heals the daemon's record for a device it already knows, so `deviceId` is required here. */
export type PushSubscriptionReconcileInput = OperatorMethodInput<'push.subscriptions.reconcile'>;
export type PublicPushSubscription = OperatorMethodOutput<'push.subscriptions.list'>['subscriptions'][number];
/** This operator's push devices and the most recent device the daemon removed, with why. */
export type PushSubscriptionListResult = OperatorMethodOutput<'push.subscriptions.list'>;
export type PushSubscriptionRemoval = NonNullable<PushSubscriptionListResult['lastRemoval']>;
/** What reconcile changed: created, endpoint-updated, keys-updated or unchanged. */
export type PushReconcileDrift = OperatorMethodOutput<'push.subscriptions.reconcile'>['drift'];

// ─── Pairing (pairing.tokens.*, pairing.handoff.*, pairing.posture.get) ──────
// The literal token string comes back only once, at mint time; list, rename and delete
// see the redacted view (id, name, timestamps).

export type PublicPairingToken = OperatorMethodOutput<'pairing.tokens.list'>['tokens'][number];
export type PublicRelayCode = OperatorMethodOutput<'relay.codes.list'>['codes'][number];
/** An origin's TLS/capability posture: each browser-gated capability is available or carries the daemon's own reason. */
export type OriginPosture = OperatorMethodOutput<'pairing.posture.get'>['posture'];
export type PairingHandoffCompleteInput = OperatorMethodInput<'pairing.handoff.complete'>;
type PairingHandoffAccept = NonNullable<PairingHandoffCompleteInput['accept']>;
export type PairingHandoffCompleteNotificationsAccept = NonNullable<PairingHandoffAccept['notifications']>;
export type PairingHandoffCompletePasskeyAccept = NonNullable<PairingHandoffAccept['passkey']>;
/** One accepted offer's outcome, never silently half-applied. */
export type PairingHandoffOutcome = OperatorMethodOutput<'pairing.handoff.complete'>['results'][number];

// ─── WebAuthn step-up (stepup.*) ─────────────────────────────────────────────

/** A minted, short-lived, single-use challenge for navigator.credentials.get. */
export type StepUpMintChallengeResult = OperatorMethodOutput<'stepup.challenge.mint'>;
/** A passkey the daemon will verify step-up assertions against. */
export type StepUpRegisterCredentialInput = OperatorMethodInput<'stepup.credentials.register'>;
/** One registered step-up passkey as the daemon reports it (no key material). */
export type StepUpCredentialSummary = OperatorMethodOutput<'stepup.credentials.list'>['credentials'][number];

// ─── Config and credentials ──────────────────────────────────────────────────

/** config.set's and config.reset's outcome: where the value landed (`persistedTo`), its tier, and whether the daemon owns the key. */
export type ConfigSetOutcome = AppliedAnswer<OperatorMethodOutput<'config.set'>>;
/** config.setMany's outcome: the configuration revision and, per key, what the host now holds and where. */
export type ConfigSetManyOutcome = AppliedAnswer<OperatorMethodOutput<'config.setMany'>>;
/** Where credentials.set put the credential, never the value. */
export type CredentialSetOutcome = OperatorMethodOutput<'credentials.set'>;

// ─── Payment cards (payments.cards.*) ────────────────────────────────────────

/**
 * A stored card as every surface may see it: metadata only. There is no field for the
 * number, the expiry as typed, the CVV or the cardholder name, because the daemon has no
 * method that returns them. `issuerCapMinorUnits` is the owner's declaration (a purchase over it is refused before
 * checkout); `materialComplete` says whether every secret field is present, never
 * which, and never the values.
 */
export type PaymentCardMetadata = OperatorMethodOutput<'payments.cards.list'>['cards'][number];

/** What `payments.cards.create` accepts. Card material goes in here and never comes back out. */
export type PaymentCardCreateRequest = OperatorMethodInput<'payments.cards.create'>;

const scopedPlatform = createBrowserKnowledgePlatform({
  baseUrl: GOODVIBES_BASE_URL,
  tokenStore,
  // routedFetch (lib/relay-connection.ts) is the plain global fetch whenever no relay
  // pairing exists or the direct path is reachable, this is a no-op for the common
  // LAN/co-located case. It only diverts to the relay-tunneled fetch once
  // useDaemonHealth's probe has determined the direct path is genuinely down AND a
  // relay pairing is stored. Stream requests are tunnelled too (the relay carries event
  // streams now), and a mutating call gated by the daemon's step-up requirement triggers
  // the inline passkey ceremony and is retried with the assertion attached (see that
  // file's header).
  fetch: routedFetch,
  realtime: {
    sseReconnect: DEFAULT_SSE_RECONNECT,
  },
});

export const client = {
  auth: {
    current: () => scopedPlatform.auth.current(),
    getToken: () => tokenStore.getToken(),
    setToken: (token: string | null) => scopedPlatform.auth.setToken(token),
    clearToken: () => scopedPlatform.auth.clearToken(),
  },
  operator: {
    invoke: invokeOperator,
    control: {
      // A plain status read is receipt-NEUTRAL (never consumes). Once per
      // daemon connect, not per poll, pass { receipts: 'peek' } to receive
      // undelivered update/crash/migration receipts without marking them, then
      // { receipts: 'ack', ids } for the ones shown.
      status: (input?: { receipts?: 'peek' | 'ack'; ids?: string }) => scopedPlatform.operator.invoke('control.status', input ?? {}),
      snapshot: () => scopedPlatform.operator.invoke('control.snapshot', {}),
      // methodInfo: a read-only capability probe. The method being checked can be any
      // string, including one this daemon build has never heard of: an unregistered id
      // answers 404 rather than pretending. Callers use it to decide whether to offer a
      // capability rather than rendering it and letting it fail.
      methodInfo: (methodId: string) => invokeOperator('control.methods.get', { methodId }),
    },
    accounts: {
      snapshot: () => scopedPlatform.operator.invoke('accounts.snapshot', {}),
    },
    providers: {
      list: () => scopedPlatform.operator.invoke('providers.list', {}),
      get: (providerId: string) => scopedPlatform.operator.invoke('providers.get', { providerId }),
      usage: (providerId: string) => scopedPlatform.operator.invoke('providers.usage.get', { providerId }),
    },
    credentials: {
      // Cross-surface secret-free credential status. The browser reaches the shared
      // store only over the daemon. Status only, never bytes.
      get: () => invokeOperator('credentials.get'),
      // Writes a credential into the daemon's own secret store and leaves a
      // reference in config. ws-only (no REST binding), so it goes through the
      // generic invoke endpoint. The response never contains the value.
      set: (input: OperatorMethodInput<'credentials.set'>): Promise<CredentialSetOutcome> =>
        invokeGatewayMethod('credentials.set', input),
    },
    // stepup.*, the WebAuthn step-up ceremony's two server verbs. mintChallenge is the
    // bootstrap call the relay gate exempts from step-up (it is the prerequisite for
    // producing an assertion); registerCredential persists this device's passkey public
    // key so the daemon can verify later assertions. All four are REST-routed and
    // resolve through invokeOperator.
    stepup: {
      mintChallenge: (input?: OperatorMethodInput<'stepup.challenge.mint'>, signal?: AbortSignal): Promise<StepUpMintChallengeResult> =>
        invokeOperator('stepup.challenge.mint', input ?? {}, signal),
      registerCredential: (input: StepUpRegisterCredentialInput) =>
        invokeOperator('stepup.credentials.register', input),
      // The daemon's registered passkeys (admin-only).
      listCredentials: (signal?: AbortSignal) =>
        invokeOperator('stepup.credentials.list', {}, signal),
      removeCredential: (credentialId: string) =>
        invokeOperator('stepup.credentials.remove', { credentialId }),
    },
    // config.*, REST-routed through EXTRA_METHOD_ROUTES.
    // get() returns the daemon's FULL config tree unredacted (configManager.
    // getAll(), verified against system-routes.ts). Two consumers: the voice
    // surface reads the SHARED tts.provider/tts.voice defaults so the browser
    // speaks in the same voice as the TUI and agent; the model/config
    // workspace browses the same snapshot, callers there MUST run it through
    // src/lib/config-redaction.ts before rendering, never display it raw.
    // set() writes one key and reports where it landed (persistedTo, tier,
    // daemonOwned); setMany() writes settings that belong together as one update,
    // so a refusal leaves none of them half-applied.
    config: {
      get: () => invokeOperator('config.get'),
      set: async (key: string, value: unknown): Promise<ConfigSetOutcome> =>
        invokeOperator('config.set', { key, value: configSetValue(key, value) }),
      setMany: async (entries: readonly (readonly [string, unknown])[]): Promise<ConfigSetManyOutcome> =>
        invokeOperator('config.setMany', { entries: entries.map(([key, value]) => ({ key, value: configSetValue(key, value) })) }),
      // Removes the key's explicit value so it reads as its default again; the
      // outcome reports the value the daemon now holds and the file it came from.
      reset: (key: string): Promise<ConfigSetOutcome> => invokeOperator('config.reset', { key }),
    },
    // flags.status: restart-gated features whose saved setting the running
    // daemon has not applied yet (config.get carries saved values only).
    // ws-only verb, so it goes through the generic invoke endpoint.
    flags: {
      status: async (): Promise<FeatureRestartStatus> =>
        readFeatureRestartStatus(await requestJson('/api/control-plane/methods/flags.status/invoke', { method: 'POST', body: { body: {} } })),
    },
    // Restarts the daemon's managed service so saved startup settings apply; the
    // daemon refuses with its reason when service management is off.
    services: {
      restart: () => invokeOperator('services.restart', {}),
    },
    // payments.cards.*, the ONLY path card material takes off this surface.
    //
    // create() carries the number, expiry, CVV and cardholder name to the
    // daemon, which puts them in its own secret store encrypted at rest, under
    // keys derived from the config path, daemon scope, so the daemon can read
    // them for an unattended purchase with every surface closed. That is the
    // owner's standing rule: anything configured on a surface stays available
    // to the daemon after that surface is gone.
    //
    // payments.cards.* are REST-routed by the generated facade, so they resolve
    // through EXTRA_METHOD_ROUTES with no hand-written row, and create()'s
    // route is POST, which is what puts the card in the request BODY.
    // invokeOperator sends a GET method's input as a query string; a route
    // flipped to GET would therefore put a card number in a URL, in browser
    // history and in every server log along the way. payments-cards.test.ts
    // asserts the method stays POST for exactly that reason.
    //
    // There is deliberately NO read method for card material. list() answers
    // with metadata only (id, label, brand, last four, kind, expiry month/year,
    // declared issuer cap, and a materialComplete flag), and create()'s own
    // response is that same metadata, it never echoes what was submitted,
    // because an echo would be a read path and no read path exists.
    payments: {
      purchase: {
        status: readPurchaseWindows,
        stopOperation: stopPurchaseOperation,
        reconcile: reconcilePurchaseOperation,
        approve: (input: Pick<PaymentWindowView, 'purchaseId' | 'windowId'>, signal?: AbortSignal) => answerPurchaseWindow('approve', input, signal),
        deny: (input: Pick<PaymentWindowView, 'purchaseId' | 'windowId'>, signal?: AbortSignal) => answerPurchaseWindow('deny', input, signal),
        cancel: (input: Pick<PaymentWindowView, 'purchaseId' | 'windowId'>, signal?: AbortSignal) => answerPurchaseWindow('cancel', input, signal),
        securityCode: supplyPurchaseSecurityCode,
      },
      checkout: {
        // The owner approves one purchase in advance; a matching begin within five minutes spends it.
        approve: approvePurchaseInAdvance,
      },
      cards: {
        // list() also carries `defaultCardId`, the card the daemon would charge.
        list: () => invokeOperator('payments.cards.list', {}),
        create: (input: PaymentCardCreateRequest) => invokeOperator('payments.cards.create', input),
        delete: (id: string) => invokeOperator('payments.cards.delete', { id }),
      },
    },
    // Power (power.status.get / power.keepAwake.set), REST-routed through
    // EXTRA_METHOD_ROUTES. status/keepAwake.set return the SAME shape: `work` (the automatic inhibitor, held, grantedClasses,
    // deniedClasses, live "held because X" reasons, cap/expiry) and `keepAwake` (the
    // owner toggle, enabled, held, grantedClasses/deniedClasses, and an honest `note`
    // when part of the requested coverage was refused, e.g. lid-close suspend the OS
    // controls directly). Both emit runtime.ops OPS_POWER_STATE_CHANGED, which
    // useRealtimeInvalidation invalidates queryKeys.power on, see that hook's
    // DOMAIN_INVALIDATIONS map.
    power: {
      status: () => invokeOperator('power.status.get', {}),
      setKeepAwake: (enabled: boolean) => invokeOperator('power.keepAwake.set', { enabled }),
    },
    // Memory governance (ops.memory.get): the MemoryGovernor's own observability
    // snapshot, current pressure tier, budget vs RSS/heap, per-cache footprints the
    // governor can shrink, paused deferrable jobs, and the leak-tripwire state.
    // REST-routed through EXTRA_METHOD_ROUTES. OPS_MEMORY_PRESSURE rides the 'ops'
    // runtime domain (see useRealtimeInvalidation's DOMAIN_INVALIDATIONS map), the same
    // domain OPS_POWER_STATE_CHANGED already rides.
    ops: {
      memory: {
        get: () => invokeOperator('ops.memory.get', {}),
      },
    },
    // Voice. status/providers/voices are read:voice; stt/tts are write:voice.
    // ttsStream returns the RAW streamed-audio Response (not JSON), the Web Audio player
    // reads its bytes. All resolve through EXTRA_METHOD_ROUTES except ttsStream, which is
    // a raw fetch.
    voice: {
      status: () => invokeOperator('voice.status', {}),
      providers: () => invokeOperator('voice.providers.list', {}),
      voices: (providerId?: string) =>
        invokeOperator('voice.voices.list', providerId ? { providerId } : {}),
      stt: (input: OperatorMethodInput<'voice.stt'>) => invokeOperator('voice.stt', input),
      tts: (input: OperatorMethodInput<'voice.tts'>) => invokeOperator('voice.tts', input),
      ttsStream: (input: OperatorMethodInput<'voice.tts.stream'>, signal?: AbortSignal) =>
        requestStream('/api/voice/tts/stream', input, signal),
      // Managed local-voice provisioning (voice.local.status / voice.local.install).
      // install() is a single request/response call: the contract has no streamed
      // per-component progress, so callers get the final receipt, never intermediate ticks.
      local: {
        status: () => invokeOperator('voice.local.status', {}),
        install: () => invokeOperator('voice.local.install', {}),
      },
      // The one setup operation (voice.setup): the daemon plans from its own
      // facts, does what needs no answer, and returns the plan to print as-is.
      setup: (input: OperatorMethodInput<'voice.setup'>) => invokeOperator('voice.setup', input),
      // Wake-word detection in the browser tab (voice.wake.status /
      // voice.wake.provision / voice.wake.model.get).
      //
      // `model.get` exists because a browser tab CANNOT fetch the pinned release
      // assets directly: they answer without an access-control-allow-origin
      // header, so the browser refuses the response before the bytes arrive. The
      // daemon already holds and verifies the files, so it serves them in 512 kB
      // chunks; a caller loops on `offset` until `complete` and verifies the
      // assembled bytes against the returned (pinned) sha256 before creating an
      // inference session. `provision` is an explicit act, ~3.7 MB, single-flight,
      // never automatic.
      wake: {
        status: () => invokeOperator('voice.wake.status', {}),
        provision: () => invokeOperator('voice.wake.provision', {}),
        // Nested to mirror the verb id exactly (`voice.wake.model.get`, whose tail is
        // a verb, the core-verbs conformance gate rejects a noun there), the same way
        // `voice.local.status` nests under `local`.
        model: {
          get: (input: OperatorMethodInput<'voice.wake.model.get'>) => invokeOperator('voice.wake.model.get', input),
        },
      },
    },
    // models.* (GET /api/models, GET /api/models/current, PATCH /api/models/current).
    // `current` nests get/set to mirror the real verb ids
    // (models.current.get / models.current.set) exactly, the same way `wake.model.get`
    // nests above.
    models: {
      list: () => invokeOperator('models.list'),
      current: {
        get: () => invokeOperator('models.current.get'),
        // null CLEARS the persisted effort back to the provider default; omission leaves it untouched.
        set: (registryKey: string, effort?: string | null) =>
          invokeOperator('models.current.set', effort === undefined ? { registryKey } : { registryKey, effort }),
      },
    },
    tasks: {
      list: () => invokeOperator('tasks.list'),
      create: (input: TaskCreateInput) => invokeOperator('tasks.create', input),
      cancel: (taskId: string) => invokeOperator('tasks.cancel', { taskId }),
      retry: (taskId: string) => invokeOperator('tasks.retry', { taskId }),
    },
    // Calendar (calendar.*), REST-routed through EXTRA_METHOD_ROUTES.
    calendar: {
      events: {
        list: (input?: CalendarEventsListInput) =>
          invokeOperator('calendar.events.list', input ?? {}),
        get: (eventId: string, calendarId?: string) =>
          invokeOperator('calendar.events.get', { eventId, ...(calendarId ? { calendarId } : {}) }),
        create: (input: CalendarEventCreateInput) =>
          invokeOperator('calendar.events.create', input),
      },
      ics: {
        export: (input?: CalendarIcsExportInput) =>
          invokeOperator('calendar.ics.export', input ?? {}),
        import: (input: CalendarIcsImportInput) =>
          invokeOperator('calendar.ics.import', input),
      },
    },
    // Email (email.*), REST-routed through EXTRA_METHOD_ROUTES.
    email: {
      inbox: {
        list: (input?: EmailInboxListInput) =>
          invokeOperator('email.inbox.list', input ?? {}),
        read: (uid: number) =>
          invokeOperator('email.inbox.read', { uid }),
        // ws-only verbs, through the control-plane invoke endpoint like checkpoints.*.
        update: (input: OperatorMethodInput<'email.inbox.update'>) =>
          invokeGatewayMethod('email.inbox.update', input),
      },
      attachment: {
        get: (input: OperatorMethodInput<'email.attachment.get'>) =>
          invokeGatewayMethod('email.attachment.get', input),
      },
      drafts: {
        list: (input: OperatorMethodInput<'email.drafts.list'> = {}) =>
          invokeGatewayMethod('email.drafts.list', input),
      },
      send: (input: EmailSendInput) =>
        invokeOperator('email.send', input),
      draft: {
        create: (input: EmailDraftCreateInput) =>
          invokeOperator('email.draft.create', input),
        // Replaces the saved draft (uid + uidValidity from email.drafts.list): the folder keeps one copy. ws-only.
        // Typed here until the generated contract carries the method; sent through the generic invoke route.
        update: (input: EmailDraftUpdateInput) =>
          invokeGatewayMethod('email.draft.update' as never, input as never) as Promise<EmailDraftUpdateResult>,
      },
    },
    // Occasions and plans (occasions.*, docs/occasions.md).
    // Every verb is a real REST route (table-routed through
    // EXTRA_METHOD_ROUTES, same as checkin.*/ci.*/principals.*): occasions.confirm,
    // occasions.plans.confirm, the update verbs and the remove verbs write to the owner's profile and take
    // `authority`, callers pass the SAME WEBUI_PROFILE_AUTHORITY/WEBUI_PROFILE_SURFACE
    // owner-profile.ts exports (docs/occasions.md §7: these three verbs "write to the
    // owner's profile ... go through the profile's own write gate", the identical gate
    // profile.set/append/forget/undo answer to). Nothing here computes a proximity word,
    // a lead-time adjustment or a nudge date, every one of those stays server-side
    // (docs/occasions.md §7's own governing line: "a consumer that computed anything
    // beyond calling these and rendering the answers would be a second implementation of
    // a rule that lives in the daemon").
    occasions: {
      list: () => invokeOperator('occasions.list', {}),
      pending: () => invokeOperator('occasions.pending', {}),
      propose: (input: OperatorMethodInput<'occasions.propose'>) => invokeOperator('occasions.propose', input),
      confirm: (input: OperatorMethodInput<'occasions.confirm'>) => invokeOperator('occasions.confirm', input),
      remove: (input: OperatorMethodInput<'occasions.remove'>) => invokeOperator('occasions.remove', input),
      answer: (input: OperatorMethodInput<'occasions.answer'>) => invokeOperator('occasions.answer', input),
      gifts: (occasionId: string) => invokeOperator('occasions.gifts', { occasionId }),
      sweep: () => invokeOperator('occasions.sweep', {}),
      state: () => invokeOperator('occasions.state', {}),
      conflict: {
        resolve: (occasionId: string) => invokeOperator('occasions.conflict.resolve', { occasionId }),
      },
      interview: {
        get: (interviewId: string) => invokeOperator('occasions.interview.get', { interviewId }),
        answer: (input: OperatorMethodInput<'occasions.interview.answer'>) =>
          invokeOperator('occasions.interview.answer', input),
        record: (input: OperatorMethodInput<'occasions.interview.record'>) =>
          invokeOperator('occasions.interview.record', input),
      },
      plans: {
        list: () => invokeOperator('occasions.plans.list', {}),
        propose: (input: OperatorMethodInput<'occasions.plans.propose'>) =>
          invokeOperator('occasions.plans.propose', input),
        confirm: (input: OperatorMethodInput<'occasions.plans.confirm'>) =>
          invokeOperator('occasions.plans.confirm', input),
      },
    },
    // Channel profiles (channels.profiles.*) and the Telegram cursor recovery actions.
    channels: {
      telegramCursor: {
        preview: async (signal?: AbortSignal) => readTelegramCursorPreview(await telegramCursorAction('cursor-migration-preview', {}, signal)),
        commit: async (preview: Extract<TelegramCursorPreview, { readonly state: 'unbound' }>, signal?: AbortSignal) => {
          const { previewId, accountId, offset } = preview;
          const result = readTelegramCursorMigrationResult(await telegramCursorAction('cursor-migration-commit', { previewId, confirm: true }, signal));
          if (result.accountId !== accountId || result.offset !== offset) throw new Error('The cursor acknowledgement did not match the selected preview. Refresh its status.');
          return result;
        },
      },
      profiles: {
        list: () => invokeOperator('channels.profiles.list', {}),
        get: (surfaceKind: string, channelId?: string) =>
          invokeOperator('channels.profiles.get', channelId ? { surfaceKind, channelId } : { surfaceKind }),
        set: (input: OperatorMethodInput<'channels.profiles.set'>) => invokeOperator('channels.profiles.set', input),
        delete: (surfaceKind: string, channelId?: string) =>
          invokeOperator('channels.profiles.delete', channelId ? { surfaceKind, channelId } : { surfaceKind }),
      },
    },
    // Check-in (checkin.*): the proactive-contact configuration, its run receipts, and a
    // manual run-now trigger.
    checkin: {
      config: {
        get: () => invokeOperator('checkin.config.get', {}),
        set: (input: OperatorMethodInput<'checkin.config.set'>) => invokeOperator('checkin.config.set', input),
      },
      receipts: {
        list: (limit?: number) => invokeOperator('checkin.receipts.list', limit ? { limit } : {}),
      },
      run: () => invokeOperator('checkin.run', {}),
    },
    // Principals (principals.*): the named-identity registry.
    //
    // On the `{ id, ...input }` spread form used here and by sessions.steer / followUp /
    // messages.create: a property arriving THROUGH a spread is not excess-property
    // checked, so a stale key in the spread source compiles clean no matter how the
    // parameter is typed (measured, see the profile.forget guard block above).
    // These four are safe for a structural reason rather than a checked one: every spread
    // source is DERIVED from the contract (OperatorMethodInput<…>, or an Omit of it), so it
    // cannot hold a key the contract does not, and a retirement removes it from both sides
    // in the same regeneration. Replace any of these sources with a hand-authored type and
    // that protection is gone silently, such a type needs its own OnlyDeclaredKeys guard,
    // which is exactly why profile.forget has one.
    principals: {
      list: () => invokeOperator('principals.list', {}),
      get: (principalId: string) => invokeOperator('principals.get', { principalId }),
      create: (input: OperatorMethodInput<'principals.create'>) => invokeOperator('principals.create', input),
      update: (principalId: string, input: Omit<OperatorMethodInput<'principals.update'>, 'principalId'>) =>
        invokeOperator('principals.update', { principalId, ...input }),
      delete: (principalId: string) => invokeOperator('principals.delete', { principalId }),
      resolve: (input: OperatorMethodInput<'principals.resolve'>) => invokeOperator('principals.resolve', input),
    },
    // Owner profile (profile.*, docs/owner-profile.md §11.1): the one hand-editable
    // Markdown document at daemon scope holding what the platform knows about the owner
    //, identity, contact, location, commerce, preferences, people, places, work, notes.
    //
    // ROUTING: all nine are REST-routed through EXTRA_METHOD_ROUTES, which is derived
    // from the generated webui-facade artifact.
    //
    // AUTHORITY AND USER-REQUEST: the caller sends `authority` (WEBUI_PROFILE_AUTHORITY,
    // 'owner-direct', owner-profile.ts: the owner typing into their own settings page) on
    // every profile write, because the daemon answers an absent or unrecognised value with
    // a 400. `explicitUserRequest` is not sent: an absent one reads as no claim either way,
    // since no live transport populates it, and declaring it from here would be this
    // surface asserting something it cannot know. The gates that do NOT trust the
    // caller's self-description, the derivation check against the untrusted-content
    // ledger, and the requirement that a verbatim owner utterance exists, still run.
    //
    // CONTAINMENT: `person` takes a NAME and there is deliberately no enumerate-all
    // counterpart (§10), `read` returns everything and is for the owner looking at his
    // own profile, never for a composition path assembling outbound content.
    profile: {
      read: () => invokeOperator('profile.read', {}),
      get: (fieldId: string) => invokeOperator('profile.get', { fieldId }),
      person: (name: string) => invokeOperator('profile.person', { name }),
      provenance: (fieldId: string) => invokeOperator('profile.provenance', { fieldId }),
      set: (input: OperatorMethodInput<'profile.set'>) => invokeOperator('profile.set', input),
      append: (input: OperatorMethodInput<'profile.append'>) => invokeOperator('profile.append', input),
      // Narrower than OperatorMethodInput<'profile.forget'>, which still declares the
      // RETIRED lineIndex and makes every property optional: the daemon 400s on a body
      // missing a target, missing an authority, or carrying a lineIndex at all. A prose
      // line is named by its section and exact text, never its position (§9.2).
      forget: (input: ProfileForgetInput) => invokeOperator('profile.forget', input),
      undo: (input: OperatorMethodInput<'profile.undo'>) => invokeOperator('profile.undo', input),
      status: () => invokeOperator('profile.status', {}),
    },
    // CI (ci.*): per-job CI status polling (never a rollup without the job list, see
    // ci.status's own description) and standing watches.
    ci: {
      status: (input: OperatorMethodInput<'ci.status'>) => invokeOperator('ci.status', input),
      watches: {
        list: () => invokeOperator('ci.watches.list', {}),
        create: (input: OperatorMethodInput<'ci.watches.create'>) => invokeOperator('ci.watches.create', input),
        delete: (watchId: string) => invokeOperator('ci.watches.delete', { watchId }),
        run: (watchId: string) => invokeOperator('ci.watches.run', { watchId }),
      },
    },
    // approvals.*: the TOutput below is the contract's reply with the exec-prompt
    // attribution added (see ApprovalRecord).
    approvals: {
      // `approvalId` reads that one approval as it stands now (its revision included).
      list: (input: OperatorMethodInput<'approvals.list'> = {}) => invokeOperator('approvals.list', input),
      // selectedHunks: an index array into the pending approval's own
      // edit list. Omit it to approve the whole request. The daemon computes
      // modifiedArgs server-side, this call never carries a computed diff.
      // Each answer names the revision it was made against: one that moved meanwhile is refused with how it stands now.
      approve: async (approvalId: string, input: ApprovalApproveInput) =>
        invokeOperator('approvals.approve', approveInput(approvalId, input)),
      cancel: (approvalId: string, input: Pick<OperatorMethodInput<'approvals.cancel'>, 'expectedRevision'> = {}) =>
        invokeOperator('approvals.cancel', { approvalId, ...input }),
      claim: (approvalId: string, input: Pick<OperatorMethodInput<'approvals.claim'>, 'expectedRevision'>) =>
        invokeOperator('approvals.claim', { approvalId, ...input }),
      // deny sends the optional text as `note` (the audit trail) and `reason` (the
      // broker's structured user-declined feedback); `recorded.reasonStored` reports
      // whether the reason was kept.
      deny: (approvalId: string, input: ApprovalDenyInput) =>
        invokeOperator(
          'approvals.deny',
          { approvalId, disposition: 'denied', expectedRevision: input.expectedRevision, ...(input.note ? { note: input.note } : {}), ...(input.reason ? { reason: input.reason } : {}) },
        ),
    },
    // Durable approval rules (permissions.rules.*): the remembered-decision store,
    // listable and revocable. ws-only, so generic-invoke via invokeGatewayMethod.
    permissions: {
      rules: {
        list: () => invokeGatewayMethod('permissions.rules.list', {}),
        delete: (ruleId: string) => invokeGatewayMethod('permissions.rules.delete', { ruleId }),
      },
    },
    // memory.records.* / memory.review-queue / memory.consolidation.receipts,
    // REST-routed through EXTRA_METHOD_ROUTES.
    memory: {
      search: (input?: MemorySearchInput) => invokeOperator('memory.records.search', input ?? {}),
      add: (input: MemoryAddInput) => invokeOperator('memory.records.add', input),
      get: (id: string) => invokeOperator('memory.records.get', { id }),
      update: (id: string, input: MemoryUpdateInput) => invokeOperator('memory.records.update', { id, ...input }),
      updateReview: (id: string, input: MemoryUpdateReviewInput) =>
        invokeOperator('memory.records.update-review', { id, ...input }),
      delete: (id: string) => invokeOperator('memory.records.delete', { id }),
      // The contract leaves the queue's items open; MemoryReviewQueueResult reads them as records.
      reviewQueue: (input?: MemoryReviewQueueInput) =>
        invokeOperator<'memory.review-queue', MemoryReviewQueueResult>('memory.review-queue', input ?? {}),
      consolidation: {
        receipts: () => invokeOperator('memory.consolidation.receipts', {}),
        // ws-only, through the control-plane invoke endpoint.
        decide: (input: OperatorMethodInput<'memory.consolidation.decide'>) =>
          invokeGatewayMethod('memory.consolidation.decide', input),
      },
      // The store's point-in-time copies, through the generic invoke endpoint.
      snapshots: {
        list: async (signal?: AbortSignal): Promise<readonly MemoryCopy[]> =>
          readMemoryCopies(await requestJson('/api/control-plane/methods/memory.snapshots.list/invoke', { method: 'POST', body: { body: {} }, ...(signal ? { signal } : {}) })),
        // The owner's act: sent only from the confirmed restore button, as an explicit request.
        restore: async (snapshot: string, signal?: AbortSignal): Promise<MemoryRestoreOutcome> =>
          readMemoryRestore(await requestJson('/api/control-plane/methods/memory.snapshots.restore/invoke', {
            method: 'POST', body: { body: { snapshot, confirm: true } }, explicitUserRequest: true, ...(signal ? { signal } : {}),
          })),
      },
    },
    // contracts.get is REST-routed; contracts.summaries/status, fleet.*, checkpoints.*,
    // rewind.* and sessions.search are ws-only and go through invokeGatewayMethod,
    // typed by the contract-bridge-types.ts aliases.
    contracts: {
      // The list reads one summary per contract (counts, status, open question), never the tree.
      summaries: (input: ContractsSummariesInput = {}, signal?: AbortSignal): Promise<ContractsSummariesResult> =>
        invokeGatewayMethod('contracts.summaries', input, signal),
      // With the last revision seen, an unchanged contract answers `{ id, revision, notModified: true }`.
      status: (contractId: string, ifRevision: string | undefined, signal?: AbortSignal): Promise<ContractsStatusResult> =>
        invokeGatewayMethod('contracts.status', ifRevision === undefined ? { contractId } : { contractId, ifRevision }, signal),
      // The whole tree of one contract; the old per-file input list only when it is shown.
      get: (contractId: string, signal?: AbortSignal, options: { includeInputFiles?: boolean } = {}): Promise<ContractRecord> =>
        readContractMethod('contracts.get', options.includeInputFiles ? { contractId, includeInputFiles: true } : { contractId }, signal),
      cancel: async (contractId: string, signal: AbortSignal): Promise<OperatorMethodOutput<'contracts.cancel'>> => {
        const route = webuiRouteFor('contracts.cancel');
        if (route?.method !== 'POST') throw new Error('Contract cancellation is unavailable.');
        const input: OperatorMethodInput<'contracts.cancel'> = { contractId, reason: 'Cancelled by the user from WebUI.' };
        const { path, rest } = interpolateRoute(route, input);
        const result = await requestJson(path, { method: route.method, body: rest, signal });
        if (typeof result !== 'object' || result === null || !('cancelled' in result)
          || typeof result.cancelled !== 'boolean' || Object.keys(result).length !== 1) {
          throw new Error('The daemon returned an unreadable cancellation response.');
        }
        return { cancelled: result.cancelled };
      },
    },
    fleet: {
      snapshot: () => invokeGatewayMethod<'fleet.snapshot', FleetSnapshotResult>('fleet.snapshot', {}),
      list: (input?: FleetListInput) => invokeGatewayMethod<'fleet.list', FleetListResult>('fleet.list', input ?? {}),
      archive: (id: string) => invokeGatewayMethod<'fleet.archive', FleetArchiveResult>('fleet.archive', { id }),
      unarchive: (id: string) => invokeGatewayMethod<'fleet.unarchive', FleetUnarchiveResult>('fleet.unarchive', { id }),
      archiveFinished: () => invokeGatewayMethod<'fleet.archiveFinished', FleetArchiveFinishedResult>('fleet.archiveFinished', {}),
      archivedList: () => invokeGatewayMethod<'fleet.archived.list', FleetArchivedListResult>('fleet.archived.list', {}),
      // Act on what the node's capabilities offer; a node that does not offer the
      // action is refused FLEET_ACTION_UNAVAILABLE, an unknown id FLEET_NODE_NOT_FOUND.
      stop: (id: string, cascade = false) => invokeGatewayMethod('fleet.stop', cascade ? { id, cascade } : { id }),
      interrupt: (id: string) => invokeGatewayMethod('fleet.interrupt', { id }),
      resume: (id: string) => invokeGatewayMethod('fleet.resume', { id }),
      // Best-of-N attempt resolution. list is
      // read-only (held-merge candidate groups with per-candidate diffs + any prior judge
      // proposal); judge PROPOSES a winner with reasons, explicitly model judgment
      // (scoredBy:'model'), never an auto-pick; pick is the ONE-ACT verb: confirm defaults
      // to true here because every caller in this app (AttemptComparison's ConfirmSheet)
      // already ran its own human confirmation before calling pick, so the daemon should
      // actually apply, not hand back a preview that needs confirming a second time. Pass
      // confirm:false explicitly to get the structured preview (candidates + diffs + any
      // judge proposal) without applying anything. Output.applied says what really
      // happened, a caller must check it rather than assume confirm:true always merges
      // (a stale/no-longer-ready group can still come back requiresConfirm:true,
      // applied:false). An unknown/not-ready group is a 409 CONFLICT (lib/errors.ts
      // isConflictError), never a partial merge.
      attempts: {
        list: (workstreamId?: string) =>
          invokeGatewayMethod<'fleet.attempts.list', FleetAttemptsListResult>(
            'fleet.attempts.list',
            workstreamId ? { workstreamId } : {},
          ),
        pick: (groupId: string, winnerItemId: string, confirm = true) =>
          invokeGatewayMethod<'fleet.attempts.pick', FleetAttemptsPickResult>(
            'fleet.attempts.pick',
            { groupId, winnerItemId, confirm },
          ),
        judge: (groupId: string) =>
          invokeGatewayMethod<'fleet.attempts.judge', FleetAttemptsJudgeResult>('fleet.attempts.judge', { groupId }),
      },
      // graph.get: the dependency-graph view
      // of one workstream, nodes (id, title, state, cluster, files, merge state,
      // blocked reason, orphaned flag, deepest-remaining-path depth, stalled tell,
      // agent), edges (from depends-on to), and the elastic-pool state (ready/running
      // counts, at-cap, cap key + size, any spawn refusal). Unlike its fleet.* siblings
      // above (ws-only), this is REST-routed through EXTRA_METHOD_ROUTES with
      // workstreamId as a path param. 404s when the workstreamId is unknown to this daemon.
      graph: {
        get: (workstreamId: string) => invokeOperator('fleet.graph.get', { workstreamId }),
      },
      // observed.steer: steer an
      // externally-launched coding-agent session over its genuine channel (tmux
      // send-keys). `id` is the OBSERVED NODE's own id (observed:<pid>, not a
      // sessionId, these rows carry no sessionRef). ws-only, generic-invoke, same
      // family as fleet.attempts.* above. Callers must gate this on
      // node.observed.steer.kind === 'tmux' first, a 'none' channel means there is
      // nothing to steer, and the daemon's own honest reason should render instead
      // of ever calling this. The text is only typed unless `submit` is true, and the
      // call waits while the owner is asked to approve it.
      observed: {
        steer: (id: string, text: string, options?: { submit?: boolean }) =>
          invokeGatewayMethod<'fleet.observed.steer', FleetObservedSteerResult>('fleet.observed.steer', {
            id,
            text,
            ...(options?.submit === true ? { submit: true } : {}),
          }),
      },
    },
    checkpoints: {
      list: (input?: CheckpointsListInput) => invokeGatewayMethod<'checkpoints.list', CheckpointsListResult>('checkpoints.list', input ?? {}),
      create: (input: CheckpointsCreateInput) => invokeGatewayMethod<'checkpoints.create', CheckpointsCreateResult>('checkpoints.create', input),
      diff: (input: CheckpointsDiffInput) => invokeGatewayMethod<'checkpoints.diff', CheckpointsDiffResult>('checkpoints.diff', input),
      restore: (input: CheckpointsRestoreInput) =>
        invokeGatewayMethod<'checkpoints.restore', CheckpointsRestoreResult>('checkpoints.restore', input),
      restorePreview: (input: CheckpointsRestorePreviewInput) =>
        invokeGatewayMethod<'checkpoints.restorePreview', CheckpointsRestorePreviewResult>('checkpoints.restorePreview', input),
      // revertHunkPreview/revertHunk: the review-cockpit's REJECT→REVERT flow.
      // preview is read-only (validates the hunk still reverse-applies, mints a ~2min
      // single-use confirmToken, or answers applies:false with a human conflict string and
      // a null token); revertHunk consumes the token to snapshot-then-reverse-apply exactly
      // that one hunk. A stale/drifted hunk is an honest 409 CONFLICT (lib/errors.ts
      // isConflictError), never a partial write; the caller re-reads the diff and retries.
      revertHunkPreview: (input: CheckpointsRevertHunkPreviewInput) =>
        invokeGatewayMethod<'checkpoints.revertHunkPreview', CheckpointsRevertHunkPreviewResult>('checkpoints.revertHunkPreview', input),
      revertHunk: (input: CheckpointsRevertHunkInput) =>
        invokeGatewayMethod<'checkpoints.revertHunk', CheckpointsRevertHunkResult>('checkpoints.revertHunk', input),
    },
    // rewind.plan/apply: the unified message-anchored rewind, a terraform-style
    // dry-run/apply pair over the platform's history stores. plan previews what restoring
    // files and/or conversation to a turn anchor would change and mints a single-use
    // confirmToken; apply consumes it, records an undo point (a pre-restore safety checkpoint
    // and/or a captured conversation snapshot) so the rewind is itself reversible, and emits
    // REWIND_APPLIED. `transport: ["ws"]` only, generic-invoke-only like checkpoints.* above.
    // The conversation scope may be reported unavailable in the plan's `warnings` on a runtime
    // with no conversation store wired, SessionRewind renders that honestly, never faked.
    rewind: {
      plan: (input: RewindPlanInput) => invokeGatewayMethod<'rewind.plan', RewindPlanResult>('rewind.plan', input),
      apply: (input: RewindApplyInput) => invokeGatewayMethod<'rewind.apply', RewindApplyResult>('rewind.apply', input),
      undo: (input: OperatorMethodInput<'rewind.undo'>) => invokeGatewayMethod('rewind.undo', input),
    },
    sessions: {
      list: (signal?: AbortSignal) => invokeOperator('sessions.list', {}, signal),
      // get/steer/followUp/create/messages.*/inputs.* are native in the browser platform
      // (SHARED_BROWSER_ROUTES): they resolve without an EXTRA_METHOD_ROUTES row, through
      // invokeOperator's scopedPlatform.operator.invoke fall-through, typed by the contract.
      get: (sessionId: string, signal?: AbortSignal) => invokeOperator('sessions.get', { sessionId }, signal),
      steer: (sessionId: string, input: WithoutSessionId<OperatorMethodInput<'sessions.steer'>>, signal?: AbortSignal) =>
        invokeOperator('sessions.steer', { sessionId, ...input }, signal),
      followUp: (sessionId: string, input: WithoutSessionId<OperatorMethodInput<'sessions.followUp'>>, signal?: AbortSignal) =>
        invokeOperator('sessions.followUp', { sessionId, ...input }, signal),
      create: (input: OperatorMethodInput<'sessions.create'>) => invokeOperator('sessions.create', input),
      close: (sessionId: string, signal?: AbortSignal) => invokeOperator('sessions.close', { sessionId }, signal),
      reopen: (sessionId: string, signal?: AbortSignal) => invokeOperator('sessions.reopen', { sessionId }, signal),
      // Stop the turn the caller saw running: compare-and-cancel on expectedTurnId. The
      // answer is one of cancellation-requested, already-ended, stale-turn (with the
      // activeTurnId now running) or turn-not-found; the turn's terminal event settles it.
      turns: {
        cancel: (sessionId: string, expectedTurnId: string, signal?: AbortSignal) =>
          invokeOperator('sessions.turns.cancel', { sessionId, expectedTurnId }, signal),
      },
      // delete: requires the session to already be closed (409 SESSION_ACTIVE otherwise),
      // callers close first. `deleted: true` means the record and its messages are gone.
      delete: (sessionId: string, signal?: AbortSignal): Promise<SessionDeleteResult> =>
        invokeOperator('sessions.delete', { sessionId }, signal),
      // sessions.search: ws-only, generic-invoke via invokeGatewayMethod.
      search: (input?: SessionsSearchInput) => invokeGatewayMethod<'sessions.search', SessionsSearchResult>('sessions.search', input ?? {}),
      messages: {
        create: (sessionId: string, input: WithoutSessionId<OperatorMethodInput<'sessions.messages.create'>>) =>
          invokeOperator('sessions.messages.create', { sessionId, ...input }),
        // One page, newest first by offset: `offset` counts back from the newest message; the answer's nextOffset reads the page before.
        list: (sessionId: string, page?: { readonly limit?: number; readonly offset?: number }) =>
          invokeOperator('sessions.messages.list', { sessionId, ...(page?.limit !== undefined ? { limit: page.limit } : {}), ...(page?.offset !== undefined ? { offset: page.offset } : {}) }),
      },
      inputs: {
        list: (sessionId: string, signal?: AbortSignal) => invokeOperator('sessions.inputs.list', { sessionId }, signal),
        cancel: (sessionId: string, inputId: string) => invokeOperator('sessions.inputs.cancel', { sessionId, inputId }),
      },
      // toolCalls.cancel: stop ONE running tool
      // call mid-flight without ending the turn, the turn continues (e.g. the model
      // sees a cancelled tool result and can respond to it), unlike
      // companion.chat.turns.cancel which stops the whole turn. REST-routed with both
      // ids as path params.
      toolCalls: {
        cancel: (sessionId: string, callId: string) => invokeOperator('sessions.toolCalls.cancel', { sessionId, callId }),
      },
      // queuedMessages.list/edit/delete: a message
      // posted while another turn is still running sits queued (not yet delivered to the
      // model) until that turn ends. This lets a caller review, edit, or drop a queued
      // message before it is ever sent. REST-routed through EXTRA_METHOD_ROUTES.
      queuedMessages: {
        list: (sessionId: string) => invokeOperator('sessions.queuedMessages.list', { sessionId }),
        edit: (sessionId: string, messageId: string, text: string) =>
          invokeOperator('sessions.queuedMessages.edit', { sessionId, messageId, text }),
        delete: (sessionId: string, messageId: string) =>
          invokeOperator('sessions.queuedMessages.delete', { sessionId, messageId }),
      },
      // detach: remove ONE participant (surfaceId) from a shared
      // session, WITHOUT closing or killing it, detach != close != kill. Idempotent:
      // detaching an already-detached surface, or detaching from a closed session, is a
      // no-op success (verified against the platform's own sessions.detach description). Used
      // by FleetView's "detach this browser" action on a session-backed fleet node: stop
      // receiving live updates for a process you're done watching without touching the
      // process itself or any other surface attached to it (e.g. the TUI).
      detach: (sessionId: string, surfaceId: string) =>
        invokeOperator<'sessions.detach', SessionsDetachResult>('sessions.detach', { sessionId, surfaceId }),
      // permissionMode.get/set + contextUsage.get: session-scoped. Both answer only for
      // the daemon's own live local session (404 SESSION_NOT_LOCAL otherwise); callers
      // must check isSessionNotLocalError (lib/errors.ts) rather than assume success.
      permissionMode: {
        get: (sessionId: string) => invokeOperator('sessions.permissionMode.get', { sessionId }),
        set: (sessionId: string, mode: OperatorMethodInput<'sessions.permissionMode.set'>['mode']) =>
          invokeOperator('sessions.permissionMode.set', { sessionId, mode }),
      },
      contextUsage: {
        get: (sessionId: string) => invokeOperator('sessions.contextUsage.get', { sessionId }),
      },
      // changes.get: the session-scoped aggregate workspace diff, joined over checkpoints
      // stamped with this session's id (ws-only, generic-invoke). A session with no stamped
      // checkpoints answers honestly with checkpointCount:0 and an empty diff
      // (from/to:"EMPTY") rather than an error, SessionChanges.tsx renders that as an
      // explicit "no captured changes for this session" state with a workspace-scoped
      // fallback, never a blank. Older sessions predate sessionId stamping and always
      // land in that honest-empty branch; the checkpoints.* baseline picker remains the
      // explicit secondary/fallback mode for them.
      changes: {
        get: (sessionId: string) =>
          invokeGatewayMethod<'sessions.changes.get', SessionsChangesGetResult>('sessions.changes.get', { sessionId }),
      },
      // hosted.* (daemon-hosted sessions): a conversation whose loop runs INSIDE the
      // daemon rather than inside this browser tab, create/attach/detach/kill/list the
      // lifecycle; ws-only, generic-invoke like changes.get above. A
      // hosted session is steered with the ORDINARY sessions.steer/followUp/
      // toolCalls.cancel above, there is no sessions.hosted.steer (see the platform's
      // method-catalog-hosted-sessions.ts header comment), so none is wired here.
      hosted: {
        list: (input?: SessionsHostedListInput) =>
          invokeGatewayMethod<'sessions.hosted.list', SessionsHostedListResult>('sessions.hosted.list', input ?? {}),
        create: (input: SessionsHostedCreateInput) =>
          invokeGatewayMethod<'sessions.hosted.create', SessionsHostedCreateResult>('sessions.hosted.create', input),
        attach: (sessionId: string, clientId: string) =>
          invokeGatewayMethod<'sessions.hosted.attach', SessionsHostedAttachResult>('sessions.hosted.attach', { sessionId, clientId }),
        detach: (sessionId: string, clientId: string) =>
          invokeGatewayMethod<'sessions.hosted.detach', SessionsHostedDetachResult>('sessions.hosted.detach', { sessionId, clientId }),
        kill: (sessionId: string) =>
          invokeGatewayMethod<'sessions.hosted.kill', SessionsHostedKillResult>('sessions.hosted.kill', { sessionId }),
        // Add a principal (a user name, or pairing:<id>) to the session's owners: it may then attach, read and watch it.
        share: (sessionId: string, principalId: string) =>
          invokeGatewayMethod<'sessions.hosted.share', SessionsHostedShareResult>('sessions.hosted.share', { sessionId, principalId }),
        workspaces: () => invokeGatewayMethod('sessions.hosted.workspaces', {}),
        // The transcript of a live or ended hosted session, read without attaching.
        history: (sessionId: string, signal?: AbortSignal) =>
          invokeGatewayMethod('sessions.hosted.history', { sessionId }, signal),
      },
    },
    // watchers.stop: the fleet-node stop action for a watcher (fleet is a live-process
    // reader, not a watcher-authoring surface). Triggers are the Triggers screen's (command/screens).
    watchers: {
      stop: (watcherId: string): Promise<WatcherActionResult> => invokeOperator('watchers.stop', { watcherId }),
    },
    // push.* (Web Push), ws-only, generic-invoke. The PWA reads the public VAPID key,
    // registers/lists/removes its own browser subscription, and can send itself a live
    // test push. Every capability URL and key stays off the wire; the daemon hands back
    // the redacted view.
    push: {
      vapidKey: () => invokeGatewayMethod('push.vapid.get', {}),
      subscribe: (input: PushSubscriptionCreateInput) => invokeGatewayMethod('push.subscriptions.create', input),
      list: (): Promise<PushSubscriptionListResult> => invokeGatewayMethod('push.subscriptions.list', {}),
      unsubscribe: (subscriptionId: string) => invokeGatewayMethod('push.subscriptions.delete', { subscriptionId }),
      verify: (subscriptionId: string) => invokeGatewayMethod('push.subscriptions.verify', { subscriptionId }),
      // reconcile: the reconcile-on-open self-heal call, see
      // reconcilePushSubscriptionOnOpen in lib/push/push-client.ts.
      reconcile: (input: PushSubscriptionReconcileInput) => invokeGatewayMethod('push.subscriptions.reconcile', input),
    },
    // ─── Pairing (pairing.tokens.*, pairing.handoff.*, pairing.posture.get) ──────
    //
    // Per-device revocable pairing tokens: each paired surface (a phone, a second
    // laptop, …) gets its OWN named token, so revoking one device never signs out
    // every other device. ws-only, generic-invoke.
    //
    // handoff.* is the QR/deep-link bundle: create mints a per-device token AND
    // an offer set (notifications/relay/passkey, each independently declinable)
    // in one pass; complete drives the accepted offers. See usePairingHandoff
    // (src/hooks/usePairingHandoff.ts) for the client flow.
    pairing: {
      tokens: {
        list: () => invokeGatewayMethod('pairing.tokens.list', {}),
        create: (name: string) => invokeGatewayMethod('pairing.tokens.create', { name }),
        // migrate: mint a new per-device token for a client still on the legacy
        // shared token, without yet revoking it. Minted through the API, so the token
        // is an automation token; this browser moves with handoff.selfFromSharedToken.
        migrate: (name: string) => invokeGatewayMethod('pairing.tokens.migrate', { name }),
        rename: (id: string, name: string) => invokeGatewayMethod('pairing.tokens.rename', { id, name }),
        delete: (id: string) => invokeGatewayMethod('pairing.tokens.delete', { id }),
        // revokeShared: once every device has its own token, this ends every
        // copy of the shared token devices hold; the daemon replaces it with a
        // value only its own machine's apps read. legacySharedRevoked also comes
        // back on tokens.list, so a caller can render whether this happened.
        revokeShared: () => invokeGatewayMethod('pairing.tokens.revokeShared', {}),
      },
      handoff: {
        create: (name: string, offers?: readonly string[]) =>
          invokeGatewayMethod('pairing.handoff.create', offers && offers.length > 0 ? { name, offers } : { name }),
        // The owner's own browser, signed in with the shared operator token, pairs ITSELF
        // onto its own token through the owner's pairing flow: the token it gets is an
        // owner device (origin owner-pairing). pairing.tokens.migrate is a script's path
        // and gives an automation token.
        selfFromSharedToken: (name: string) =>
          invokeGatewayMethod('pairing.handoff.create', { name, offers: [], fromSharedToken: true }),
        complete: (input: PairingHandoffCompleteInput) => invokeGatewayMethod('pairing.handoff.complete', input),
      },
      // posture.get: the same honest TLS/capability read outside a pairing exchange, a
      // surface passes ITS OWN current origin (usePairingHandoff, useOriginPosture pass
      // window.location.origin) so the labels describe wherever it is actually running,
      // not wherever the daemon's configured web origin happens to be.
      posture: {
        get: (origin?: string) => invokeGatewayMethod('pairing.posture.get', origin ? { origin } : {}),
      },
    },
    // Per-device relay codes: every relay pairing carries a code of its own, so one
    // phone is cut off the relay without touching any other. ws-only, generic-invoke.
    relay: {
      codes: {
        list: () => invokeGatewayMethod('relay.codes.list', {}),
        revoke: (id: string) => invokeGatewayMethod('relay.codes.revoke', { id }),
      },
    },
    // cost.attribution.get: windowed (24h/7d), cache-aware-priced cost
    // attribution grouped by a dimension (agent/tool/hook/mcp/model/provider/session).
    // `transport: ["ws"]` only, generic-invoke-only like sessions.changes.get above.
    // Honest-unpriced: a row's costUsd is null when nothing in it could be priced,
    // costState says priced/estimated/unpriced, callers render that state, never treat
    // a null cost as zero. The per-session compact cost line (SessionsView) passes
    // dimension:"session" and reads the row whose key equals the session id.
    cost: {
      attribution: {
        get: (input: CostAttributionGetInput) =>
          invokeGatewayMethod<'cost.attribution.get', CostAttributionGetResult>('cost.attribution.get', input),
      },
    },
    // tailscale.get / tailscale.serve.run: the one confirmed action behind a "needs
    // https, available via tailscale" label. get is a read-only probe (binary present,
    // logged in, MagicDNS name, the https URL serve would yield, the last serve
    // receipt); a surface offers the action only when it reports a usable environment.
    // serve.run is the one state-changing tailscale command the daemon runs, only from
    // this explicit verb, with a receipt either way; on success web.publicBaseUrl
    // becomes the same https URL. serve.stop turns that serve off and puts
    // web.publicBaseUrl back when it still names the tailnet URL. ws-only, generic-invoke.
    tailscale: {
      get: () => invokeGatewayMethod('tailscale.get', {}),
      serveRun: () => invokeGatewayMethod('tailscale.serve.run', {}),
      serveStop: () => invokeGatewayMethod('tailscale.serve.stop', {}),
    },
  },
  chat: {
    sessions: {
      create: (input?: OperatorMethodInput<'companion.chat.sessions.create'>, signal?: AbortSignal) =>
        invokeOperator('companion.chat.sessions.create', input, signal),
      get: (sessionId: string) => invokeOperator('companion.chat.sessions.get', { sessionId }),
      list: (input?: OperatorMethodInput<'companion.chat.sessions.list'>) => invokeOperator('companion.chat.sessions.list', input),
      update: (sessionId: string, input: Parameters<typeof scopedPlatform.chat.sessions.update>[1]) =>
        invokeOperator('companion.chat.sessions.update', { sessionId, ...input }),
      // delete: App.tsx's delete flow does not take this reply as proof the record is
      // gone; it reconciles against a re-fetch (includeClosed:true).
      delete: (sessionId: string) => invokeOperator('companion.chat.sessions.delete', { sessionId }),
      // close: a genuinely NEW, distinct soft-close verb for companion chat
      // (companion.chat.sessions.close), separate from delete, see the
      // EXTRA_METHOD_ROUTES header comment for its capability-availability caveat on an
      // older daemon. Companion delete now requires the session to already be closed
      // (409 SESSION_ACTIVE otherwise), so App.tsx's delete flow calls this first,
      // tolerating a "not available yet" failure (isMethodUnavailableError) rather than
      // treating it as fatal, an older daemon's delete route still works exactly as it
      // always did (soft-close-only), which the reconcile step then honestly reports.
      close: (sessionId: string) => invokeOperator('companion.chat.sessions.close', { sessionId }),
      // reopen: a closed chat accepts messages again; `reopened: false` when it was open.
      reopen: (sessionId: string, signal?: AbortSignal) =>
        invokeOperator('companion.chat.sessions.reopen', { sessionId }, signal),
    },
    messages: {
      create: (sessionId: string, input: Parameters<typeof scopedPlatform.chat.messages.create>[1]) =>
        invokeOperator('companion.chat.messages.create', { sessionId, ...input }),
      list: (sessionId: string) => invokeOperator('companion.chat.messages.list', { sessionId }),
      // Message-text search across every chat, answered by the daemon in one request.
      search: (input: CompanionMessageSearchInput, signal?: AbortSignal) =>
        invokeOperator<'companion.chat.messages.search', CompanionMessageSearchResult>('companion.chat.messages.search', input, signal),
      steer: (sessionId: string, input: Parameters<typeof scopedPlatform.chat.messages.steer>[1]) =>
        invokeOperator('companion.chat.messages.steer', { sessionId, ...input }),
      // regenerate (companion.chat.messages.retry): re-run an assistant response
      // honestly. Omit messageId to regenerate the latest assistant reply. The prior
      // response is superseded (retained, flagged), never deleted, and a fresh turn
      // streams back over the same SSE channel.
      retry: (sessionId: string, input?: { messageId?: string }): Promise<CompanionRegenerateResult> =>
        invokeOperator('companion.chat.messages.retry', {
          sessionId,
          ...(input?.messageId ? { messageId: input.messageId } : {}),
        }),
      // edit-and-branch (companion.chat.messages.edit): edit a user message and branch
      // the conversation from it. The original (and everything after) is superseded
      // (retained, flagged); a new user message carrying `revisionOf` is appended and a
      // fresh turn answers it. The daemon route reads the edited text from `content`.
      edit: (sessionId: string, messageId: string, input: CompanionEditInput): Promise<CompanionEditResult> =>
        invokeOperator('companion.chat.messages.edit', {
          sessionId,
          messageId,
          content: input.content,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        }),
    },
    // Server-side turn stop (companion.chat.turns.cancel, platform 1.4+). The
    // terminal turn.cancelled event on the session stream is the authoritative
    // signal; treat 404 NO_ACTIVE_TURN as benign and feature-detect older
    // daemons with isMethodUnavailableError.
    turns: {
      cancel: (sessionId: string, input?: Parameters<typeof scopedPlatform.chat.turns.cancel>[1]) =>
        invokeOperator('companion.chat.turns.cancel', { sessionId, ...input }),
    },
    // A message sent while a reply is still being written waits for its turn; until
    // it starts, the owner can read, change or drop it (companion.chat.queuedMessages.*).
    queuedMessages: {
      list: (sessionId: string) => invokeOperator('companion.chat.queuedMessages.list', { sessionId }),
      edit: (sessionId: string, messageId: string, text: string) =>
        invokeOperator('companion.chat.queuedMessages.edit', { sessionId, messageId, text }),
      delete: (sessionId: string, messageId: string) =>
        invokeOperator('companion.chat.queuedMessages.delete', { sessionId, messageId }),
    },
    events: scopedPlatform.chat.events,
  },
  artifacts: scopedPlatform.artifacts,
  realtime: {
    // Errors belong to this fresh event bus, alongside its listeners and closer.
    // Keep the native platform in charge of authentication, resumption and reconnect.
    viaSse: (options?: {
      readonly signal?: AbortSignal | undefined;
      readonly onError?: ((error: unknown) => void) | undefined;
    }) => {
      const lifetime = getClientLifetime();
      const callerSignal = options?.signal;
      const onError = options?.onError;
      return createBrowserKnowledgePlatform({
        baseUrl: GOODVIBES_BASE_URL,
        tokenStore,
        fetch: routedFetch,
        realtime: {
          sseReconnect: DEFAULT_SSE_RECONNECT,
          onError: (error) => {
            if (!callerSignal?.aborted && isClientLifetimeCurrent(lifetime)) onError?.(error);
          },
        },
      }).realtime.viaSse({ signal: callerSignal });
    },
  },
  // Raw event stream escape hatch. The scoped viaSse() per-domain filter DROPS the
  // un-domained `session-update` wire event (browser-scoped.ts), so session liveness
  // must be consumed off the raw control-plane stream instead. Kept confined to
  // useSessionRealtime; the rest of the app uses the typed viaSse facade above.
  streams: {
    open: (
      pathOrUrl: string,
      handlers: RawStreamHandlers,
      options?: RawStreamOptions,
    ) => scopedPlatform.streams.open(pathOrUrl, handlers, options),
  },
  knowledge: scopedPlatform.knowledge,
  // The project work plan the daemon serves (projectPlanning.workPlan.*): the same
  // plan the terminal app, the Agent and the daemon's own work_plan tool keep.
  workPlan: scopedPlatform.workPlan,
};

export type RawStreamHandlers = Parameters<typeof scopedPlatform.streams.open>[1];
export type RawStreamOptions = Parameters<typeof scopedPlatform.streams.open>[2];

export { forSession };
export type GoodVibesClient = typeof client;
export type { OperatorMethodId, OperatorMethodInput, OperatorMethodOutput, OperatorTypedMethodId, RuntimeEventDomain };

export async function invokeMethod<TMethodId extends OperatorTypedMethodId>(
  methodId: TMethodId,
  input?: OperatorMethodInput<TMethodId>,
): Promise<OperatorMethodOutput<TMethodId>> {
  return client.operator.invoke(methodId, input);
}

/** Direct authenticated, cancellable call to the generated judgment route. */
export async function readBrowserDecisionPolicy(signal: AbortSignal) {
  signal.throwIfAborted();
  if (!browserDecisionPolicy.snapshot()) {
    const status = WEBUI_METHOD_ROUTES['control.status'];
    await requestJson(status.path, { signal });
    signal.throwIfAborted();
  }
  const state = browserDecisionPolicy.snapshot();
  if (!state) throw new Error('The daemon did not report its decision-model policy.');
  return state;
}

export async function runBrowserJudgment(
  input: OperatorMethodInput<'judgment.battery.run'>,
  signal: AbortSignal,
): Promise<OperatorMethodOutput<'judgment.battery.run'>> {
  const policy = await readBrowserDecisionPolicy(signal);
  if (policy.operation === 'no-decision-model') throw new DecisionModelsDisabledError(input.battery);
  const route = webuiRouteFor('judgment.battery.run');
  if (route?.method !== 'POST') throw new Error('Command judgment is unavailable.');
  try { return await requestJson(route.path, { method: route.method, body: input, signal }); }
  catch (error) {
    signal.throwIfAborted();
    const code = asRecord(asRecord(asRecord(error).body).error).code;
    if (code === 'JUDGMENT_NO_DECISION_MODEL') throw new DecisionModelsDisabledError(input.battery);
    throw error;
  }
}

export async function getCurrentAuth(): Promise<unknown> {
  // The daemon's control-plane/auth is a STATUS endpoint: it answers 200 even when
  // the presented credential is invalid/expired, carrying the real verdict in the
  // `authenticated` boolean (authMode 'invalid'/'anonymous'). The signed-in gate
  // (App.tsx) and the health signed-in axis (useDaemonHealth) both key off this call
  // THROWING to detect "signed out", a resolved call is taken as signed-in. Reject on
  // `authenticated !== true` with a 401/authentication error (NOT network/status-0, so
  // it is treated as unauthorized, sign-in front door, not as a daemon-unreachable
  // outage). On the direct route this read also moves the sign-in cookie's end with the
  // daemon session's, so a session in use stays signed in.
  const snapshot = await client.auth.current();
  const record = asRecord(snapshot);
  // Only an explicit `authenticated: true` is signed in: a reply without the field is a failed read, never a pass.
  if (record.authenticated !== true) {
    throw Object.assign(new Error('Sign-in rejected: the daemon reports this browser is not signed in.'), {
      status: 401,
      category: 'authentication',
      authMode: record.authMode,
    });
  }
  return snapshot;
}

interface LoginResponse {
  authenticated: boolean;
  token: string;
  username: string;
  expiresAt: number;
}

function buildLoginUrl(): string {
  return `${GOODVIBES_BASE_URL.replace(/\/+$/, '')}/login`;
}

function isLoginResponse(value: unknown): value is LoginResponse {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.authenticated === true
    && typeof record.token === 'string'
    && typeof record.username === 'string'
    && typeof record.expiresAt === 'number';
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Sign-ins and sign-outs of this page run one at a time, in the order they were asked
 * for, so a reply can never land over a newer one: on the direct route the reply itself
 * sets the cookie, so two sign-ins in flight at once would leave whichever answered last.
 */
let credentialQueue: Promise<unknown> = Promise.resolve();
function inCredentialOrder<T>(work: () => Promise<T>): Promise<T> {
  const run = credentialQueue.then(work, work);
  credentialQueue = run.catch(() => undefined);
  return run;
}

/**
 * Moves at every sign-in asked for and every sign-out. A sign-in whose number moved
 * before its reply (a sign-out, or another sign-in, was asked for meanwhile) is not
 * kept: what it set is ended at once.
 */
let credentialEpoch = 0;

function supersededSignIn(url: string): Error {
  return Object.assign(new Error('This sign-in finished after this browser signed out or signed in another way, so it was not kept. Sign in again if you still want this account.'), {
    status: 409,
    url,
    method: 'POST',
    category: 'superseded',
  });
}

/** The sign-in `POST /api/browser-session` or `POST /login` refused, in the shape every request error has. */
function signInRefusal(response: Response, url: string, body: unknown, label: string): Error {
  return Object.assign(new Error(`${label}: ${response.status} ${response.statusText}`.trim()), {
    status: response.status,
    url,
    method: 'POST',
    body,
    ...daemonErrorFields(response.status, body),
  });
}

/**
 * Direct route: the daemon binds what is presented (a code, a token, or a username and
 * password) to its HttpOnly, SameSite=Strict cookie and answers who is signed in, never
 * the credential. One request per sign-in.
 */
async function bindBrowserSession(credential: { readonly token: string } | { readonly username: string; readonly password: string }, epoch: number): Promise<Record<string, unknown>> {
  const url = `${GOODVIBES_BASE_URL.replace(/\/+$/, '')}/api/browser-session`;
  const response = await globalThis.fetch(url, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credential),
  });
  const body = await readJson(response);
  if (!response.ok) throw signInRefusal(response, url, body, 'token' in credential ? 'Sign-in code refused' : 'Login failed');
  if (credentialEpoch !== epoch) {
    // A sign-out or another sign-in was asked for while this one was answered: end what it set.
    await endDaemonSignIn(null);
    throw supersededSignIn(url);
  }
  invalidateClientLifetime();
  return asRecord(body);
}

export function login(username: string, password: string): Promise<unknown> {
  // The sign-in this call is: a sign-out, or another sign-in, asked for while it is in flight is newer and wins.
  const epoch = ++credentialEpoch;
  return inCredentialOrder(async () => {
    const url = buildLoginUrl();
    if (credentialEpoch !== epoch) throw supersededSignIn(url);
    if (getActiveRoute() !== 'relay') {
      const bound = await bindBrowserSession({ username, password }, epoch);
      return { authenticated: true, username: bound.principalId, expiresAt: bound.expiresAt };
    }
    // Relay route: the tunnel builds each request in this page, so the session token is held in memory only.
    const response = await routedFetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await readJson(response);
    if (!response.ok) throw signInRefusal(response, url, body, 'Login failed');
    if (!isLoginResponse(body)) {
      throw Object.assign(new Error('Login response did not include a session token'), {
        status: response.status, url, method: 'POST', body, category: 'contract',
      });
    }
    if (credentialEpoch !== epoch) {
      void endDaemonSignIn(body.token);
      throw supersededSignIn(url);
    }
    await tokenStore.setTokenEntry(body.token, body.expiresAt);
    return { authenticated: body.authenticated, username: body.username, expiresAt: body.expiresAt };
  });
}

/** A pairing link's sign-in started before the app's first request, by the code it presented. */
let primedSignIn: { readonly token: string; readonly result: Promise<unknown> } | null = null;

function normalizeSignInCode(rawToken: string): string {
  return rawToken.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Sign in with a pairing link's code before anything is sent, so the app's first
 * requests carry the new sign-in instead of going out with the old one (or none)
 * and being refused. The hand-off's setExplicitAuthToken reports its outcome.
 */
export async function primeAuthToken(rawToken: string): Promise<void> {
  const token = normalizeSignInCode(rawToken);
  if (!token) return;
  const result = signInWithCode(token);
  primedSignIn = { token, result };
  await result;
}

/**
 * Sign in with a code (`goodvibes pair`, a scanned QR, or a pasted device or operator
 * token). Direct route: bound to the daemon's HttpOnly cookie; a refused code changes
 * nothing, so the sign-in this browser already had stays. Relay route: held in memory
 * for this page and checked with the auth read; a code that is not accepted puts back
 * what was held before.
 */
export function setExplicitAuthToken(rawToken: string): Promise<unknown> {
  const token = normalizeSignInCode(rawToken);
  if (!token) return Promise.reject(new Error('Token is required'));
  const primed = primedSignIn;
  primedSignIn = null;
  if (primed?.token === token) return primed.result;
  return signInWithCode(token);
}

function signInWithCode(token: string): Promise<unknown> {
  const epoch = ++credentialEpoch;
  return inCredentialOrder(async () => {
    if (getActiveRoute() !== 'relay') {
      if (credentialEpoch !== epoch) throw supersededSignIn(`${GOODVIBES_BASE_URL}/api/browser-session`);
      return await bindBrowserSession({ token }, epoch);
    }
    const previous = await tokenStore.getTokenEntry();
    if (credentialEpoch !== epoch) throw supersededSignIn(buildLoginUrl());
    await tokenStore.setToken(token);
    const validationLifetime = getClientLifetime();
    try {
      return await getCurrentAuth();
    } catch (error) {
      if (getClientLifetime() === validationLifetime) await tokenStore.setTokenEntry(previous.token, previous.expiresAt);
      throw error;
    }
  });
}

/** What a sign-out did: always signed out here; `endedOnDaemon` false when the daemon's session could not be ended. */
export interface SignOutOutcome {
  readonly endedOnDaemon: boolean;
  readonly error?: string | undefined;
}

/**
 * What a sign-out could not end, held in memory only (never stored) so the retry can end
 * it: the relay-route bearer, and `null` for the direct-route sign-in (the browser still
 * holds its cookie, which only the daemon can clear). Gone on reload.
 */
let unendedSignIns: readonly (string | null)[] = [];

/** Ends each sign-in in turn; the outcome is ended only when every one was, and names the first failure. */
async function endDaemonSignIns(held: readonly (string | null)[]): Promise<{ readonly outcome: SignOutOutcome; readonly unended: readonly (string | null)[] }> {
  const unended: (string | null)[] = [];
  let error: string | undefined;
  for (const bearer of held) {
    const ended = await endDaemonSignIn(bearer);
    if (ended.endedOnDaemon) continue;
    unended.push(bearer);
    error ??= ended.error;
  }
  return { outcome: unended.length === 0 ? { endedOnDaemon: true } : { endedOnDaemon: false, error }, unended };
}

/**
 * `POST /logout`: ends the daemon session `bearer` names, or (null) the one this browser's
 * HttpOnly cookie holds, and clears that cookie and the identity marker. A credential that
 * is not a sign-in session (a device or operator token) leaves nothing to end.
 */
async function endDaemonSignIn(bearer: string | null): Promise<SignOutOutcome> {
  try {
    const url = `${GOODVIBES_BASE_URL.replace(/\/+$/, '')}/logout`;
    const response = bearer
      ? await routedFetch(url, { method: 'POST', credentials: 'omit', headers: { Authorization: `Bearer ${bearer}` } })
      : await globalThis.fetch(url, { method: 'POST', credentials: 'include', cache: 'no-store' });
    if (response.ok) return { endedOnDaemon: true };
    const body = asRecord(await readJson(response));
    // A pasted operator or device token is not a sign-in session (and an ended one is already gone): nothing is left to end.
    if (response.status === 401 && body.code === 'SESSION_UNKNOWN') return { endedOnDaemon: true };
    const reason = typeof body.error === 'string' ? body.error : response.statusText;
    return { endedOnDaemon: false, error: `the daemon answered ${response.status}${reason ? ` (${reason})` : ''}` };
  } catch (error) {
    return { endedOnDaemon: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    // The marker cookie moved (or the bearer went): every reply still in flight for the old sign-in is dropped.
    invalidateClientLifetime();
  }
}

/**
 * Sign out: a new identity generation first (every reply, login or transcript still in
 * flight for the old sign-in is dropped), the bearer held in memory is forgotten, then the
 * daemon session is ended with `POST /logout`, which also clears the direct-route cookie,
 * so the old credential stops working everywhere.
 */
export function signOut(): Promise<SignOutOutcome> {
  ++credentialEpoch;
  // A new identity generation even when nothing was held: a sign-in still in flight is older and is dropped.
  invalidateClientLifetime();
  // What was typed and not yet accepted belongs to this sign-in: it does not outlive it.
  clearHeldInputs();
  return inCredentialOrder(async () => {
    const bearer = await tokenStore.getToken();
    await tokenStore.clearToken();
    // The bearer held for the relay route, and the cookie the marker says this browser holds (both, after a route change).
    const held = [...(bearer ? [bearer] : []), ...(readSignedInIdentity() !== null || !bearer ? [null] : [])];
    const { outcome, unended } = await endDaemonSignIns(held);
    unendedSignIns = unended;
    return outcome;
  });
}

/** Try again to end the daemon session a sign-out could not end. */
export async function retryDaemonSignOut(): Promise<SignOutOutcome> {
  const held = unendedSignIns;
  if (held.length === 0) return { endedOnDaemon: true };
  const { outcome, unended } = await inCredentialOrder(() => endDaemonSignIns(held));
  if (unendedSignIns === held) unendedSignIns = unended;
  return outcome;
}

/** Give up ending the daemon session (it ends by its own expiry); what was held for the retry is forgotten. */
export function forgetUnendedSignIn(): void {
  unendedSignIns = [];
}

export function isRuntimeDomain(value: string): value is RuntimeEventDomain {
  return isRuntimeEventDomain(value);
}

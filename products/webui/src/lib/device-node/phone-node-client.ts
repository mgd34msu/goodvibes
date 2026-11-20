/**
 * phone-node-client.ts, this web app acting as a paired device node.
 *
 * The loop is the platform peer contract verbatim: request pairing, wait for the
 * operator to approve, verify with the challenge to receive a peer token, then
 * heartbeat and pull `device.capability` work, run it against the browser
 * bindings, and complete it. Nothing in this file is web-specific except the
 * capability bindings it calls, which is the seam a native node replaces.
 *
 * Authority stays on the host. This node never decides whether a capability may
 * run, by the time work reaches the queue the host has already confirmed it
 * with the person or matched a durable grant. What the node owns is the
 * platform action and an honest activity log of everything it did, so the
 * person holding the phone can see what happened on it.
 *
 * The peer token is never written to browser storage. On the direct route the
 * daemon binds it to an HttpOnly cookie of its own (`goodvibes_node`, sent only to
 * the peer routes; POST /api/browser-session/node), and only the node's id and
 * label are kept so a reload does not re-pair. On the relay route it is held in
 * memory for the life of the page, and a reload pairs again. It is validated
 * by USE, not by presence: a token the daemon rejects (revoked, rotated, or
 * from a daemon that has forgotten this node) is discarded on the spot and the
 * node returns to unpaired rather than retrying forever against a credential
 * that will never work again.
 *
 * Executed-work markers are persisted too (see PhoneNodeStorage.writeExecuted),
 * a bounded record of which work item ids this node has already run a
 * capability for, as `[workId, status]` only. Without it, a tab that dies
 * between running a capability and its completion report landing would come
 * back from reload with no memory of having already fired that real,
 * user-visible action, and the redelivered item would run it a second time.
 * The result itself (a photo, clipboard text, a location) stays in memory for
 * the life of the tab and is never written to the browser profile: captures
 * live under the daemon's retention rule, and a few bytes per marker never hit
 * the storage quota.
 */
import { FenceIssuer, type Fence } from '@goodvibes/engine/platform/platform/utils/owner-fence';
import {
  announcedCapabilities,
  readBrowserBindings,
  runWebNodeCapability,
  WEB_NODE_CONTRACT_VERSION,
  WEB_NODE_KIND,
  type BrowserBindings,
  type CapabilityRunResult,
} from './capability-bindings';

/** Where the node's id and label are kept between reloads (never its token). */
export const PHONE_NODE_IDENTITY_KEY = 'goodvibes.webui.phoneNode';

export type PhoneNodeStatus = 'unpaired' | 'pairing' | 'awaiting-approval' | 'connected' | 'error';

export interface PhoneNodeIdentity {
  readonly nodeId: string;
  /** The peer token, only while held in memory (relay route); absent when the HttpOnly node cookie carries it. */
  readonly token?: string | undefined;
  readonly label: string;
}

export interface PhoneNodeActivity {
  readonly at: number;
  readonly capabilityId: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** What is persisted per executed work item: its id's outcome, never its result. */
export type ExecutedWorkStatus = 'completed' | 'failed';

/**
 * A capability's outcome, remembered so a redelivered work item can be re-reported
 * without re-running it. `report` is held in memory only; a marker restored after a
 * reload has none.
 */
interface ExecutedWorkRecord {
  readonly status: ExecutedWorkStatus;
  readonly report?: { readonly result: unknown; readonly error: string | undefined };
}

export interface PhoneNodeState {
  readonly status: PhoneNodeStatus;
  readonly nodeId: string;
  readonly label: string;
  readonly announced: readonly string[];
  readonly pendingRequestId: string;
  readonly message: string;
  readonly activity: readonly PhoneNodeActivity[];
}

/** Where the executed-work markers are kept between reloads, see PhoneNodeStorage.writeExecuted. */
export const PHONE_NODE_EXECUTED_KEY = 'goodvibes.webui.phoneNode.executed';

/** Storage the node keeps its identity in; injected so tests do not need a browser. */
export interface PhoneNodeStorage {
  read(): PhoneNodeIdentity | null;
  write(identity: PhoneNodeIdentity): void;
  clear(): void;
  /**
   * Executed-work markers, [workId, status] pairs, oldest first. Read once at
   * construction to seed the in-memory dedupe map; written after every capability
   * run so a reload between running it and the completion report landing does
   * not lose the fact that it already ran. Optional: a storage that omits these
   * (an older test double, say) only loses redelivery protection ACROSS a
   * reload, pumpOnce()'s in-memory map still covers the lost-report-without-
   * reload case on its own.
   */
  readExecuted?(): readonly (readonly [string, ExecutedWorkStatus])[];
  writeExecuted?(entries: readonly (readonly [string, ExecutedWorkStatus])[]): void;
}

/** A stored marker's status. */
function executedStatus(value: unknown): ExecutedWorkStatus | undefined {
  return value === 'completed' || value === 'failed' ? value : undefined;
}

/** What a redelivered item is answered with when its result did not survive a reload. */
const RESULT_NOT_KEPT = 'Already executed on this device; the result was sent before, or lost when the page reloaded. It was not run again.';

export function browserPhoneNodeStorage(): PhoneNodeStorage {
  return {
    read(): PhoneNodeIdentity | null {
      try {
        const raw = window.localStorage.getItem(PHONE_NODE_IDENTITY_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PhoneNodeIdentity>;
        // Validated by shape, not by presence, a half-written entry is
        // discarded rather than used to build a request that cannot succeed.
        if (typeof parsed.nodeId !== 'string' || !parsed.nodeId) return null;
        return { nodeId: parsed.nodeId, label: typeof parsed.label === 'string' ? parsed.label : 'Phone' };
      } catch {
        return null;
      }
    },
    write(identity: PhoneNodeIdentity): void {
      try {
        // The id and label only: the token stays in the HttpOnly cookie (or in memory).
        window.localStorage.setItem(PHONE_NODE_IDENTITY_KEY, JSON.stringify({ nodeId: identity.nodeId, label: identity.label }));
      } catch {
        // A browser refusing storage means re-pairing after a reload, not a crash.
      }
    },
    clear(): void {
      try {
        window.localStorage.removeItem(PHONE_NODE_IDENTITY_KEY);
        window.localStorage.removeItem(PHONE_NODE_EXECUTED_KEY);
      } catch {
        // Nothing to do; the identity is dropped in memory regardless.
      }
    },
    readExecuted(): readonly (readonly [string, ExecutedWorkStatus])[] {
      try {
        const raw = window.localStorage.getItem(PHONE_NODE_EXECUTED_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        // Shape-validated the same way identity is: a half-written or foreign
        // entry is dropped rather than fed back in as a false dedupe marker.
        if (!Array.isArray(parsed)) return [];
        const markers: [string, ExecutedWorkStatus][] = [];
        for (const entry of parsed) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue;
          const status = executedStatus(entry[1]);
          if (status) markers.push([entry[0], status]);
        }
        return markers;
      } catch {
        return [];
      }
    },
    writeExecuted(entries: readonly (readonly [string, ExecutedWorkStatus])[]): void {
      try {
        window.localStorage.setItem(PHONE_NODE_EXECUTED_KEY, JSON.stringify(entries));
      } catch {
        // A browser refusing storage loses redelivery protection across a reload,
        // not a crash, pumpOnce()'s in-memory map still covers the same-tab case.
      }
    },
  };
}

export interface PhoneNodeClientOptions {
  readonly baseUrl: string;
  readonly label: string;
  readonly storage: PhoneNodeStorage;
  /**
   * HTTP transport. Typed as the call signature rather than `typeof fetch` so a
   * test can supply a plain function without also implementing the browser's
   * non-standard extras (`preconnect`).
   */
  readonly fetchImpl?: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined;
  /**
   * True when a token the pairing returns is to be held in memory for this page (the
   * relay route) instead of bound to the daemon's HttpOnly node cookie. Absent: bound.
   */
  readonly holdTokenInMemory?: (() => boolean) | undefined;
  readonly bindings?: BrowserBindings | undefined;
  /** Runs one capability; `fence` ends when the node stops or unpairs, and the camera and screen paths race it. */
  readonly runCapability?: ((capabilityId: string, input: Record<string, unknown>, fence: Fence) => Promise<CapabilityRunResult>) | undefined;
  readonly onState?: ((state: PhoneNodeState) => void) | undefined;
  readonly pullIntervalMs?: number | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly maxActivityRows?: number | undefined;
}

interface PairRequestResponse {
  readonly request?: { readonly id?: string };
  readonly challenge?: string;
}

interface PairVerifyResponse {
  readonly peer?: { readonly id?: string };
  readonly token?: { readonly value?: string };
}

interface WorkItem {
  readonly id: string;
  readonly type?: string;
  readonly command?: string;
  readonly payload?: unknown;
}

/** Activity rows are bounded, an append-only log in a long-lived tab is a leak. */
const DEFAULT_MAX_ACTIVITY = 50;

/**
 * Bounded the same way the activity log is: a long-lived tab must not grow this
 * without limit, and the daemon's lease window (tens of seconds) is far shorter
 * than what it would take to evict a still-relevant entry at this cap.
 */
const DEFAULT_MAX_EXECUTED = 50;

const MISSING_PERMISSION_MESSAGE = 'The daemon refused this device\'s request because its token lacks a permission. The pairing is kept; ask the operator to grant the permission, or unpair and pair again.';
const PAIRED_IDLE_MESSAGE = 'Paired. Waiting for requests.';

export class PhoneNodeClient {
  private readonly options: PhoneNodeClientOptions;
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly bindings: BrowserBindings;
  private identity: PhoneNodeIdentity | null;
  private state: PhoneNodeState;
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingChallenge = '';
  /** The lifetime whose pump is in flight; per lifetime so a stale pump cannot clear a newer one's flag. */
  private busyLifetime: AbortController | null = null;
  private lifetime = new AbortController();
  /** The paired identity's generation of capability runs: an unpair or a refused token ends every run still waiting on a device. */
  readonly #runs = new FenceIssuer('phone node capability');
  /**
   * Work item ids whose capability has already run, keyed to their outcome and,
   * for items run by this tab, the report. Checked at the top of runWork() so a
   * redelivery, caused by our completion report never landing (lost network, or
   * the tab dying between running the capability and posting the report),
   * retries only the report, never the capability itself. Seeded from
   * storage.readExecuted() at construction so the marker survives a reload; the
   * report does not. See runWork(), rememberExecuted(), and completeWork().
   */
  private readonly executedWork: Map<string, ExecutedWorkRecord>;
  /** Item ids whose capability is running now, across stop()/start() lifetimes of this client. */
  private readonly inFlightWork = new Set<string>();
  /** Calls the daemon is currently refusing for a missing scope; each call needs its own scope. */
  private readonly refusedCalls = new Set<'heartbeat' | 'pull' | 'complete'>();

  constructor(options: PhoneNodeClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.bindings = options.bindings ?? readBrowserBindings();
    this.executedWork = new Map((options.storage.readExecuted?.() ?? []).map(([workId, status]) => [workId, { status }] as const));
    this.identity = options.storage.read();
    this.state = {
      status: this.identity ? 'connected' : 'unpaired',
      nodeId: this.identity?.nodeId ?? '',
      label: this.identity?.label ?? options.label,
      announced: announcedCapabilities(this.bindings),
      pendingRequestId: '',
      message: this.identity
        ? 'Paired. Waiting for requests.'
        : 'Not paired yet. Ask to pair, then approve it from the desktop.',
      activity: [],
    };
  }

  getState(): PhoneNodeState {
    return this.state;
  }

  private setState(patch: Partial<PhoneNodeState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState?.(this.state);
  }

  private note(capabilityId: string, ok: boolean, detail: string): void {
    const max = this.options.maxActivityRows ?? DEFAULT_MAX_ACTIVITY;
    const activity = [{ at: Date.now(), capabilityId, ok, detail }, ...this.state.activity].slice(0, max);
    this.setState({ activity });
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private isCurrent(lifetime: AbortController): boolean {
    return lifetime === this.lifetime && !lifetime.signal.aborted;
  }

  private async post(path: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
    const lifetime = this.lifetime;
    if (!this.isCurrent(lifetime)) return { status: 499, json: null };
    let response: Response;
    try { response = await this.fetchImpl(this.url(path), {
      signal: lifetime.signal,
      method: 'POST',
      // A paired node on the direct route is carried by its HttpOnly cookie.
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    }); } catch (error) {
      if (!this.isCurrent(lifetime)) return { status: 499, json: null };
      throw error;
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!this.isCurrent(lifetime)) return { status: 499, json: null };
    return { status: response.status, json };
  }

  /**
   * A pairing attempt failed. While a valid stored identity still exists the node
   * IS paired, so showing `error` would contradict the token we keep (and a reload
   * would flip it back to `connected`): fall back to `connected` and say what failed.
   */
  private failPairing(message: string): void {
    if (this.identity) {
      this.pendingChallenge = '';
      this.setState({
        status: 'connected',
        pendingRequestId: '',
        message: `${message} This device is still paired with its previous pairing.`,
      });
      return;
    }
    this.setState({ status: 'error', message });
  }

  /** Ask the daemon to pair this browser as a device node. */
  async requestPairing(): Promise<void> {
    this.stop();
    this.lifetime = new AbortController();
    const lifetime = this.lifetime;
    try {
      this.setState({ status: 'pairing', message: 'Asking the daemon to pair…' });
      const announced = announcedCapabilities(this.bindings);
      const { status, json } = await this.post('/api/remote/pair/request', {
        peerKind: 'device',
        label: this.options.label,
        platform: typeof navigator === 'undefined' ? 'web' : navigator.platform || 'web',
        deviceFamily: 'phone',
        clientMode: 'device-node',
        capabilities: announced,
        commands: announced,
        metadata: {
          deviceNode: {
            nodeKind: WEB_NODE_KIND,
            contractVersion: WEB_NODE_CONTRACT_VERSION,
            capabilities: announced,
            secureContext: this.bindings.isSecureContext,
          },
        },
      });
      if (!this.isCurrent(lifetime)) return;
      if (status >= 400) {
        this.failPairing(`The daemon refused the pairing request (HTTP ${status}).`);
        return;
      }
      const parsed = (json ?? {}) as PairRequestResponse;
      const requestId = typeof parsed.request?.id === 'string' ? parsed.request.id : '';
      this.pendingChallenge = typeof parsed.challenge === 'string' ? parsed.challenge : '';
      if (!requestId || !this.pendingChallenge) {
        this.failPairing('The daemon answered without a pairing challenge.');
        return;
      }
      this.setState({
        status: 'awaiting-approval',
        pendingRequestId: requestId,
        announced,
        message: 'Waiting for approval on the desktop. Approve this device there, then press Finish pairing.',
      });
    } catch {
      if (this.isCurrent(lifetime)) this.failPairing('Could not reach the daemon. Ask to pair again.');
    }
  }

  /** Complete pairing once the operator has approved the request. */
  async verifyPairing(): Promise<void> {
    // A stop() (view teardown, polling halted) aborts the lifetime but leaves the
    // pending request intact; finishing it is a deliberate user action, so it gets a
    // fresh lifetime rather than an aborted one that would fail every request silently.
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    const lifetime = this.lifetime;
    try {
      if (!this.state.pendingRequestId || !this.pendingChallenge) {
        this.failPairing('There is no pairing request to finish. Ask to pair again.');
        return;
      }
      const { status, json } = await this.post('/api/remote/pair/verify', {
        requestId: this.state.pendingRequestId,
        challenge: this.pendingChallenge,
      });
      if (!this.isCurrent(lifetime)) {
        // Superseded lifetimes belong to whoever replaced them. One that was only
        // stopped leaves the request pending, so say the check did not complete.
        if (lifetime === this.lifetime && this.state.status === 'awaiting-approval') {
          this.setState({ message: 'The pairing check was interrupted. Press Finish pairing again.' });
        }
        return;
      }
      if (status >= 400) {
        this.setState({
          status: 'awaiting-approval',
          message: status === 409 || status === 403
            ? 'Not approved yet. Approve this device on the desktop, then press Finish pairing again.'
            : `Pairing could not be finished (HTTP ${status}).`,
        });
        return;
      }
      const parsed = (json ?? {}) as PairVerifyResponse;
      const nodeId = parsed.peer?.id ?? '';
      const token = parsed.token?.value ?? '';
      if (!nodeId || !token) {
        this.failPairing('The daemon approved pairing but returned no device token.');
        return;
      }
      if (this.options.holdTokenInMemory?.() === true) {
        // Relay route: held for the life of this page only; a reload pairs again.
        this.identity = { nodeId, token, label: this.options.label };
      } else {
        // Direct route: the daemon keeps the token in an HttpOnly cookie no page script can read.
        const bound = await this.post('/api/browser-session/node', { token });
        if (!this.isCurrent(lifetime)) return;
        if (bound.status !== 200) {
          this.failPairing(`The daemon approved pairing but this browser could not keep the device credential (HTTP ${bound.status}). Ask to pair again.`);
          return;
        }
        this.identity = { nodeId, label: this.options.label };
        this.options.storage.write(this.identity);
      }
      this.pendingChallenge = '';
      this.setState({
        status: 'connected',
        nodeId,
        pendingRequestId: '',
        message: 'Paired. Waiting for requests.',
      });
    } catch {
      if (this.isCurrent(lifetime)) this.setState({ status: 'awaiting-approval', message: 'Could not finish pairing. Check the connection and retry.' });
    }
  }

  /** Clears the HttpOnly node cookie a direct-route pairing set; best effort, the daemon may be unreachable. */
  private releaseCredential(): void {
    if (!this.identity || this.identity.token !== undefined) return;
    try {
      void this.fetchImpl(this.url('/api/browser-session/node/end'), { method: 'POST', credentials: 'include' }).catch(() => undefined);
    } catch { /* Nothing more to do: the cookie is refused by use once the pairing is revoked. */ }
  }

  /** Forget this device's pairing locally. */
  unpair(): void {
    this.releaseCredential();
    this.stop();
    this.#runs.issue();
    this.identity = null;
    this.refusedCalls.clear();
    this.executedWork.clear();
    this.options.storage.clear();
    this.setState({ status: 'unpaired', nodeId: '', pendingRequestId: '', message: 'This device is no longer paired here.' });
  }

  /**
   * A rejected token is discarded rather than retried: it means the operator
   * revoked or rotated it, and no amount of retrying will make it work again.
   */
  private handleAuthFailure(): void {
    this.releaseCredential();
    this.stop();
    this.#runs.issue();
    this.identity = null;
    this.refusedCalls.clear();
    this.executedWork.clear();
    this.options.storage.clear();
    this.setState({
      status: 'unpaired',
      nodeId: '',
      message: 'The daemon no longer accepts this device\'s token. It was revoked or rotated. Pair again to reconnect.',
    });
  }

  /**
   * A valid token the daemon refuses for lack of a scope is a permission gap, not a
   * revocation: the pairing and its redelivery markers stay, and the message says
   * what is missing so the operator can grant it instead of pairing again.
   */
  private handleMissingPermission(call: 'heartbeat' | 'pull' | 'complete'): void {
    this.refusedCalls.add(call);
    this.setState({ message: MISSING_PERMISSION_MESSAGE });
  }

  /**
   * Heartbeat, pull and complete need separate scopes, so a success of one call
   * must not hide a refusal of another: the notice goes only when none remain.
   */
  private clearMissingPermission(call: 'heartbeat' | 'pull' | 'complete'): void {
    this.refusedCalls.delete(call);
    if (this.refusedCalls.size === 0 && this.state.message === MISSING_PERMISSION_MESSAGE) this.setState({ message: PAIRED_IDLE_MESSAGE });
  }

  private async heartbeat(): Promise<void> {
    const lifetime = this.lifetime;
    if (!this.identity || !this.isCurrent(lifetime)) return;
    const announced = announcedCapabilities(this.bindings);
    const { status } = await this.post('/api/remote/heartbeat', {
      capabilities: announced,
      commands: announced,
      clientMode: 'device-node',
      metadata: {
        deviceNode: {
          nodeKind: WEB_NODE_KIND,
          contractVersion: WEB_NODE_CONTRACT_VERSION,
          capabilities: announced,
          secureContext: this.bindings.isSecureContext,
        },
      },
    }, this.identity.token);
    if (!this.isCurrent(lifetime)) return;
    if (status === 401) {
      this.handleAuthFailure();
      return;
    }
    if (status === 403) {
      this.handleMissingPermission('heartbeat');
      return;
    }
    if (status < 400) this.clearMissingPermission('heartbeat');
    if (this.state.announced.join(',') !== announced.join(',')) this.setState({ announced });
  }

  /** Pull one batch of work and run it. */
  async pumpOnce(): Promise<void> {
    const lifetime = this.lifetime;
    if (!this.identity || this.busyLifetime === lifetime || !this.isCurrent(lifetime)) return;
    this.busyLifetime = lifetime;
    try {
      const { status, json } = await this.post('/api/remote/work/pull', { maxItems: 3 }, this.identity.token);
      if (!this.isCurrent(lifetime)) return;
      if (status === 401) {
        this.handleAuthFailure();
        return;
      }
      if (status === 403) {
        this.handleMissingPermission('pull');
        return;
      }
      if (status >= 400) return;
      this.clearMissingPermission('pull');
      const items = Array.isArray((json as { work?: unknown }).work) ? (json as { work: WorkItem[] }).work : [];
      for (const item of items) {
        if (!this.isCurrent(lifetime)) break;
        await this.runWork(item);
      }
    } finally {
      if (this.busyLifetime === lifetime) this.busyLifetime = null;
    }
  }

  private async runWork(item: WorkItem): Promise<void> {
    const lifetime = this.lifetime;
    const identity = this.identity;
    if (!identity || !this.isCurrent(lifetime)) return;
    const executed = this.executedWork.get(item.id);
    if (executed) {
      // Redelivered: the daemon's lease on this item expired before our completion
      // report landed (dropped network, or this tab died between running the
      // capability and posting the report), so the queue offered it again. The
      // capability already fired its real, user-visible side effect once; report
      // the outcome we already have rather than running it a second time. After a
      // reload the result is gone (it is never stored), and the report says so.
      if (executed.report) await this.completeWork(item.id, executed.status, executed.report.result, executed.report.error);
      else await this.completeWork(item.id, 'failed', { contractVersion: WEB_NODE_CONTRACT_VERSION, alreadyExecuted: true, executedStatus: executed.status }, RESULT_NOT_KEPT);
      return;
    }
    // Another lifetime of this client (stop() then start()) may still be inside the
    // capability for this same item, for example waiting on a browser permission
    // prompt, when the daemon redelivers it after the lease expires.
    if (this.inFlightWork.has(item.id)) return;
    const payload = (item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? item.payload
      : {}) as Record<string, unknown>;
    const capabilityId = typeof payload.capabilityId === 'string' ? payload.capabilityId : (item.command ?? '');
    if (item.type !== 'device.capability' || !capabilityId) {
      await this.completeWork(item.id, 'failed', undefined, 'This node only serves device.capability work.');
      return;
    }
    const input = (payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
      ? payload.input
      : {}) as Record<string, unknown>;
    const runner = this.options.runCapability
      ?? ((id: string, capabilityInput: Record<string, unknown>, fence: Fence) => runWebNodeCapability(id, capabilityInput, fence, this.bindings));
    this.inFlightWork.add(item.id);
    // The run's fence: this generation of the node, ended by stop() (the lifetime) or an unpair.
    const fence = this.#runs.peek().narrow({ signal: lifetime.signal });
    let result: CapabilityRunResult;
    try {
      result = await runner(capabilityId, input, fence);
    } finally {
      this.inFlightWork.delete(item.id);
    }
    if (identity !== this.identity) return;
    if (this.isCurrent(lifetime)) this.note(capabilityId, result.ok, result.ok ? 'Served' : (result.error ?? 'Failed'));
    const status = result.ok ? 'completed' : 'failed';
    const completionResult = {
      contractVersion: WEB_NODE_CONTRACT_VERSION,
      capabilityId,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(result.mediaBase64 ? { mediaBase64: result.mediaBase64, mediaType: result.mediaType } : {}),
    };
    const completionError = result.ok ? undefined : result.error;
    // Marker persisted BEFORE the report is attempted: if completeWork's POST
    // never lands, a later redelivery of this same item id must still find the
    // marker and skip straight to re-reporting, not re-run the capability.
    // Preserve deduplication for an action already performed, even if polling stopped.
    // Unpairing changes identity and returns above without repopulating cleared storage.
    this.rememberExecuted(item.id, status, completionResult, completionError);
    if (!this.isCurrent(lifetime)) return;
    await this.completeWork(item.id, status, completionResult, completionError, capabilityId);
  }

  /**
   * Remember a capability's outcome for item.id, evicting the oldest entry past
   * the cap, and persist the bounded set of `[workId, status]` markers
   * synchronously (writeExecuted is a plain localStorage.setItem under
   * browserPhoneNodeStorage, it returns before this function does) so a tab dying
   * immediately afterward still has the marker on the next reload. The result is
   * kept in memory only.
   */
  private rememberExecuted(workId: string, status: ExecutedWorkStatus, result: unknown, error: string | undefined): void {
    this.executedWork.set(workId, { status, report: { result, error } });
    while (this.executedWork.size > DEFAULT_MAX_EXECUTED) {
      const oldestKey = this.executedWork.keys().next().value;
      if (oldestKey === undefined) break;
      this.executedWork.delete(oldestKey);
    }
    this.options.storage.writeExecuted?.([...this.executedWork].map(([id, record]) => [id, record.status] as const));
  }

  private async completeWork(workId: string, status: 'completed' | 'failed', result: unknown, error?: string, capabilityId = ''): Promise<void> {
    if (!this.identity) return;
    const { status: httpStatus } = await this.post(`/api/remote/work/${encodeURIComponent(workId)}/complete`, {
      workId,
      status,
      ...(result === undefined ? {} : { result }),
      ...(error ? { error } : {}),
    }, this.identity.token);
    if (httpStatus === 401) {
      this.handleAuthFailure();
      return;
    }
    if (httpStatus === 403 && this.isCurrent(this.lifetime)) this.handleMissingPermission('complete');
    else if (httpStatus < 400) this.clearMissingPermission('complete');
    // 499 is this client's own cancellation (stop or unpair), not a daemon answer.
    if (httpStatus >= 400 && httpStatus !== 499 && this.isCurrent(this.lifetime)) {
      // The marker stays, so the daemon's redelivery retries only this report.
      this.note(capabilityId || 'device.report', false, `The daemon did not record the completion report (HTTP ${httpStatus}); it will be sent again if the work is redelivered.`);
    }
  }

  /** Start heartbeating and pulling work. */
  start(): void {
    if (!this.identity) return;
    this.stop();
    this.lifetime = new AbortController();
    this.background(() => this.heartbeat());
    this.background(() => this.pumpOnce());
    this.heartbeatTimer = setInterval(() => { this.background(() => this.heartbeat()); }, this.options.heartbeatIntervalMs ?? 30_000);
    this.pullTimer = setInterval(() => { this.background(() => this.pumpOnce()); }, this.options.pullIntervalMs ?? 2_000);
  }

  private background(work: () => Promise<void>): void {
    const lifetime = this.lifetime;
    void work().catch((error: unknown) => {
      if (this.isCurrent(lifetime)) {
        this.setState({ message: error instanceof Error ? error.message : 'Device connection failed' });
      }
    });
  }

  stop(): void {
    this.lifetime.abort();
    if (this.pullTimer) { clearInterval(this.pullTimer); this.pullTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }
}

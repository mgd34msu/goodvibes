import { logger } from '../utils/logger.js';
/**
 * device-capability-service.ts, the one path a paired device's camera, screen,
 * location, clipboard, or device command is reached through.
 *
 * Every request walks the same steps, in this order:
 *   1. the node must be paired and must have announced the capability,
 *   2. configuration must allow the capability at all,
 *   3. the request's inputs must satisfy the capability's declared fields,
 *   4. a live grant is looked up; a live grant IS the authority, the request
 *      runs with no question and no model call,
 *   5. with no grant, `permissions.mode` decides who answers: under yolo the
 *      request runs; in every other mode the owner is asked through the shared
 *      approval path, with "always allow" offered so the answer is remembered
 *      as a durable grant (granting access is the owner's question, asked once),
 *   6. the work is dispatched to the node over the peer transport,
 *   7. bytes that came back are retained under the capture TTL and disclosed.
 *
 * A request admitted under a grant keeps a reference to it (its record key and
 * revision). Revoking that grant, on any machine of the group, withdraws the
 * work while it waits for the phone; the reference is checked again when the
 * phone picks it up, so a revocation that has reached this machine is never
 * run past. Otherwise only a change to the `device.*` settings that would
 * refuse this request, or the host shutting down, ends a request in flight,
 * and only before the phone has picked the work up: what a phone already did
 * is never thrown away.
 *
 * The dispatcher and the confirmation handler are injected, which is what keeps
 * this node-kind neutral: the same service serves a web PWA node and a native
 * node with no branch of its own.
 */
import {
  getDeviceCapability,
  type DeviceCapabilityDescriptor,
  type DeviceCapabilityId,
  type DeviceNodeProfile,
} from './device-capability-contract.js';
import type { DeviceCapabilityGrant, DeviceGrantStore } from './device-grants.js';
import type { DeviceCaptureArtifact, DeviceCaptureArtifactStore } from './device-capture-artifacts.js';
import { validateDeviceCapabilityInput } from './device-peer-work.js';
import { resolveDevicePolicySource, type DevicePolicySource } from './device-policy-source.js';

/** How the feature behaves overall (`device.capabilities.mode`). */
export type DeviceCapabilityMode = 'off' | 'ask-every-time' | 'honor-grants';

/** Which capabilities may be granted durably (`device.capabilities.allowAlwaysOffer`). */
export type DeviceAllowAlwaysOffer = 'every-capability' | 'standard-only' | 'never';

/** Location precision posture (`device.location.precision`). */
export type DeviceLocationPrecision = 'coarse-only' | 'ask-precise' | 'precise-grantable';

/** Clipboard read posture (`device.clipboard.readMode`). */
export type DeviceClipboardReadMode = 'off' | 'ask-only' | 'grantable';

/** The resolved configuration this service enforces. */
export interface DeviceCapabilityPolicy {
  readonly mode: DeviceCapabilityMode;
  readonly allowAlwaysOffer: DeviceAllowAlwaysOffer;
  readonly locationPrecision: DeviceLocationPrecision;
  readonly clipboardReadMode: DeviceClipboardReadMode;
  readonly requestTimeoutMs: number;
  readonly captureRetentionMs: number;
}

/**
 * Stock policy: grants are honoured, "always allow" is offered on every
 * capability, 24h capture retention, clipboard read present and grantable.
 */
export const DEFAULT_DEVICE_CAPABILITY_POLICY: DeviceCapabilityPolicy = {
  mode: 'honor-grants',
  allowAlwaysOffer: 'every-capability',
  locationPrecision: 'precise-grantable',
  clipboardReadMode: 'grantable',
  requestTimeoutMs: 60_000,
  captureRetentionMs: 24 * 60 * 60 * 1000,
};

/**
 * Who answers a request no live grant covers, read from `permissions.mode` per
 * request: 'allow' under yolo, 'ask-owner' in every other mode.
 */
export type DeviceNoGrantAuthority = 'ask-owner' | 'allow';

/** What the person chose when asked. */
export type DeviceConfirmationDecision = 'once' | 'always' | 'deny';

/** The question put to the person, verbatim fields and all. */
export interface DeviceConfirmationRequest {
  readonly nodeId: string;
  readonly nodeKind: string;
  readonly nodeLabel: string;
  readonly capabilityId: DeviceCapabilityId;
  readonly descriptor: DeviceCapabilityDescriptor;
  /** The caller's stated reason, shown verbatim. */
  readonly reason: string;
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * Whether the prompt offers a durable "always allow". True for every
   * capability under stock configuration.
   */
  readonly allowAlwaysOffered: boolean;
  readonly sessionId?: string | undefined;
}

export interface DeviceConfirmationResponse {
  readonly decision: DeviceConfirmationDecision;
  readonly actor: string;
  readonly note?: string | undefined;
}

export type DeviceConfirmationHandler = (
  request: DeviceConfirmationRequest,
) => Promise<DeviceConfirmationResponse>;

/**
 * The hold one request keeps on its queued work. The peer transport withdraws
 * the work when `signal` aborts before the phone has picked it up, and calls
 * `claim()` when the phone picks it up.
 */
export interface DeviceAdmission {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  claim(): void;
}

/** What came back from the node. */
export interface DeviceDispatchResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
  /** Structured payload (a location fix, clipboard text, a command ack). */
  readonly data?: unknown | undefined;
  /** Raw bytes for a capture. Retained under the capture TTL when present. */
  readonly bytes?: Uint8Array | undefined;
  readonly mediaType?: string | undefined;
  readonly workId?: string | undefined;
}

export interface DeviceDispatchInput {
  readonly nodeId: string;
  readonly capabilityId: DeviceCapabilityId;
  readonly input: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly admission?: DeviceAdmission | undefined;
}

/** Transport to the node. The peer work queue in the daemon; a stub in tests. */
export interface DeviceCapabilityDispatcher {
  dispatch(input: DeviceDispatchInput): Promise<DeviceDispatchResult>;
}

/** Why a request did not run. */
export type DeviceRequestRefusal =
  | 'node-unknown'
  | 'capability-unknown'
  | 'capability-unsupported'
  | 'capability-gated-by-secure-context'
  | 'disabled-by-config'
  | 'invalid-input'
  | 'denied-by-person'
  | 'dispatch-failed'
  /** The grant the request ran under was revoked before the phone picked it up: withdrawn, nothing ran. */
  | 'grant-revoked-before-claim'
  /** The grant was revoked after the phone picked the work up: it ran, and the detail says what took effect. */
  | 'grant-revoked-after-claim';

/**
 * How authority was established for one request: a live durable grant, the
 * owner's answer (once, or always, which recorded a grant), or
 * `permissions.mode` set to yolo.
 */
export type DeviceRequestAuthority = 'existing-grant' | 'confirmed-once' | 'confirmed-always' | 'permissions-mode';

export type DeviceCapabilityOutcome =
  | {
    readonly ok: true;
    readonly capabilityId: DeviceCapabilityId;
    readonly nodeId: string;
    readonly authority: DeviceRequestAuthority;
    readonly grantId?: string | undefined;
    readonly data?: unknown | undefined;
    readonly artifact?: DeviceCaptureArtifact | undefined;
  }
  | {
    readonly ok: false;
    readonly capabilityId: string;
    readonly nodeId: string;
    readonly refusal: DeviceRequestRefusal;
    readonly detail: string;
  };

export interface DeviceCapabilityServiceOptions {
  readonly grants: DeviceGrantStore;
  readonly artifacts: DeviceCaptureArtifactStore;
  readonly dispatcher: DeviceCapabilityDispatcher;
  readonly confirm: DeviceConfirmationHandler;
  /** Paired device nodes, resolved from the peer registry. */
  readonly listNodes: () => readonly DeviceNodeProfile[];
  /**
   * A fixed posture, or a resolver called once per request so a settings change
   * governs the NEXT request rather than waiting for a restart, the same
   * liveness `device.nodes.maxPaired` already has at the pairing path. See
   * device-policy-source.ts.
   */
  readonly policy?: DevicePolicySource<DeviceCapabilityPolicy> | undefined;
  /** Who answers a request no grant covers. Absent: the owner is asked. */
  readonly noGrantAuthority?: (() => DeviceNoGrantAuthority) | undefined;
  /**
   * Subscribe to a change of the `device.*` settings; returns the unsubscribe.
   * A change that would refuse a request still waiting for its phone ends it.
   */
  readonly onPolicyChange?: ((listener: () => void) => () => void) | undefined;
  /** Aborts every request whose phone has not picked it up (host shutdown). */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Whether a durable grant may be offered for this capability under the current
 * configuration. Under the stock policy this is true for EVERY capability,
 * the ruling offers "always allow" on front camera, screen capture, precise
 * location, and clipboard alike.
 */
export function isAllowAlwaysOffered(
  descriptor: DeviceCapabilityDescriptor,
  policy: DeviceCapabilityPolicy,
): boolean {
  if (!descriptor.allowAlwaysOffered) return false;
  if (policy.allowAlwaysOffer === 'never') return false;
  if (policy.mode === 'ask-every-time') return false;
  if (descriptor.id === 'device.clipboard.read' && policy.clipboardReadMode !== 'grantable') return false;
  if (descriptor.id === 'device.location.precise' && policy.locationPrecision === 'ask-precise') return false;
  if (policy.allowAlwaysOffer === 'standard-only' && descriptor.sensitivity === 'elevated') return false;
  return true;
}

/**
 * The deadline one request gives the device, from the configured posture and
 * whatever the caller asked for.
 *
 * A caller may ask for a SHORTER deadline than the configured one and get it,
 * a surface that will stop waiting after ten seconds should not leave a phone
 * working for sixty. It can never ask for a LONGER one: `device.requestTimeoutMs`
 * is the posture, and a caller that could extend it would be setting the posture
 * from the wire. A missing, zero, or nonsense value is simply the configured
 * deadline.
 *
 * This bounds the DISPATCH only. The confirmation prompt keeps the configured
 * deadline in every case, because the person answering it is not the caller and
 * their time is not the caller's to shorten.
 */
export function resolveDeviceRequestTimeoutMs(
  policy: DeviceCapabilityPolicy,
  requestedMs: number | undefined,
): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return policy.requestTimeoutMs;
  }
  return Math.min(Math.floor(requestedMs), policy.requestTimeoutMs);
}

/** Configuration-level availability, before any node or person is consulted. */
export function capabilityDisabledReason(
  descriptor: DeviceCapabilityDescriptor,
  policy: DeviceCapabilityPolicy,
): string | null {
  if (policy.mode === 'off') {
    return 'Paired-device capabilities are turned off (device.capabilities.mode = off).';
  }
  if (descriptor.id === 'device.clipboard.read' && policy.clipboardReadMode === 'off') {
    return 'Reading the phone clipboard is turned off (device.clipboard.readMode = off).';
  }
  if (descriptor.id === 'device.location.precise' && policy.locationPrecision === 'coarse-only') {
    return 'Precise location is turned off; only approximate location is available (device.location.precision = coarse-only).';
  }
  return null;
}

/**
 * The device setting that makes this capability ask the owner on every request,
 * or null when none does: `device.capabilities.mode = ask-every-time`,
 * `device.clipboard.readMode = ask-only` for a clipboard read, and
 * `device.location.precision = ask-precise` for a precise fix. These are the
 * device owner's explicit rule (someone else may be holding the phone), so
 * neither a durable grant nor permissions.mode yolo stands in for the prompt.
 */
export function askEveryRequestSetting(
  descriptor: DeviceCapabilityDescriptor,
  policy: DeviceCapabilityPolicy,
): string | null {
  if (policy.mode === 'ask-every-time') return 'device.capabilities.mode = ask-every-time';
  if (descriptor.id === 'device.clipboard.read' && policy.clipboardReadMode === 'ask-only') return 'device.clipboard.readMode = ask-only';
  if (descriptor.id === 'device.location.precise' && policy.locationPrecision === 'ask-precise') return 'device.location.precision = ask-precise';
  return null;
}

/** Why a settings change ends a request that rests on `authority`, or null when it does not. */
function endedBySettings(
  descriptor: DeviceCapabilityDescriptor,
  policy: DeviceCapabilityPolicy,
  authority: DeviceRequestAuthority,
): string | null {
  const disabled = capabilityDisabledReason(descriptor, policy);
  if (disabled) return `${disabled} The request was withdrawn before the phone picked it up.`;
  const askEvery = askEveryRequestSetting(descriptor, policy);
  if (askEvery && (authority === 'existing-grant' || authority === 'permissions-mode')) {
    return `This capability now asks the owner on every request (${askEvery}); the request was withdrawn before the phone picked it up. Ask again to be confirmed by the owner.`;
  }
  return null;
}

export class DeviceCapabilityService {
  private readonly grants: DeviceGrantStore;
  private readonly artifacts: DeviceCaptureArtifactStore;
  private readonly dispatcher: DeviceCapabilityDispatcher;
  private readonly confirm: DeviceConfirmationHandler;
  private readonly listNodes: () => readonly DeviceNodeProfile[];
  private readonly resolvePolicy: () => DeviceCapabilityPolicy;
  private readonly noGrantAuthority: () => DeviceNoGrantAuthority;
  private readonly onPolicyChange: DeviceCapabilityServiceOptions['onPolicyChange'];
  private readonly signal: AbortSignal | undefined;

  constructor(options: DeviceCapabilityServiceOptions) {
    this.grants = options.grants;
    this.artifacts = options.artifacts;
    this.dispatcher = options.dispatcher;
    this.confirm = options.confirm;
    this.listNodes = options.listNodes;
    this.resolvePolicy = resolveDevicePolicySource(options.policy, DEFAULT_DEVICE_CAPABILITY_POLICY);
    this.noGrantAuthority = options.noGrantAuthority ?? (() => 'ask-owner');
    this.onPolicyChange = options.onPolicyChange;
    this.signal = options.signal;
  }

  /** The posture in force right now (re-read when given a resolver). */
  getPolicy(): DeviceCapabilityPolicy {
    return this.resolvePolicy();
  }

  /** Who answers a request no grant covers, under the current `permissions.mode`. */
  getNoGrantAuthority(): DeviceNoGrantAuthority {
    return this.noGrantAuthority();
  }

  /** Paired nodes with the capabilities each can actually serve right now. */
  listDeviceNodes(): readonly DeviceNodeProfile[] {
    return this.listNodes();
  }

  /**
   * Run one capability on one node.
   *
   * `grants.find()` reads the authority record, so a grant revoked from any
   * surface on any machine of the group, or expired, or belonging to a node
   * that has since been unpaired, is not honoured: the request falls through
   * to `permissions.mode`.
   */
  async request(input: {
    readonly nodeId: string;
    readonly capabilityId: string;
    readonly input?: Readonly<Record<string, unknown>> | undefined;
    readonly reason: string;
    readonly sessionId?: string | undefined;
    /**
     * A shorter deadline for the device than the configured one. Clamped by
     * `resolveDeviceRequestTimeoutMs`, it can only shorten, never extend.
     */
    readonly timeoutMs?: number | undefined;
  }): Promise<DeviceCapabilityOutcome> {
    // One read for the whole request: the posture that gates the capability, the
    // posture that decides whether a durable grant may be offered, and the
    // deadline the device is given are all the same snapshot.
    const policy = this.getPolicy();
    const node = this.listNodes().find((candidate) => candidate.nodeId === input.nodeId);
    if (!node) {
      return {
        ok: false,
        capabilityId: input.capabilityId,
        nodeId: input.nodeId,
        refusal: 'node-unknown',
        detail: `No paired device node with id ${JSON.stringify(input.nodeId)}. List paired phones with the phone tool's "nodes" action or devices.nodes.list.`,
      };
    }

    const descriptor = getDeviceCapability(input.capabilityId);
    if (!descriptor) {
      return {
        ok: false,
        capabilityId: input.capabilityId,
        nodeId: input.nodeId,
        refusal: 'capability-unknown',
        detail: `${input.capabilityId} is not a capability this contract defines.`,
      };
    }

    if (node.gatedBySecureContext.includes(descriptor.id)) {
      return {
        ok: false,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        refusal: 'capability-gated-by-secure-context',
        detail: `${descriptor.title} needs an https (or loopback) connection to ${node.label}; it is announced but cannot be served from the current origin.`,
      };
    }
    if (!node.supported.includes(descriptor.id)) {
      return {
        ok: false,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        refusal: 'capability-unsupported',
        detail: `${node.label} does not offer ${descriptor.title}.`,
      };
    }

    const disabled = capabilityDisabledReason(descriptor, policy);
    if (disabled) {
      return {
        ok: false,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        refusal: 'disabled-by-config',
        detail: disabled,
      };
    }

    // The host half of the two-sided input check device-peer-work.ts describes.
    // It lives here, and only here on the host, because this is the one path a
    // capability is reached through: the `phone` tool and the control-plane verb
    // both arrive here. Ordered before the confirmation prompt so the owner is
    // never asked to approve a request that cannot run.
    const problems = validateDeviceCapabilityInput(descriptor.id, { ...(input.input ?? {}), reason: input.reason });
    if (problems.length > 0) {
      return {
        ok: false,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        refusal: 'invalid-input',
        detail: `${descriptor.title} needs ${problems
          .map((problem) => `${problem.field} (${problem.problem}, expected ${problem.expected})`)
          .join('; ')}.`,
      };
    }

    let authority: DeviceRequestAuthority = 'confirmed-once';
    let grant: DeviceCapabilityGrant | null = null;
    // Set once the phone has picked the work up; from then on nothing but the
    // host shutting down ends the request, so a finished action is never lost.
    let claimed = false;
    const ended = new AbortController();
    /** Why this request was ended before the phone picked it up, when it was. */
    let endedAs: DeviceRequestRefusal = 'disabled-by-config';
    const end = (refusal: DeviceRequestRefusal, detail: string): void => {
      if (claimed || ended.signal.aborted) return;
      endedAs = refusal;
      ended.abort(new Error(detail));
    };
    const signal = this.signal ? AbortSignal.any([ended.signal, this.signal]) : ended.signal;
    const unsubscribePolicy = this.onPolicyChange?.(() => {
      if (claimed || ended.signal.aborted) return;
      const why = endedBySettings(descriptor, this.getPolicy(), authority);
      if (why) end('disabled-by-config', why);
    }) ?? (() => {});
    // The grant this request runs under, checked against the authority record:
    // a revocation made anywhere in the group withdraws work still waiting.
    const endIfGrantEnded = (): void => {
      if (!grant || claimed || ended.signal.aborted || this.grants.isCurrent(grant)) return;
      end('grant-revoked-before-claim', `The "always allow" grant for ${descriptor.title} on ${node.label} ended (${this.grants.describeEnd(grant) ?? 'it is no longer on the record'}) before the phone picked the request up, so the request was withdrawn and nothing ran on the phone. Ask again to be confirmed by the owner.`);
    };
    const unsubscribeGrants = this.grants.onChange(endIfGrantEnded);
    const unsubscribe = (): void => { unsubscribePolicy(); unsubscribeGrants(); };
    const refusedBySettings = (): DeviceCapabilityOutcome | null => {
      if (!signal.aborted) return null;
      const reason: unknown = signal.reason;
      return {
        ok: false,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        refusal: ended.signal.aborted ? endedAs : 'dispatch-failed',
        detail: ended.signal.aborted && reason instanceof Error
          ? reason.message
          : 'The host is shutting down; the request was withdrawn before the phone picked it up.',
      };
    };

    try {
      // The device owner's ask-every-request rule outranks a durable grant and permissions.mode yolo.
      const askEveryRequest = askEveryRequestSetting(descriptor, policy) !== null;
      if (policy.mode === 'honor-grants' && !askEveryRequest) {
        grant = await this.grants.find({
          nodeId: node.nodeId,
          capabilityId: descriptor.id,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
      }

      if (grant) {
        authority = 'existing-grant';
      } else if (!askEveryRequest && this.noGrantAuthority() === 'allow') {
        authority = 'permissions-mode';
      } else {
        const allowAlwaysOffered = isAllowAlwaysOffered(descriptor, policy);
        const response = await this.confirm({
          nodeId: node.nodeId,
          nodeKind: node.nodeKind,
          nodeLabel: node.label,
          capabilityId: descriptor.id,
          descriptor,
          reason: input.reason,
          input: input.input ?? {},
          allowAlwaysOffered,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
        if (response.decision === 'deny') {
          return {
            ok: false,
            capabilityId: descriptor.id,
            nodeId: node.nodeId,
            refusal: 'denied-by-person',
            detail: response.note?.trim() ? response.note.trim() : `${descriptor.title} was declined by the owner.`,
          };
        }
        const settled = refusedBySettings();
        if (settled) return settled;
        if (response.decision === 'always' && allowAlwaysOffered) {
          grant = await this.grants.record({
            nodeId: node.nodeId,
            nodeKind: node.nodeKind,
            capabilityId: descriptor.id,
            scope: 'always',
            grantedBy: response.actor,
          });
          authority = 'confirmed-always';
        }
        // An 'always' the prompt never offered is honoured for this request only:
        // a durable grant is not written behind a policy that says it may not exist.
      }

      endIfGrantEnded();
      const before = refusedBySettings();
      if (before) return before;
      const dispatched = await this.dispatcher.dispatch({
        nodeId: node.nodeId,
        capabilityId: descriptor.id,
        input: { ...(input.input ?? {}), reason: input.reason },
        timeoutMs: resolveDeviceRequestTimeoutMs(policy, input.timeoutMs),
        admission: {
          signal,
          assertCurrent: () => { if (!claimed) { endIfGrantEnded(); signal.throwIfAborted(); } },
          // The phone is picking the work up: the grant is checked once more,
          // so a revocation that reached this machine is never run past.
          claim: () => { endIfGrantEnded(); signal.throwIfAborted(); claimed = true; },
        },
      });
      if (!dispatched.ok) {
        return refusedBySettings() ?? {
          ok: false,
          capabilityId: descriptor.id,
          nodeId: node.nodeId,
          refusal: 'dispatch-failed',
          detail: dispatched.error?.trim() ? dispatched.error.trim() : `${node.label} did not complete ${descriptor.title}.`,
        };
      }

      let artifact: DeviceCaptureArtifact | undefined;
      if (descriptor.producesArtifact && dispatched.bytes && dispatched.bytes.byteLength > 0) {
        try {
          artifact = await this.artifacts.retain({
            nodeId: node.nodeId,
            capabilityId: descriptor.id,
            kind: descriptor.artifactKind,
            mediaType: dispatched.mediaType ?? 'application/octet-stream',
            bytes: dispatched.bytes,
            ttlMs: Math.min(policy.captureRetentionMs, this.getPolicy().captureRetentionMs),
            ...(dispatched.workId ? { workId: dispatched.workId } : {}),
            reason: input.reason,
          });
        } catch (error) {
          // The device acted. A refusal would tell the caller nothing happened and
          // invite a repeated photo, so the failure says what did happen.
          const message = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            nodeId: node.nodeId,
            capabilityId: descriptor.id,
            refusal: 'dispatch-failed',
            detail: `${node.label} carried out ${descriptor.title}, but the capture could not be saved (${message}). Do not repeat the request without checking the device.`,
          };
        }
      }

      if (grant) {
        // Usage bookkeeping must not turn a completed action into an error.
        try { await this.grants.markUsed(grant.id); }
        catch (error) { logger.warn('Device grant use could not be recorded', { grantId: grant.id, error: error instanceof Error ? error.message : String(error) }); }
        if (!this.grants.isCurrent(grant)) {
          // The phone had picked the work up before the revocation reached it, so
          // it ran. Say what took effect; the answer itself is not handed on.
          const why = this.grants.describeEnd(grant) ?? 'it is no longer on the record';
          return {
            ok: false,
            capabilityId: descriptor.id,
            nodeId: node.nodeId,
            refusal: 'grant-revoked-after-claim',
            detail: `${node.label} had already picked up ${descriptor.title} when its "always allow" grant ended (${why}), so it ran on the phone. `
              + (artifact
                ? `The capture is kept as artifact ${artifact.id} for the capture retention window and is not returned here; devices.artifacts.delete removes it.`
                : 'Its answer is not returned here.')
              + ' The next request is put to the owner.',
          };
        }
      }
      return {
        ok: true,
        capabilityId: descriptor.id,
        nodeId: node.nodeId,
        authority,
        ...(grant ? { grantId: grant.id } : {}),
        ...(dispatched.data === undefined ? {} : { data: dispatched.data }),
        ...(artifact ? { artifact } : {}),
      };
    } catch (error) {
      const settled = refusedBySettings();
      if (settled) return settled;
      throw error;
    } finally {
      unsubscribe();
    }
  }
}

/**
 * channel-profiles/install-inbound-intake.ts
 *
 * Channel intake: before a message from a channel surface (Slack, Telegram,
 * mail, ...) reaches its session, the sender is attributed to a principal and
 * the channel's profile is resolved; the profile's permission mode is bound to
 * the session the message creates. Only channel surfaces are touched: a message
 * typed in the web UI, a terminal app, an automation or an embedding goes
 * through unchanged, because its author is the owner and no channel profile
 * applies to it.
 *
 * Facts and their owners:
 * - the channel profile: the ChannelProfileRegistry. Nothing is copied onto the
 *   message; the spawn path reads the registry (`channelProfileForSession`).
 * - the session's permission mode: the session record's `channelPermissionMode`.
 *   The execution-mode owner is derived from that record on each use.
 *
 * `installInboundIntakeEnrichment` attaches one `ChannelInboundIntake` to the
 * broker's message entry points (submit, follow-up, steer, delegated submit).
 */
import type { PrincipalRegistry } from '../principals/index.js';
import type {
  SharedSessionRecord,
  SharedSessionSubmission,
  SteerSharedSessionMessageInput,
  SubmitSharedSessionMessageInput,
} from './../control-plane/session-types.js';
import type { DelegatedSessionInputBinding, DelegatedSessionSubmission } from '../control-plane/session-broker-delegated.js';
import type { SharedSessionInputRecord } from '../control-plane/session-intents.js';
import { withExecutionModeOwner, type ExecutionModeOwner } from '../gate/execution-context.js';
import type { ChannelPermissionMode, ChannelProfileDefaults } from './types.js';
import { isSettableGatePresetName } from '../gate/presets.js';
import { isChannelSurfaceKind } from '../../events/surfaces.js';
import { buildInboundIntakeEnrichment } from './intake.js';
import type { ChannelProfileRegistry } from './registry.js';
import type { ChannelPolicyManager } from '../channels/policy-manager.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The broker surface intake needs: its message entry points and the session's channel mode. */
export interface InboundIntakeBroker {
  submitMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission>;
  followUpMessage?(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission>;
  steerMessage?(input: SteerSharedSessionMessageInput): Promise<SharedSessionSubmission>;
  submitDelegatedMessage?(input: SubmitSharedSessionMessageInput,
    onQueued: (input: SharedSessionInputRecord) => DelegatedSessionInputBinding): Promise<DelegatedSessionSubmission>;
  getSession?(sessionId: string): { readonly status: string; readonly channelPermissionMode?: ChannelPermissionMode | undefined;
    readonly channelPermissionModeRevision?: number | undefined } | null;
  bindChannelExecutionMode?(sessionId: string, mode: ChannelPermissionMode): Promise<void>;
  setChannelExecutionMode?(sessionId: string, mode: ChannelPermissionMode): Promise<void>;
}

/**
 * The execution-mode owner of a channel session, read from the session record:
 * undefined when the session has no channel mode. Request metadata never
 * grants a mode; only the record field the host bound does.
 */
export function channelExecutionModeOwner(broker: Pick<InboundIntakeBroker, 'getSession'>, sessionId: string): ExecutionModeOwner | undefined {
  const mode = broker.getSession?.(sessionId)?.channelPermissionMode;
  if (mode === undefined) return undefined;
  if (!isSettableGatePresetName(mode)) throw new Error('Stored channel execution mode is invalid');
  const current = () => {
    const session = broker.getSession?.(sessionId);
    if (session?.status !== 'active') throw new Error('Channel execution session is no longer active');
    const selected = session.channelPermissionMode ?? mode;
    if (!isSettableGatePresetName(selected)) throw new Error('Channel execution mode is invalid');
    return { mode: selected, revision: session.channelPermissionModeRevision ?? 0 };
  };
  return Object.freeze({ getMode: () => current().mode, getRevision: () => current().revision });
}

/** Dispatch an actual broker-owned session under its configured channel default. */
export function withChannelExecutionMode<T>(broker: Pick<InboundIntakeBroker, 'getSession'>, sessionId: string | undefined, run: () => T): T {
  const owner = sessionId === undefined ? undefined : channelExecutionModeOwner(broker, sessionId);
  return owner ? withExecutionModeOwner(owner, run) : run();
}

export interface InboundIntakeEnrichmentDeps {
  readonly principals: Pick<PrincipalRegistry, 'resolveByIdentity'>;
  readonly channelProfiles: Pick<ChannelProfileRegistry, 'resolve'> & Partial<Pick<ChannelProfileRegistry, 'resolveLoaded' | 'preload'>>;
  /**
   * Optional: the channel ingress-policy manager. When present, a sender who
   * is not a named principal but whom this surface's owner allowlist already
   * authorizes is attributed to the honest owner principal instead of the
   * unknown one, see `attributeInboundSession`.
   */
  readonly channelPolicy?: Pick<ChannelPolicyManager, 'getPolicy'> | undefined;
}

/** What intake adds to one channel message. */
export interface PreparedInboundMessage {
  /** The caller's metadata with the sender attribution merged over it. */
  readonly metadata: Record<string, unknown>;
  /** The channel profile's permission mode, bound to the session the message creates. */
  readonly permissionMode: ChannelPermissionMode | undefined;
}

/** The channel a message or session came from, as the profile registry keys it. */
function profileChannelId(source: { readonly externalId?: string | undefined; readonly surfaceId: string }): string {
  return source.externalId ?? source.surfaceId;
}

/** Attribution and profile resolution for channel messages; one per broker. */
export class ChannelInboundIntake {
  constructor(private readonly deps: InboundIntakeEnrichmentDeps) {
    // Read the bindings at start so a spawn for a queued channel input finds them in memory.
    void deps.channelProfiles.preload?.().catch((error: unknown) => {
      logger.warn('Channel profiles could not be read at start; the first channel message reads them again', { error: summarizeError(error) });
    });
  }

  /** The attribution and permission mode for one message; null for a message that is not from a channel surface. */
  async prepare(input: SubmitSharedSessionMessageInput): Promise<PreparedInboundMessage | null> {
    if (!isChannelSurfaceKind(input.surfaceKind)) return null;
    const enrichment = await buildInboundIntakeEnrichment(this.deps, {
      surfaceKind: input.surfaceKind,
      userId: input.userId,
      channelId: profileChannelId(input),
    });
    return {
      metadata: { ...(input.metadata ?? {}), ...enrichment.sessionMetadata },
      permissionMode: enrichment.permissionMode,
    };
  }

  /**
   * The model/provider profile for a session's originating channel, from the
   * registry's loaded bindings; null when the session did not come from a
   * channel or no binding applies.
   */
  profileForSession(session: Pick<SharedSessionRecord, 'id' | 'participants'>): ChannelProfileDefaults | null {
    const origin = session.participants.find((participant) => isChannelSurfaceKind(participant.surfaceKind));
    if (!origin) return null;
    const resolveLoaded = this.deps.channelProfiles.resolveLoaded;
    if (!resolveLoaded) return null;
    const profile = resolveLoaded.call(this.deps.channelProfiles, origin.surfaceKind, profileChannelId(origin));
    if (profile === undefined) {
      logger.warn('Channel profiles are not read yet; this agent starts on the host default model', { sessionId: session.id, surface: origin.surfaceKind });
      return null;
    }
    return profile;
  }
}

// One intake per broker; set by installInboundIntakeEnrichment and read by the spawn path.
const intakes = new WeakMap<object, ChannelInboundIntake>();

/** The channel profile that applies to an agent spawned for `session`, or null. */
export function channelProfileForSession(broker: object, session: Pick<SharedSessionRecord, 'id' | 'participants'>): ChannelProfileDefaults | null {
  return intakes.get(broker)?.profileForSession(session) ?? null;
}

/**
 * Compute the metadata an inbound submit input should carry: the caller's
 * metadata with the sender attribution merged over it. A message that is not
 * from a channel surface keeps its metadata as given.
 */
export async function enrichInboundSubmitMetadata(
  deps: InboundIntakeEnrichmentDeps,
  input: SubmitSharedSessionMessageInput,
): Promise<Record<string, unknown>> {
  const prepared = await new ChannelInboundIntake(deps).prepare(input);
  return prepared?.metadata ?? { ...(input.metadata ?? {}) };
}

/**
 * Attach channel intake to a broker's message entry points. Installing twice
 * leaves the first installation in place.
 */
export function installInboundIntakeEnrichment(
  broker: InboundIntakeBroker,
  deps: InboundIntakeEnrichmentDeps,
): void {
  if (intakes.has(broker)) return;
  const intake = new ChannelInboundIntake(deps);
  intakes.set(broker, intake);

  // A session created by a channel message is bound to the profile's mode. A
  // later message that finds the session still without a mode binds it, so a
  // bind whose save failed on the first message is retried, not forgotten.
  const bind = async (prepared: PreparedInboundMessage | null, submission: SharedSessionSubmission): Promise<void> => {
    if (prepared?.permissionMode === undefined) return;
    const unbound = submission.created || (broker.getSession !== undefined
      && broker.getSession(submission.session.id)?.channelPermissionMode === undefined);
    if (unbound) await broker.bindChannelExecutionMode?.(submission.session.id, prepared.permissionMode);
  };
  const through = <I extends SubmitSharedSessionMessageInput>(send: (input: I) => Promise<SharedSessionSubmission>) =>
    async (input: I): Promise<SharedSessionSubmission> => {
      const prepared = await intake.prepare(input);
      const submission = await send(prepared ? { ...input, metadata: prepared.metadata } : input);
      await bind(prepared, submission);
      return submission;
    };

  broker.submitMessage = through(broker.submitMessage.bind(broker));
  if (broker.followUpMessage) broker.followUpMessage = through(broker.followUpMessage.bind(broker));
  if (broker.steerMessage) broker.steerMessage = through(broker.steerMessage.bind(broker));
  if (broker.submitDelegatedMessage) {
    const delegated = broker.submitDelegatedMessage.bind(broker);
    broker.submitDelegatedMessage = async (input, onQueued) => {
      const prepared = await intake.prepare(input);
      const result = await delegated(prepared ? { ...input, metadata: prepared.metadata } : input, onQueued);
      await bind(prepared, result.submission);
      return result;
    };
  }
}

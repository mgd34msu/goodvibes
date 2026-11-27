/**
 * approval-raiser.ts, how a permission ask leaves a surface that is a client.
 *
 * ── What changed ───────────────────────────────────────────────────────────
 *
 * A surface product used to construct its OWN `ApprovalBroker`, and every ask
 * went into it: raised in-process, prompted at that surface, decided there,
 * stored there. When the surface also hosted the daemon that was coherent. Once
 * the daemon is a separate process it is not, an ask raised there was invisible
 * to every other surface, to the daemon's attention machinery, and to the phone
 * that was supposed to be able to answer it.
 *
 * So the ask goes to the daemon (`approvals.raise`) AND prompts locally, and the
 * first real answer wins. The daemon owns the record; the surface is one
 * participant that happens to be sitting in front of the user.
 *
 * ── The shape, precisely ───────────────────────────────────────────────────
 *
 * 1. Raise the ask on the daemon. The verb returns the pending record
 *    immediately, it deliberately does not park an HTTP request across a
 *    person's attention span.
 * 2. Prompt locally at the same time: the prompt is drawn at once and never
 *    waits for the raise, so a slow or stalled daemon cannot hold it back.
 * 3. Watch the raised id for a decision made elsewhere. The channel for that is
 *    `control.approval_update`, which carries every transition of the record the
 *    moment the broker records it, so a decision made on a phone reaches this
 *    surface in the time one SSE frame takes, not in the time one poll interval
 *    takes. A product wires the stream in through `subscribeApprovalUpdates`.
 *
 *    Polling `approvals.list` remains as the FALLBACK, and it is a real one, not
 *    a formality: a client with no stream seam wired, one whose stream the
 *    daemon refused, or one whose stream ended (the subscriber reports that
 *    through `onTerminate`; the stream itself turns a silent connection into an
 *    end by its heartbeat deadline) still gets its answer. There is also one
 *    read immediately after subscribing, because a decision can land between
 *    the raise and the subscription and a push channel cannot deliver what
 *    happened before it opened.
 * 4. The daemon is the arbiter once its record exists. A remote answer that
 *    arrives first is the decision. A local answer is sent to the daemon
 *    (`approvals.approve`/`approvals.deny`) and the record's final state is
 *    what runs: when another surface answered first, its answer stands. When
 *    the daemon does not answer within a short bound, the local answer runs
 *    and the write-back finishes on its own. A local answer given before the
 *    raise landed waits for the record's id inside the same bound and is
 *    arbitrated the same way. A write-back the daemon refused reads the record
 *    back, so a decision recorded elsewhere still wins.
 *
 * An ask the daemon expired or cancelled is a deny whose reason names that
 * state and says to ask again, never a bare deny.
 *
 * ── When the daemon is not reachable ───────────────────────────────────────
 *
 * The ask is prompted locally and answered locally, and that is the honest
 * outcome: a user in front of a surface can still approve their own tool call
 * with no daemon running. Nothing is silently swallowed and nothing pretends a
 * remote record exists. The refusal reason is logged once per process so a
 * misconfigured control plane is visible without a line per ask.
 *
 * ── Consumer lifetime ─────────────────────────────────────────────────────
 *
 * A remote decision resolves the ask with every field the daemon recorded
 * (a per-hunk `modifiedArgs`, a typed answer, a deny `reason`, a remember
 * tier), exactly as a local answer would, and the local prompt is aborted
 * through its execution signal so the card this surface drew is cleared
 * instead of capturing keys for an ask that is already decided.
 *
 * A consumer abort ends this caller's wait, aborts the local prompt and closes
 * its observations. When this caller CREATED the daemon record (the raise was
 * not coalesced onto an earlier identical ask) and leaves without a decision,
 * the record is cancelled, so web and phone stop showing an ask nobody is
 * waiting on. A caller that joined someone else's record leaves it with
 * `release: true`: the daemon cancels the record only once no surface that
 * raised it is still waiting, so a joiner leaving never denies the others.
 * Every raise also carries a deadline, so a record whose cancel could not be
 * delivered (the daemon was unreachable at that moment) still expires.
 *
 * A caller that has the decision (from the record, or its own answer once the
 * write-back finished) gives its hold up too: that release is the evidence the
 * approval's reading shows as `receipt: delivered`. A decision the daemon
 * recorded while the stream was down (a restart between the decision and its
 * event) is read back by the fallback read, then released the same way.
 */
import { logger, summarizeError } from '../../utils/index.js';
import { contentDigest } from '../../utils/target-ref.js';
import { assertPermissionActive, awaitPermission } from '../../permissions/cancellation.js';
import { WITHHELD_PROMPT_ANSWER, type PermissionExecutionOptions, type PermissionPromptDecision, type PermissionPromptRequest } from '../../permissions/prompt.js';
import type { RememberTier } from '../../permissions/approval-rules.js';
import { isOpenApprovalStatus } from '../../control-plane/approval-lifecycle.js';
import type { ApprovalRaiser } from '../permissions/permission-composition.js';
import type { DaemonVerbCaller } from './daemon-verbs.js';
import type { ApprovalUpdateNotice, ApprovalUpdateSubscription } from './approval-updates.js';

/**
 * How this surface opens the approval-update stream. A product supplies it
 * because resolving a base URL and proving this surface may subscribe are
 * trust-boundary concerns the platform core deliberately never reaches into, the
 * same carve-out `DaemonVerbCaller` records.
 *
 * Returning null means "no stream right now", which is a supported answer:
 * the raiser falls back to reading the record on an interval. `onTerminate`
 * is how a subscriber says the stream ended after it opened (closed, refused on
 * reconnect, or silent past its heartbeat deadline); the raiser then falls back
 * the same way instead of waiting on a stream that will never deliver. A
 * subscriber that can end must call it: nothing else watches an open stream.
 */
export type ApprovalUpdateSubscriber = (
  onUpdate: (notice: ApprovalUpdateNotice) => void,
  onTerminate?: () => void,
) => Promise<ApprovalUpdateSubscription | null>;

/** The local ask: draw a prompt on this surface and resolve with what the user chose. */
export type LocalPermissionPrompt = (request: PermissionPromptRequest, options?: PermissionExecutionOptions) => Promise<PermissionPromptDecision>;

/**
 * How long a local answer waits for the daemon to record it and return the
 * record's final state. Loopback round trips take milliseconds; past this the
 * local answer runs and the write-back completes in the background.
 */
const DEFAULT_ARBITER_WAIT_MS = 2_000;

/** How often the raised id is re-read while the local prompt is open. */
const DEFAULT_POLL_INTERVAL_MS = 750;

const REMEMBER_TIERS: ReadonlySet<string> = new Set<RememberTier>(['session', 'exact', 'command-class', 'path', 'tool']);

export interface ClientApprovalRaiserOptions {
  readonly verbs: DaemonVerbCaller;
  /** The prompt this surface draws. Late-bound: the UI layer patches it in after boot. */
  readonly localPrompt: () => LocalPermissionPrompt;
  /**
   * How this surface names itself when it reports its own decision back. The
   * daemon records it on the approval, so every other surface can see WHERE the
   * answer came from; there is no honest default, so each product states its own.
   */
  readonly actor: string;
  /** The live session id an ask belongs to, when there is one. */
  readonly sessionId?: () => string | null | undefined;
  /**
   * The push channel for decisions made elsewhere. Omitted ⇒ this surface
   * reads the record on an interval instead, which still works and is slower.
   */
  readonly subscribeApprovalUpdates?: ApprovalUpdateSubscriber | undefined;
  /** Poll interval override (tests), and the fallback interval. */
  readonly pollIntervalMs?: number;
  /** Injectable sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long a local answer waits for the daemon's final record (tests). */
  readonly arbiterWaitMs?: number;
  /**
   * True while this process's asks have their one answerer here and nowhere
   * else (a headless run: the script answering `--answer-permissions`, or
   * nobody, when the call is held for the owner): the ask is not raised on the
   * daemon, so it is never shown in a second list where answering it would
   * decide nothing.
   */
  readonly answersHere?: (() => boolean) | undefined;
}

/**
 * The daemon's record as this surface reads it back. Fields arrive off the
 * wire, so the decision is read as unknown values and checked before use.
 */
interface RaisedRecord {
  readonly id: string;
  readonly status?: string | undefined;
  /** The record's revision: a decision written back names it (`expectedRevision`). */
  readonly revision?: unknown;
  readonly decision?: {
    readonly approved?: unknown;
    readonly remember?: unknown;
    readonly rememberTier?: unknown;
    readonly reason?: unknown;
    readonly modifiedArgs?: unknown;
    /** The digest of the arguments the recorded approval runs the call with. */
    readonly argsDigest?: unknown;
  } | undefined;
}

/** What `approvals.raise` answered: the record id, and whether it joined an earlier identical ask. */
interface RaisedOnDaemon {
  readonly id: string;
  readonly coalesced: boolean | undefined;
  /** Names this surface's hold on the ask, so a retried release is harmless. */
  readonly holdId: string | undefined;
  /** The revision the raise returned, when the record came back with it. */
  readonly revision: number | undefined;
}

function revisionOf(record: RaisedRecord | null | undefined): number | undefined {
  return typeof record?.revision === 'number' && Number.isInteger(record.revision) ? record.revision : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A record the daemon considers answered, mapped to the decision this surface
 * returns. Carries the same fields a local answer carries, so a subset of hunks
 * approved on the web applies only that subset and a deny reason reaches the model.
 */
function readRemoteDecision(record: RaisedRecord | null | undefined): PermissionPromptDecision | null {
  if (!record) return null;
  const status = record.status;
  const approved = status === 'approved';
  if (!approved && status !== 'denied' && status !== 'expired' && status !== 'cancelled') return null;
  const decision = record.decision;
  // The daemon never stores a typed terminal answer, only a placeholder. An
  // approval whose answer was typed elsewhere cannot be forwarded as the text
  // itself, so it is declined rather than typing the placeholder into the program.
  if (approved && isPlainRecord(decision?.modifiedArgs) && decision.modifiedArgs['answer'] === WITHHELD_PROMPT_ANSWER) {
    return { approved: false, remember: false, reason: 'The answer was typed on another surface and cannot be forwarded here; answer at this prompt instead.' };
  }
  if (status === 'expired' || status === 'cancelled') {
    return {
      approved: false,
      remember: false,
      reason: typeof decision?.reason === 'string' && decision.reason.length > 0
        ? decision.reason
        : status === 'expired'
          ? 'The ask expired before anyone answered it; ask again if the action is still wanted.'
          : 'The ask was cancelled before anyone answered it; ask again if the action is still wanted.',
    };
  }
  const rememberTier = typeof decision?.rememberTier === 'string' && REMEMBER_TIERS.has(decision.rememberTier)
    ? decision.rememberTier as RememberTier
    : undefined;
  return {
    approved,
    remember: decision?.remember === true,
    ...(rememberTier === undefined ? {} : { rememberTier }),
    ...(typeof decision?.reason === 'string' ? { reason: decision.reason } : {}),
    // Argument changes only ever apply to an approval; a deny runs nothing.
    ...(approved && isPlainRecord(decision?.modifiedArgs) ? { modifiedArgs: decision.modifiedArgs } : {}),
  };
}

let unreachableLogged = false;

/** Own the decision fields before checking whether a borrowed callback cancelled. */
function localDecisionSnapshot(decision: PermissionPromptDecision): PermissionPromptDecision {
  const { approved, remember, rememberTier, reason, modifiedArgs } = decision;
  return {
    approved,
    ...(remember === undefined ? {} : { remember }),
    ...(rememberTier === undefined ? {} : { rememberTier }),
    ...(reason === undefined ? {} : { reason }),
    ...(modifiedArgs === undefined ? {} : { modifiedArgs }),
  };
}

export function createClientApprovalRaiser(options: ClientApprovalRaiserOptions): ApprovalRaiser {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
    if (options.sleep) return awaitPermission(() => options.sleep!(ms), signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await awaitPermission(() => new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms); timer.unref?.();
      }), signal);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };

  const raiseOnDaemon = async (input: {
    request: PermissionPromptRequest;
    routeId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<RaisedOnDaemon | null> => {
    const probe = options.verbs.probe();
    if (!probe.available) {
      if (!unreachableLogged) {
        unreachableLogged = true;
        logger.info(`[approvals] asks are answered on this surface only: ${probe.reason}`);
      }
      return null;
    }
    const sessionId = options.sessionId?.() ?? undefined;
    try {
      // `outsideFolder` is the gate's in-process word to this program's folder trust: it does not travel.
      const { outsideFolder: _inProcess, ...request } = input.request;
      const raised = await options.verbs.invoke<{ approvalId?: unknown; approval?: RaisedRecord; coalesced?: unknown; holdId?: unknown }>('approvals.raise', {
        request,
        ...(sessionId ? { sessionId } : {}),
        ...(input.routeId === undefined ? {} : { routeId: input.routeId }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        // No expiry: a question waits until it is answered or the program that asked gives it up (its hold).
      });
      // approvalId is always sent; the record only to a caller that holds read:approvals.
      const id = typeof raised?.approvalId === 'string' ? raised.approvalId : raised?.approval?.id;
      if (typeof id !== 'string' || id.length === 0) return null;
      return {
        id,
        coalesced: typeof raised?.coalesced === 'boolean' ? raised.coalesced : undefined,
        holdId: typeof raised?.holdId === 'string' && raised.holdId.length > 0 ? raised.holdId : undefined,
        revision: revisionOf(raised?.approval),
      };
    } catch (error) {
      logger.warn('[approvals] raising the ask on the daemon failed; prompting locally only', { error: summarizeError(error) });
      return null;
    }
  };

  const readRaised = async (approvalId: string, signal: AbortSignal): Promise<RaisedRecord | null> => {
    try {
      const listed = await awaitPermission(() => options.verbs.invoke<unknown>('approvals.list', { approvalId }), signal);
      const records: readonly RaisedRecord[] = Array.isArray(listed)
        ? listed as readonly RaisedRecord[]
        : ((listed as { approvals?: readonly RaisedRecord[] } | null)?.approvals ?? []);
      return records.find((entry) => entry.id === approvalId) ?? null;
    } catch (error) {
      assertPermissionActive(signal);
      logger.debug('[approvals] reading the raised ask back failed', { error: summarizeError(error) });
      return null;
    }
  };

  /** The fallback: read the record back on an interval until it is answered. */
  const pollRemote = async (approvalId: string, done: () => boolean, signal: AbortSignal): Promise<PermissionPromptDecision | null> => {
    while (!done()) {
      await sleep(pollIntervalMs, signal);
      if (done()) return null;
      const decision = readRemoteDecision(await readRaised(approvalId, signal));
      if (decision) return decision;
    }
    return null;
  };

  /**
   * The push path: subscribe, then read once to close the gap between the raise
   * and the subscription, then wait for the frame that decides this id.
   *
   * Resolves null when the local prompt won. Reports `subscribed: false` when no
   * stream could be opened or the stream ended without a decision, so the caller
   * falls back to reading the record on an interval.
   */
  const watchRemoteOverStream = async (
    subscribe: ApprovalUpdateSubscriber,
    approvalId: string,
    done: () => boolean,
    signal: AbortSignal,
  ): Promise<{ readonly subscribed: boolean; readonly decision: PermissionPromptDecision | null }> => {
    let settle: ((decision: PermissionPromptDecision | null) => void) | null = null;
    const decided = new Promise<PermissionPromptDecision | null>((resolve) => { settle = resolve; });
    let subscription: ApprovalUpdateSubscription | null = null;
    let terminated = false as boolean;
    let closed = false;
    const closeFailed = (): void => {
      // Cleanup diagnostics must not create another unhandled cleanup failure.
      try { logger.warn('[approvals] closing this approval observation failed'); } catch { /* best effort */ }
    };
    const close = (): void => {
      if (subscription && !closed) {
        closed = true;
        // A void callback may have an async implementation. Own both forms of
        // failure without waiting on or retrying borrowed disposal.
        try { void Promise.resolve(subscription.close()).then(undefined, closeFailed); }
        catch { closeFailed(); }
      }
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      const opening = Promise.resolve().then(() => {
        assertPermissionActive(signal);
        return subscribe((notice) => {
          if (notice.approval.id !== approvalId) return;
          if (signal.aborted || done()) { settle?.(null); return; }
          const decision = readRemoteDecision(notice.approval);
          if (decision) settle?.(decision);
        }, () => { terminated = true; settle?.(null); });
      });
      // Keep ownership even if cancellation wins before acquisition completes.
      // The same close function covers the narrow handoff between promise jobs.
      void opening.then((acquired) => {
        subscription = acquired;
        if (signal.aborted) close();
      }, () => {});
      try {
        await awaitPermission(() => opening, signal);
      } catch (error) {
        assertPermissionActive(signal);
        logger.debug('[approvals] opening the approval-update stream failed; reading the record instead', { error: summarizeError(error) });
        return { subscribed: false, decision: null };
      }
      if (!subscription) return { subscribed: false, decision: null };
      const alreadyDecided = readRemoteDecision(await readRaised(approvalId, signal));
      if (alreadyDecided) return { subscribed: true, decision: alreadyDecided };
      if (done()) return { subscribed: true, decision: null };
      // The stream owns its own liveness (heartbeat deadline, end reported through
      // `onTerminate`), so nothing re-reads the record while it is open. When the
      // local prompt wins, the caller aborts `signal` and this wait ends with it.
      const outcome = await awaitPermission(() => decided, signal);
      // A stream that ended has nothing more to deliver: read the record instead.
      if (outcome === null && terminated && !done()) return { subscribed: false, decision: null };
      return { subscribed: true, decision: outcome };
    } finally {
      signal.removeEventListener('abort', close);
      close();
    }
  };

  /** Resolve when the daemon's record for this id is answered. Never rejects. */
  const watchRemote = async (approvalId: string, done: () => boolean, signal: AbortSignal): Promise<PermissionPromptDecision | null> => {
    const subscribe = options.subscribeApprovalUpdates;
    if (subscribe) {
      const pushed = await watchRemoteOverStream(subscribe, approvalId, done, signal);
      if (pushed.subscribed) return pushed.decision;
    }
    return await pollRemote(approvalId, done, signal);
  };

  /**
   * Tell the daemon what this surface decided, so its record is the truth: the
   * outcome, a deny reason and any argument changes the user approved.
   * Deliberately not tied to the consumer's signal: the decision was taken, and
   * a turn aborted a moment later must not leave the record pending everywhere else.
   */
  const reportLocalDecision = async (raised: RaisedOnDaemon, decision: PermissionPromptDecision): Promise<RaisedRecord | null> => {
    const approvalId = raised.id;
    try {
      const method = decision.approved ? 'approvals.approve' : 'approvals.deny';
      // Who decided is taken from the authenticated session on the daemon, not
      // from a claim in the body, so this surface names itself in the note. The
      // remember tier stays with this surface's own rule store: sending it would
      // also persist a second, daemon-side rule and sweep other sessions' asks.
      const input = {
        approvalId,
        note: `decided at the ${options.actor} surface`,
        ...(decision.remember ? { remember: true } : {}),
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        // Argument changes only ever apply to an approval; a deny runs nothing.
        ...(decision.approved && decision.modifiedArgs !== undefined ? { modifiedArgs: decision.modifiedArgs } : {}),
      };
      // The person answered the ask this surface drew, whose request never changes. The decision names the
      // revision this surface last read; one that moved since only by a claim or a note elsewhere (still
      // waiting) is answered again at its current revision, and a settled one stays as it was decided.
      let revision = raised.revision ?? revisionOf(await readRaised(approvalId, new AbortController().signal));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const answered = await options.verbs.invoke<{ applied?: unknown; approval?: RaisedRecord; refusal?: { code?: unknown } } | null>(
          method, { ...input, ...(revision === undefined ? {} : { expectedRevision: revision }) });
        const record = answered?.approval?.id === approvalId ? answered.approval : null;
        const waiting = record !== null && isOpenApprovalStatus(record.status);
        if (answered?.applied === false && answered.refusal?.code === 'APPROVAL_CHANGED' && waiting && revisionOf(record) !== revision) {
          revision = revisionOf(record);
          continue;
        }
        return record;
      }
      return await readRaised(approvalId, new AbortController().signal);
    } catch (error) {
      logger.warn('[approvals] recording this surface\'s decision on the daemon failed', {
        approvalId,
        error: summarizeError(error),
      });
      // The write was refused or lost: the record, if the daemon can be read,
      // still says whether another surface decided first. Not re-asking the user.
      return await readRaised(approvalId, new AbortController().signal);
    }
  };

  /**
   * Send a local answer to the daemon and return what the record's owner
   * decided: the local answer when the record agrees or the daemon did not
   * answer in time, the record's own decision when another surface answered first.
   */
  const arbitrateLocalDecision = async (
    raised: Promise<RaisedOnDaemon | null> | RaisedOnDaemon,
    local: PermissionPromptDecision,
    requestArgs: Record<string, unknown>,
    /** Told the write-back's promise: this ask's hold is given up only after it finished. */
    onReporting: (reporting: Promise<unknown>) => void = () => {},
  ): Promise<PermissionPromptDecision> => {
    // An answer given before the raise landed waits for its id too, inside the
    // same bound: the record may be one another surface already answered.
    const reporting = Promise.resolve(raised).then((record) => record ? reportLocalDecision(record, local) : null, () => null);
    // The hold is given up once the write-back finished, never before it: a release while still waiting would leave the ask.
    onReporting(reporting);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), options.arbiterWaitMs ?? DEFAULT_ARBITER_WAIT_MS);
      timer.unref?.();
    });
    try {
      const record = await Promise.race([reporting, deadline]);
      if (record === 'deadline' || record === null) return local;
      const final = readRemoteDecision(record);
      if (!final || final.approved !== local.approved) return final ?? local;
      // Both approved, but another surface may have answered first with another
      // narrowing (other hunks, other edited arguments): the recorded approval
      // is the one that runs, on every surface, whenever its arguments differ.
      const recordedDigest = local.approved ? record.decision?.argsDigest : undefined;
      if (typeof recordedDigest === 'string' && recordedDigest !== contentDigest(local.modifiedArgs ?? requestArgs)) return final;
      // The record agrees with this surface: run the local answer, which keeps
      // the fields only this surface holds (a typed answer, the remember tier).
      return local;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * Give up this caller's hold on an ask it raised. Without a decision it is
   * leaving: the daemon cancels the record only when no other surface that
   * raised the same ask is still waiting, so a joiner leaving never denies the
   * others. With the decision in hand it confirms it received it, which is the
   * evidence the approval's reading shows as `receipt: delivered`.
   */
  const releaseHold = (raised: RaisedOnDaemon, received: boolean): void => {
    // A daemon that does not report `coalesced` predates `release`: it would cancel outright and deny any
    // surface still waiting on the same ask, so it is left to its deadline.
    if (raised.coalesced === undefined) return;
    void Promise.resolve().then(() => options.verbs.invoke('approvals.cancel', {
      approvalId: raised.id,
      release: true,
      ...(raised.holdId === undefined ? {} : { holdId: raised.holdId }),
      note: received ? 'the asking surface received the decision' : 'the asking surface stopped waiting for an answer',
    })).catch((error: unknown) => {
      logger.debug(received ? '[approvals] confirming receipt of a decision failed; the reading says the asker has not confirmed it'
        : '[approvals] retiring an abandoned ask on the daemon failed; its deadline still expires it', {
        approvalId: raised.id,
        error: summarizeError(error),
      });
    });
  };

  return async (input) => {
    const signal = input.signal;
    assertPermissionActive(signal);
    // One answerer, here: asked here only (the decision fields are kept as given, a hold for the owner included).
    if (options.answersHere?.() === true) {
      const decision = await options.localPrompt()(input.request, signal ? { signal } : {});
      assertPermissionActive(signal);
      return { ...localDecisionSnapshot(decision), ...(decision.heldForOwner === true ? { heldForOwner: true } : {}) };
    }
    const observations = new AbortController();
    const abort = (): void => observations.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // Aborted when this ask is over for any reason, including a remote
    // decision winning, so a drawn prompt clears instead of waiting on a key.
    const promptLifetime = new AbortController();
    const promptSignal = signal ? AbortSignal.any([signal, promptLifetime.signal]) : promptLifetime.signal;
    let settled = false;
    let decided = false;
    // Set by the raise when it lands, which may be after the local answer.
    let raisedOnDaemon = null as RaisedOnDaemon | null;
    let left = false;
    // This ask's own write-back of a local decision, which its release waits for.
    let reported: Promise<unknown> = Promise.resolve();
    let released = false;
    try {
      const raising = raiseOnDaemon(input);
      // A raise that lands after this caller left (decided or not) still gets its hold given up.
      void raising.then((raised) => {
        if (!raised || !left || released) return;
        released = true;
        if (decided) void reported.then(() => releaseHold(raised, true), () => releaseHold(raised, true));
        else releaseHold(raised, false);
      }, () => {});
      const prompt = options.localPrompt();
      // The prompt is drawn now, not after the raise: the daemon's answer
      // time never decides when the person in front of this surface is asked.
      const local = awaitPermission(async () => {
        const decision = await prompt(input.request, { signal: promptSignal });
        assertPermissionActive(signal);
        settled = true;
        return { source: 'local' as const, decision: localDecisionSnapshot(decision) };
      }, signal);
      // A cancellation can land before the race below subscribes; own the
      // losing branch here so it never surfaces as an unhandled rejection.
      local.catch(() => {});
      const remote = raising.then(async (raised) => {
        raisedOnDaemon = raised;
        if (!raised || settled) return null;
        const decision = await watchRemote(raised.id, () => settled, observations.signal);
        if (decision) settled = true;
        return decision ? { source: 'remote' as const, decision } : null;
      }).catch(() => null);
      const winner = await awaitPermission(() => Promise.race([
        local,
        remote.then(async (result) => result ?? await local),
      ]), signal);
      assertPermissionActive(signal);
      decided = true;
      if (winner.source === 'remote') return winner.decision;
      // The daemon decides: the local answer is sent there and the record's
      // final state is what runs (the local answer when no daemon answers in time).
      return await arbitrateLocalDecision(raisedOnDaemon ?? raising, winner.decision, input.request.args, (reporting) => { reported = reporting; });
    } finally {
      settled = true;
      left = true;
      promptLifetime.abort();
      observations.abort();
      signal?.removeEventListener('abort', abort);
      if (raisedOnDaemon && !released) {
        released = true;
        const raised = raisedOnDaemon;
        // Decided: the hold confirms receipt once this surface's own write-back (if any) finished.
        if (decided) void reported.then(() => releaseHold(raised, true), () => releaseHold(raised, true));
        else releaseHold(raised, false);
      }
    }
  };
}

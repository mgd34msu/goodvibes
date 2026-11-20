import { isClassicOperation } from '../../runtime/decision-policy.js';
import { rankClassicCatalog } from '../../runtime/classic-catalog.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
/**
 * The task route planner: the agent's planAgentTaskRoute, with the keyword
 * ladder replaced by Jev readings. One planning pass asks, concurrently, the
 * route selection (route-selector.ts) and the slot readings (slots.ts); code
 * then composes the plan.
 *
 * A plan is held only when the route selection itself is unsure. An unsure
 * slot or named target takes the documented safe default (slots.ts: an effect
 * keeps its confirmation boundary, a variant is off, a target stays generic),
 * and an unsure catalog row is left out of the matches. A held plan names the
 * unsure reading and offers the fitting routes at low confidence; it never
 * prefers one. Confident none means main conversation; uncertainty never
 * implies none. All original readings and decision ids remain available under
 * judgment, independent of display limits.
 *
 * With no decision model in use nothing is read and nothing is sent: the plan
 * is held, listing the routes whose descriptions share words with the request
 * (then the main conversation) at low confidence, every effect keeping its
 * confirmation boundary, for the calling model or the user to choose.
 */
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes/engine/errors';
import { isDeepStrictEqual } from 'node:util';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { captureStrictJudgmentJson, prepareJudgmentResult } from '../../gate/judgment-result.js';
import { SOURCE_SCREENING_LIMITS, type SourceScreeningReceipt } from '../../security/source-screening/types.js';
import { ToolInputProjectionError } from '../../tools/input-projection.js';
import { NONE, type Outcome, type Selection } from '@goodvibes/judgment';
import { mainConversationRoute, TASK_ROUTES } from './catalog.js';
import { routeCandidates, taskRoutePick } from './route-selector.js';
import { readSlots } from './slots.js';
import type { NamedId, NamedIdSources } from './named-ids.js';
import { previewText } from './text.js';
import type {
  MissingRequestPlan,
  ReadyPlan,
  TaskRouteArgs,
  TaskRouteCandidate,
  TaskRouteJudgment,
  TaskRouteConfidence,
  TaskRouteDeps,
  TaskRouteDraft,
  TaskRoutePlan,
  TaskRouteSlots,
  TaskRouteReadOptions,
  UncertainPlan,
} from './types.js';

export const TASK_ROUTE_SITE = 'routing.task-route.plan';

const NAMED_KINDS = ['modelProvider', 'memoryProvider', 'channelTarget'] as const;

async function whileCurrent<T>(work: Promise<T>, options: JudgmentReadingOptions): Promise<T> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (!options.signal) return work;
  const signal = options.signal;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new ToolInputProjectionError('held'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

/** The candidate limit: a number or numeric string, truncated and held to 1..20, else the fallback. */
export function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(20, Math.trunc(parsed)));
}

const CONFIDENCE: Readonly<Record<Outcome, TaskRouteConfidence>> = { act: 'high', confirm: 'medium', escalate: 'low' };

interface RankedRoute {
  readonly draft: TaskRouteDraft;
  readonly outcome: Outcome;
  readonly score: number;
}

function describeRoute(route: RankedRoute, includeParameters: boolean): TaskRouteCandidate {
  const { draft } = route;
  return {
    id: draft.id,
    label: draft.label,
    confidence: CONFIDENCE[route.outcome],
    userSurface: draft.userSurface,
    userOutcome: draft.userOutcome,
    why: draft.why,
    modelRoute: draft.modelRoute,
    inspectRoute: draft.inspectRoute,
    ...(draft.userRoute ? { userRoute: draft.userRoute } : {}),
    requiresConfirmation: draft.requiresConfirmation,
    ...(draft.missingFields?.length ? { missingFields: draft.missingFields } : {}),
    ...(draft.nextQuestion ? { nextQuestion: draft.nextQuestion } : {}),
    ...(draft.supportingRoutes?.length ? { supportingRoutes: draft.supportingRoutes } : {}),
    ...(draft.policy ? { policy: draft.policy } : {}),
    ...(includeParameters ? { score: route.score } : {}),
  };
}

/** The preferred route, then every other fitting route best first. */
export function rankRoutes(request: string, selection: Selection, slots: TaskRouteSlots): readonly RankedRoute[] {
  const fitting = TASK_ROUTES
    .map((entry) => ({ entry, fit: selection.fits[entry.id]! }))
    .filter(({ entry, fit }) => fit.verdict === 'yes' && fit.outcome === 'act' && entry.id !== selection.chosen)
    .sort((left, right) => right.fit.probability - left.fit.probability)
    .map(({ entry, fit }) => ({ draft: entry.build(request, slots), outcome: fit.outcome, score: fit.probability }));
  const chosen = selection.chosen === undefined ? undefined : TASK_ROUTES.find((entry) => entry.id === selection.chosen);
  const preferred: RankedRoute = chosen
    ? { draft: chosen.build(request, slots), outcome: selection.outcome, score: selection.fits[chosen.id]!.probability }
    : { draft: mainConversationRoute(request), outcome: selection.outcome, score: selection.pick.probabilities[NONE] ?? 0 };
  return [preferred, ...fitting];
}

async function catalogMatches(
  lookup: TaskRouteDeps['workspaceMatches'],
  request: string,
  limit: number,
  options: JudgmentReadingOptions,
): Promise<{ matches: readonly Record<string, unknown>[]; ranked: TaskRouteJudgment['workspace'] }> {
  if (lookup === undefined) return { matches: [], ranked: [] };
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const result = captureStrictJudgmentJson(await whileCurrent(Promise.resolve().then(() => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    return lookup(request, limit, options);
  }), options));
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (!('ranked' in result)) return { matches: result.slice(0, limit), ranked: [] };
  const byId = new Map(result.records.map(record => [String(record.id), record]));
  return {
    matches: result.ranked.filter(entry => entry.reading.verdict === 'yes' && entry.reading.outcome === 'act')
      .slice(0, limit).map(entry => {
        const record = byId.get(entry.id);
        if (!record) throw new Error('Task-route catalog reading names an absent record.');
        return { ...record, judgment: entry };
      }),
    ranked: result.ranked,
  };
}

function selectionEvidence(selection: Selection): Omit<Selection, 'recordAction'> {
  const { recordAction: _recordAction, ...evidence } = selection;
  return evidence;
}

/** The slots of a request no decision model read: every effect keeps its confirmation boundary, no variant is on, no target is named. */
const UNREAD_SLOTS: TaskRouteSlots = Object.freeze({
  changes: true, starts: true, opensUi: true, controls: true, freshRead: true,
  existing: false, reminder: false, delegated: false, device: false, evidence: false, instructionFiles: false,
  lane: null, channelTask: 'status', policyTarget: null, modelProvider: null, memoryProvider: null, channelTarget: null,
});

const READ_ONLY_POLICY = 'This held read-only plan authorizes no dispatch or effects.';

/** The held plan without a decision model: literal word overlap with each route's description, then the main conversation. */
function planWithoutDecisionModel(request: string, args: TaskRouteArgs): UncertainPlan {
  const includeParameters = args.includeParameters === true;
  const limit = readLimit(args.limit, includeParameters ? 8 : 5);
  const matches = rankClassicCatalog(TASK_ROUTES, request, (entry) => ({ id: entry.id, description: entry.description }));
  const ranked: RankedRoute[] = [
    ...matches.map((match) => ({ draft: match.entry.build(request, UNREAD_SLOTS), outcome: 'escalate' as const, score: match.score })),
    { draft: mainConversationRoute(request), outcome: 'escalate', score: 0 },
  ];
  const leading = ranked[0]!;
  return {
    status: 'uncertain', request: previewText(request, includeParameters ? 220 : 120), judgment: null,
    unsure: { reading: 'no decision model', outcome: 'escalate', leading: leading.draft.id, probability: leading.score },
    candidates: ranked.slice(0, limit).map((route) => ({ ...describeRoute(route, includeParameters), confidence: 'low' as const })),
    nextAction: 'No decision model is in use, so no route was read for fit: these routes share words with the request, best overlap first. Choose the one that matches what the user asked for, or ask the user which outcome they want; each candidate keeps its own confirmation boundary.',
    policy: READ_ONLY_POLICY,
  };
}

const MISSING_REQUEST: MissingRequestPlan = {
  status: 'missing_request',
  usage: 'Use route action:"plan" query:"<user task>" to get the preferred GoodVibes Agent route, alternatives, missing fields, and confirmation boundary.',
  examples: [
    'Fix the failing tests in this repo.',
    'Triage my inbox and draft replies.',
    'Run a weekly source-backed research report.',
    'Why would settings action:set need confirmation?',
  ],
  policy: 'Route planning is read-only. It never runs tools, creates jobs, sends messages, changes settings, or opens UI surfaces.',
};

/**
 * Plans the route for a user task. Needs an installed judgment port
 * and a current protected source owner; `deps` supplies the product catalogs
 * whose matches the plan lists.
 */
export async function planTaskRoute(
  args: TaskRouteArgs,
  deps: TaskRouteDeps = {},
  options: TaskRouteReadOptions = {},
): Promise<TaskRoutePlan> {
  const originalArgs = captureStrictJudgmentJson(args);
  const request = typeof originalArgs.query === 'string' && originalArgs.query.trim() ? originalArgs.query
    : typeof originalArgs.target === 'string' && originalArgs.target.trim() ? originalArgs.target : '';
  if (!request) return MISSING_REQUEST;
  if (isClassicOperation()) { options.signal?.throwIfAborted(); return planWithoutDecisionModel(request, originalArgs); }
  assertJudgmentInput(originalArgs);

  // The request and the listings are read once into frozen values and passed
  // down; nothing below re-lists or re-compares them.
  const owner = options.sourceOwner;
  if (!owner) throw new ToolInputProjectionError('held');
  const listing = deps.namedIds;
  const signal = options.signal, callerCurrent = options.assertCurrent, retainCurrent = options.retainCurrent;
  const assertCaller = () => {
    signal?.throwIfAborted();
    assertSynchronousJudgmentGuard(callerCurrent, () => new ToolInputProjectionError('held'));
    signal?.throwIfAborted();
  };
  assertCaller();
  const snapshots = NAMED_KINDS.map(kind => ({ kind, ids: captureStrictJudgmentJson(listing?.[kind]?.() ?? []) }));
  // The route catalog is frozen where it is declared, so its candidates are read once.
  const routeSource = captureStrictJudgmentJson(routeCandidates());
  const parts = [request, ...snapshots.map(({ ids }) => JSON.stringify(ids))];
  if (parts.reduce((total, part) => total + part.length, 0) > SOURCE_SCREENING_LIMITS.characters) throw new ToolInputProjectionError('held');
  const handle = owner.capture(parts);
  let receipt: SourceScreeningReceipt | undefined;
  let projection: readonly string[] | undefined;
  // During the readings only cancellation is checked; the caller and the
  // screening receipt are confirmed once, when the plan is published.
  const assertLive = () => { signal?.throwIfAborted(); };
  const assertPublication = () => {
    assertCaller();
    if (receipt && !isDeepStrictEqual(owner.project(receipt), projection)) throw new ToolInputProjectionError('held');
  };
  const abort = () => { void owner.release(handle).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const screened = await whileCurrent(owner.screen(handle), { signal, assertCurrent: assertLive });
    if (screened.status !== 'settled') throw new ToolInputProjectionError('held');
    receipt = screened.receipt; projection = captureStrictJudgmentJson(owner.project(receipt));
    if (projection.length !== parts.length || typeof projection[0] !== 'string') throw new ToolInputProjectionError('held');
    const protectedRequest = projection[0];
    const namedIds: NamedIdSources = Object.fromEntries(snapshots.map(({ kind, ids }, index) => {
      const text = projection?.[index + 1];
      if (typeof text !== 'string') throw new ToolInputProjectionError('held');
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed) || parsed.length !== ids.length) throw new ToolInputProjectionError('held');
      const protectedIds: NamedId[] = parsed.map((entry: unknown, item) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('id' in entry) || typeof entry.id !== 'string'
          || entry.id !== ids[item]?.id || !('names' in entry) || !Array.isArray(entry.names)
          || !entry.names.every((name: unknown) => typeof name === 'string')) throw new ToolInputProjectionError('held');
        return { id: entry.id, names: entry.names };
      });
      return [kind, () => protectedIds];
    }));
    assertJudgmentInput({ request: protectedRequest, namedIds: snapshots.map(({ kind }) => namedIds[kind]?.()) });
    const authority = captureJudgmentPort(TASK_ROUTE_SITE, { ...options, assertCurrent: assertLive, prepareResultCapture: prepareJudgmentResult });
    const includeParameters = originalArgs.includeParameters === true;
    const limit = readLimit(originalArgs.limit, includeParameters ? 8 : 5);
    const matchLimit = includeParameters ? 6 : 3;
    const call = { site: TASK_ROUTE_SITE, signal: authority.signal, beforeAttempt: authority.assertCurrent };
    const catalogOptions = { ...options, signal: authority.signal, assertCurrent: authority.assertCurrent };
    const [selection, slotRun, workspaceMatches, harnessModeMatches] = await Promise.all([
      taskRoutePick.select(authority.port, { request: protectedRequest }, routeSource, call),
      readSlots(authority.port, protectedRequest, { ...call, namedIds, assertCurrent: authority.assertCurrent }),
      catalogMatches(deps.workspaceMatches, protectedRequest, matchLimit, catalogOptions),
      catalogMatches(deps.modeMatches, protectedRequest, matchLimit, catalogOptions),
    ]);
    authority.assertCurrent();
    const judgment: TaskRouteJudgment = {
      selection: selectionEvidence(selection),
      slots: { readings: slotRun.readings, decisionId: slotRun.decisionId },
      named: Object.fromEntries(Object.entries(slotRun.named).map(([kind, value]) => [kind, selectionEvidence(value)])),
      workspace: workspaceMatches.ranked,
      harness: harnessModeMatches.ranked,
    };
    const ranked = rankRoutes(protectedRequest, selection, slotRun.slots);
    if (selection.outcome !== 'act') {
      const leading = ranked[0]!;
      selection.recordAction(`held: route selection unsure between ${ranked.length} routes`);
      slotRun.recordAction('held: route selection unsure');
      const restriction = authority.consumeObservation();
      retainCurrent?.(restriction.assertCurrent, TASK_ROUTE_SITE); assertPublication();
      const held: UncertainPlan = {
        status: 'uncertain', request: previewText(protectedRequest, includeParameters ? 220 : 120), judgment,
        unsure: { reading: 'route selection', outcome: selection.outcome, leading: leading.draft.id, probability: leading.score },
        candidates: ranked.slice(0, limit).map((route) => ({ ...describeRoute(route, includeParameters), confidence: 'low' as const })),
        nextAction: 'The route selection was unsure, so no route is preferred. Choose the candidate that matches what the user asked for, or ask the user which outcome they want; each candidate keeps its own confirmation boundary.',
        policy: READ_ONLY_POLICY,
      };
      return held;
    }
    const candidates = ranked.slice(0, limit).map((route) => describeRoute(route, includeParameters));
    const preferred = candidates[0]!;
    selection.recordAction(`preferred ${preferred.id}`);
    slotRun.recordAction(`planned ${preferred.id}`);

    const plan: ReadyPlan = {
      status: 'ready',
      judgment,
      request: previewText(protectedRequest, includeParameters ? 220 : 120),
      preferred,
      alternatives: candidates.slice(1),
      // The plan ranks and then cuts. Naming how many routes were considered
      // keeps `alternatives` from reading as "these are the only other routes"
      // when it is the top few of a longer ranked list.
      routesConsidered: ranked.length,
      ...(candidates.length < ranked.length
        ? { note: `Showing the ${candidates.length} highest-scoring of ${ranked.length} candidate routes; raise limit to see the rest.` }
        : {}),
      nextAction: preferred.requiresConfirmation
        ? 'Inspect the preferred route, collect missing fields, then run the returned confirmed route only after the user explicitly asks for that effect.'
        : 'Use the preferred read-only route first; only move to a confirmed route if the returned plan asks for one and the user requested the effect.',
      workspaceMatches: workspaceMatches.matches,
      harnessModeMatches: harnessModeMatches.matches,
      policy: 'GoodVibes Agent routes by user outcome. Package, daemon, TUI, platform, and host ownership are diagnostic details; the model should choose the visible route that is easiest and safest for the user.',
    };
    authority.assertCurrent();
    const restriction = authority.consumeObservation();
    retainCurrent?.(restriction.assertCurrent, TASK_ROUTE_SITE); assertPublication();
    return plan;
  } finally {
    signal?.removeEventListener('abort', abort);
    await owner.release(handle);
  }
}

/**
 * Shapes shared by the task route catalog, the planner and the route tool.
 * The candidate and plan shapes match the agent's planAgentTaskRoute output.
 */
import type { Outcome, Ranked, Reading, Selection } from '@goodvibes/judgment';
import type { NamedIdSources } from './named-ids.js';
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import type { ProtectedSourceOwner } from '../../security/source-screening/types.js';

export interface TaskRouteReadOptions extends JudgmentReadingOptions {
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  readonly retainCurrent?: ((guard: () => void, key?: string) => void) | undefined;
}

export interface TaskRouteArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

/** One route as the catalog builds it for a request, before its reading is attached. */
export interface TaskRouteDraft {
  readonly id: string;
  readonly label: string;
  readonly userSurface: string;
  readonly userOutcome: string;
  readonly why: string;
  readonly modelRoute: string;
  readonly inspectRoute: string;
  readonly userRoute?: string;
  readonly requiresConfirmation: boolean;
  readonly missingFields?: readonly string[] | undefined;
  readonly nextQuestion?: string;
  readonly supportingRoutes?: readonly string[];
  readonly policy?: string;
}

export type TaskRouteConfidence = 'high' | 'medium' | 'low';

/** One route in a plan. `score` (only with includeParameters) is the route's fit probability. */
export interface TaskRouteCandidate {
  readonly id: string;
  readonly label: string;
  readonly confidence: TaskRouteConfidence;
  readonly userSurface: string;
  readonly userOutcome: string;
  readonly why: string;
  readonly modelRoute: string;
  readonly inspectRoute: string;
  readonly userRoute?: string;
  readonly requiresConfirmation: boolean;
  readonly missingFields?: readonly string[];
  readonly nextQuestion?: string;
  readonly supportingRoutes?: readonly string[];
  readonly policy?: string;
  readonly score?: number;
}

export type PersonalOpsLaneId = 'inbox' | 'calendar' | 'notes' | 'tasks' | 'reminders' | 'routines' | 'delivery';

export type ChannelTask = 'receipts' | 'triage' | 'setup' | 'send' | 'status';

/**
 * What the slot readings settled about one request (slots.ts says how each
 * flag is read). The effect flags decide confirmation and missing fields; the
 * rest pick labels and route strings. Named ids are null when no known id was
 * named, or the reading was too weak to put into a route string.
 */
export interface TaskRouteSlots {
  readonly changes: boolean;
  readonly starts: boolean;
  readonly opensUi: boolean;
  readonly controls: boolean;
  readonly existing: boolean;
  readonly freshRead: boolean;
  readonly reminder: boolean;
  readonly delegated: boolean;
  readonly device: boolean;
  readonly evidence: boolean;
  readonly instructionFiles: boolean;
  readonly lane: PersonalOpsLaneId | null;
  readonly channelTask: ChannelTask;
  readonly policyTarget: string | null;
  readonly modelProvider: string | null;
  readonly memoryProvider: string | null;
  readonly channelTarget: string | null;
}

/**
 * One catalog entry: the candidate id offered to the route selector, the
 * sentence that separates it from its neighbours, and how it becomes a route
 * for a request. Entries whose old code emitted one of several ids (a family)
 * build the variant the slots name.
 */
export interface TaskRouteEntry {
  readonly id: string;
  readonly description: string;
  build(request: string, slots: TaskRouteSlots): TaskRouteDraft;
}

/**
 * Injected product catalogs return typed rankings, or already-resolved records.
 * Judgment-backed callers must supply rankings to preserve uncertainty/provenance.
 * The agent passes its harness mode catalog; a host without it gets an
 * empty match list.
 */
export interface TaskRouteCatalogRanking {
  /** Records are keyed separately so unresolved readings are never actionable matches. */
  readonly records: readonly Record<string, unknown>[];
  readonly ranked: readonly Ranked[];
}
export type TaskRouteCatalogResult = readonly Record<string, unknown>[] | TaskRouteCatalogRanking;
export interface TaskRouteJudgment {
  readonly selection: Omit<Selection, 'recordAction'>;
  readonly slots: { readonly readings: Readonly<Record<string, Reading>>; readonly decisionId: string | undefined };
  readonly named: Readonly<Record<string, Omit<Selection, 'recordAction'>>>;
  readonly harness: readonly Ranked[];
}
export interface TaskRouteDeps {
  /**
   * The live listings named ids are read against (named-ids.ts): model
   * providers from the provider registry (`modelProviderNamedIds`), channel
   * targets from the channel plugin registry (`channelTargetNamedIds`), and
   * the external memory providers the product recognizes. A kind with no
   * listing gets no reading and its generic route string.
   */
  namedIds?: NamedIdSources | undefined;
  modeMatches?(request: string, limit: number, options?: JudgmentReadingOptions): TaskRouteCatalogResult | Promise<TaskRouteCatalogResult>;
}

export interface MissingRequestPlan {
  readonly status: 'missing_request';
  readonly usage: string;
  readonly examples: readonly string[];
  readonly policy: string;
}

export interface ReadyPlan {
  readonly status: 'ready';
  readonly judgment: TaskRouteJudgment;
  readonly request: string;
  readonly preferred: TaskRouteCandidate;
  readonly alternatives: readonly TaskRouteCandidate[];
  readonly routesConsidered: number;
  readonly note?: string;
  readonly nextAction: string;
  readonly harnessModeMatches: readonly Record<string, unknown>[];
  readonly policy: string;
}

/**
 * A held plan: which reading was unsure, and the fitting routes at low
 * confidence for the caller to choose from. With no decision model in use
 * nothing was read (`reading: 'no decision model'`, `judgment: null`): the
 * candidates are the routes whose descriptions share words with the request.
 */
export interface UncertainPlan {
  readonly status: 'uncertain';
  readonly request: string;
  readonly judgment: TaskRouteJudgment | null;
  readonly unsure: { readonly reading: 'route selection' | 'no decision model'; readonly outcome: Outcome; readonly leading: string; readonly probability: number };
  readonly candidates: readonly TaskRouteCandidate[];
  readonly nextAction: string;
  readonly policy: string;
}
export type TaskRoutePlan = MissingRequestPlan | ReadyPlan | UncertainPlan;

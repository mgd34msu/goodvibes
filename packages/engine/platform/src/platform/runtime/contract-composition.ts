import { isOpaqueContractId } from '../contract/types.js';
import { decisionReceipt } from '../contract/decision-records.js';
/**
 * contract-composition.ts, the contract runner as every composition builds it
 * (docs/design/contract-runner.md 2.2 and 11.3): the daemon-grade
 * `createRuntimeServices`, the pure-client `createClientRuntimeServices`, and
 * the standalone agent graph (`agent-graph-composition.ts`) all compose the
 * runner here, so its dependencies are wired in one place.
 *
 * - The route selector is the routing subsystem's route planner over the
 *   provider registry's catalog, tier readings, benchmark leaderboard and
 *   provider health (the runtime store's, and the providers the startup sweep
 *   could not reach), and picks only once the registry's startup model
 *   discovery and the leaderboard load have settled.
 * - The planner runs as a read-only sub-agent through the agent manager.
 * - Each contract gets its own orchestration engine (one per contract).
 * - The agent manager sends every spawn that is not outside a contract to the
 *   runner (`startForOwner`), and the agent orchestrator hands every sub-agent
 *   run the runner's hooks through its tool dependencies (the caller passes
 *   `runner.hooks()` there when it sets them).
 *
 * `resumeContracts` resumes every contract left on disk at startup, once per
 * project root in the process, logs what it resumed or reaped, and hands every
 * caller for the root the same promise of the report.
 */
import { resolve } from 'node:path';
import { createOwnerReadEvidenceReader } from './owner-read-evidence.js';
import { resolveSurfaceDirectory } from './surface-root.js';
import { mapLimit } from '@goodvibes/judgment';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import type { ConfigManager } from '../config/manager.js';
import { ContractStore } from '../contract/store.js';
import { createContractRunner, type ContractRunner } from '../contract/runner.js';
import type { NativeContractDecisionHost } from '../contract/native-decisions.js';
import type { DurableContractBoundary } from '../contract/durable-admission.js';
import { createRoutePlannerContractSelector } from '../contract/route.js';
import type { ResumeReport } from '../contract/resume.js';
import type { ExecutionPlans, WorkPlanService } from '../contract/plan-sync.js';
import type { AgentMessageBus } from '../agents/message-bus.js';
import { createAgentManagerDecompositionRunner } from '../agents/planner-decomposition-runner.js';
import type { FleetCapacityFn } from '../orchestration/elastic-pool.js';
import { createOrchestrationEngine } from '../orchestration/engine.js';
import { compositeScore, type BenchmarkStore } from '../providers/model-benchmarks.js';
import type { ModelDefinition } from '../providers/registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createRoutePlanner, type RoutePlanner, type RoutePlannerDeps } from '../routing/route-planner.js';
import { BENCHMARK_PREPARATION_ATTEMPTS, BENCHMARK_READ_CONCURRENCY } from '../routing/policy.js';
import type { AgentManager } from '../tools/agent/index.js';
import { summarizeError } from '../utils/error-display.js';
import { JudgmentHeldError } from '../types/judgment-held.js';
import { logger } from '../utils/logger.js';
import { buildPricingSeams } from './cost/pricing-seams.js';
import type { RuntimeEventBus } from './events/index.js';
import { makeRuntimeFleetProbe } from './orchestration/fleet-count.js';
import type { ProviderStatus } from '../providers/provider-health.js';

export interface NativeContractCompositionOwner {
  readonly decisions: NativeContractDecisionHost;
  readonly admission: DurableContractBoundary;
}

export interface ContractRunnerCompositionOptions {
  readonly judgmentLog?: Pick<import('@goodvibes/judgment').DecisionLog, 'get'> | undefined;
  /** Registered conversation surface, read for an owner session not loaded in this process. */
  readonly surfaceRoot?: string | undefined;
  /**
   * The stored messages of an owner conversation loaded in this process (the
   * objects the conversation holds), so a contract started mid-turn sees the
   * owner's reads at once; undefined for a session not loaded here.
   */
  readonly ownerConversationMessages?: ((sessionId: string) => readonly object[] | undefined) | undefined;
  readonly runtimeBus: RuntimeEventBus;
  readonly agentManager: AgentManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  /** The project contracts work in; their store lives under it. */
  readonly projectRoot: string;
  /** The fleet ceiling every contract's units share. */
  readonly fleetCapacity: FleetCapacityFn;
  /**
   * The slot releases of that fleet, for units refused for capacity. Default:
   * `agentManager.onFleetSlotReleased`; a graph whose fleet is counted by
   * another manager passes that manager's, which every owner reports to.
   */
  readonly onFleetSlotReleased?: ((listener: () => void) => () => void) | undefined;
  readonly workPlanService?: WorkPlanService | undefined;
  readonly readAccessFilter?: import('../tools/shared/read-access.js').ReadAccessFilter | undefined;
  /** The `exec` permission check each worktree setup command passes before it runs (orchestration/engine.ts). */
  readonly admitSetupCommand?: import('./worktree/setup.js').WorktreeSetupCommandAdmission | undefined;
  readonly planManager?: ExecutionPlans | undefined;
  /** Trusted paired native owners. Absent keeps historical composition; never sourced from config or wire input. */
  readonly nativeOwner?: NativeContractCompositionOwner | undefined;
  readonly nativeDataWriter?: import('./native-reader-compatibility.js').NativeDataWriteOwner | undefined;
}

/**
 * The fleet ceiling for a composition that hosts no third-party coding
 * agents (the client composition and the standalone agent graph): the same
 * count the manager's own spawn admission reads.
 */
export function nativeAgentFleetCapacity(configManager: Pick<ConfigManager, 'get'>, agentManager: Pick<AgentManager, 'fleetCount'>): FleetCapacityFn {
  return makeRuntimeFleetProbe({ readConfig: (key) => configManager.get(key as never), fleet: agentManager });
}

/**
 * A model's benchmark fact for the route planner: the leaderboard's composite
 * score for the model, found by display name or id; null when the leaderboard
 * does not list it.
 */
export function routeBenchmarkFor(benchmarks: Pick<BenchmarkStore, 'getKnownBenchmarks'>): (model: ModelDefinition) => number | null {
  return (model) => {
    const entry = benchmarks.getKnownBenchmarks(model.displayName) ?? benchmarks.getKnownBenchmarks(model.id);
    return entry === undefined ? null : compositeScore(entry.benchmarks);
  };
}

type RouteBenchmarks = Pick<BenchmarkStore, 'getKnownBenchmarks' | 'readBenchmarks'> & Partial<Pick<BenchmarkStore, 'onRefreshed'>>;

/**
 * Capture eligible models' leaderboard facts before the tier shortlist is
 * sorted. Published repository identities resolve locally; unknown models stay
 * unscored. A leaderboard refresh retries the batch to keep one stable snapshot.
 */
async function readRouteBenchmarkSnapshot(
  benchmarks: RouteBenchmarks,
  models: readonly ModelDefinition[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<ModelDefinition, number | null>> {
  signal?.throwIfAborted();
  const stop = new AbortController();
  const readingSignal = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
  let refreshed = false;
  const unsubscribe = benchmarks.onRefreshed?.(() => { refreshed = true; });
  try {
    for (let attempt = 0; attempt < BENCHMARK_PREPARATION_ATTEMPTS; attempt++) {
      refreshed = false;
      await mapLimit(models, BENCHMARK_READ_CONCURRENCY, async (model) => {
        readingSignal.throwIfAborted();
        if (benchmarks.getKnownBenchmarks(model.displayName) ?? benchmarks.getKnownBenchmarks(model.id)) return;
        try {
          const entry = await benchmarks.readBenchmarks(model.displayName, 'routing.route-planner.benchmark-identity', readingSignal);
          readingSignal.throwIfAborted();
          if (entry === undefined && model.id !== model.displayName) {
            await benchmarks.readBenchmarks(model.id, 'routing.route-planner.benchmark-identity', readingSignal);
          }
        } catch (error) {
          readingSignal.throwIfAborted();
          // Optional leaderboard metadata is not an execution prerequisite.
          // Never attach a possibly different model's benchmark to this one.
          if (!(error instanceof JudgmentHeldError)) throw error;
        }
      });
      readingSignal.throwIfAborted();
      // A refresh can invalidate aliases that finished before a sibling's
      // awaited reading. Prepare the whole batch again, not just that sibling.
      if (!refreshed) {
        // Capture scores in this same synchronous turn. A refresh may run
        // after this promise resolves, before the planner resumes to read facts.
        const benchmarkFor = routeBenchmarkFor(benchmarks);
        return new Map(models.map((model) => [model, benchmarkFor(model)]));
      }
    }
    throw new Error('Benchmark leaderboard kept changing during route preparation');
  } catch (error) {
    stop.abort(error);
    throw error;
  } finally {
    unsubscribe?.();
  }
}

/**
 * Warm current benchmark identities. This does not retain a snapshot across
 * the caller's await; routing must use createBenchmarkRoutePlanner instead.
 */
export async function prepareRouteBenchmarks(
  benchmarks: RouteBenchmarks,
  models: readonly ModelDefinition[],
  signal?: AbortSignal,
): Promise<void> {
  await readRouteBenchmarkSnapshot(benchmarks, models, signal);
}

/**
 * The contract runner's planner, with a separate stable benchmark snapshot per plan.
 * `catalogReady` is awaited before each plan: a contract resumed at start-up
 * routes its next group while the providers from the home's provider files may
 * still be loading, and a route read then finds none of them (its own model
 * among them) and fails the contract.
 */
export function createBenchmarkRoutePlanner(
  deps: Omit<RoutePlannerDeps, 'benchmarkFor' | 'prepareBenchmarks'>,
  benchmarks: RouteBenchmarks,
  catalogReady?: () => Promise<void>,
): RoutePlanner {
  return {
    async planRoute(request) {
      await catalogReady?.();
      request.signal?.throwIfAborted();
      // Routes share tier readings but never the score map: another concurrent
      // plan can prepare a newer generation while this plan is still awaiting.
      let scores: ReadonlyMap<ModelDefinition, number | null> = new Map();
      return createRoutePlanner({
        ...deps,
        prepareBenchmarks: async (models, signal) => {
          scores = await readRouteBenchmarkSnapshot(benchmarks, models, signal);
        },
        benchmarkFor: (model) => scores.get(model) ?? null,
      }).planRoute(request);
    },
  };
}

/**
 * The provider health the route planner filters on: the registry's record of
 * what this session's calls and its startup sweep showed, so no route names a
 * model on a provider nothing is serving (a local proxy that is not running,
 * credentials the provider refused, a provider failing right now).
 */
export function routeProviderHealth(
  registry: Pick<ProviderRegistry, 'health'>,
): () => ReadonlyMap<string, { readonly status: ProviderStatus }> {
  return () => registry.health();
}

/** The composed runner and its store; `dispose` releases both. */
export interface ComposedContractRunner {
  readonly runner: ContractRunner;
  readonly store: ContractStore;
  dispose(): void;
}

export function composeContractRunner(options: ContractRunnerCompositionOptions): ComposedContractRunner {
  if (options.nativeOwner && (typeof options.readAccessFilter !== 'function' || typeof options.nativeOwner.decisions?.authorityOf !== 'function' || typeof options.nativeOwner.admission?.withCurrent !== 'function')) {
    throw new Error('Native composition requires both authenticated owners and the original read authorization');
  }
  const writer = options.nativeDataWriter;
  type Format = import('./native-reader-compatibility.js').NativeDataFormat;
  // A format, once published, stays published, so a contract write looks only
  // for the formats not yet published and stops looking once all are.
  const published = new Set<Format>();
  const pending = (format: Format): boolean => writer !== undefined && !published.has(format);
  const publishFormat = (format: Format, refusal: string): void => {
    if (!pending(format)) return;
    assertSynchronousJudgmentGuard(() => writer?.declare(format), () => new Error(refusal));
    published.add(format);
  };
  const store = new ContractStore({ projectRoot: options.projectRoot,
    beforeCreate: id => {
      if (isOpaqueContractId(id)) {
        publishFormat('contract-opaque-identities-v1', 'Contract identity publication requires a synchronous native owner');
      }
    },
    beforeWrite: contract => {
      const formats: Format[] = ['contract-review-observations-v1', 'contract-answer-claim-scopes-v2'];
      if (contract && (pending('contract-tree-baselines-v2') || pending('contract-tree-baselines-v3'))) {
        const baselines = [contract.baseline, ...contract.groups.map(group => group.baseline)];
        const baselineUnits = [...contract.units];
        while (baselineUnits.length) {
          const unit = baselineUnits.pop();
          if (!unit) break;
          baselines.push(unit.baseline);
          baselineUnits.push(...(unit.attemptUnits ?? []));
        }
        if (baselines.some(baseline => baseline?.version === 2)) formats.push('contract-tree-baselines-v2');
        if (baselines.some(baseline => baseline?.version === 3)) formats.push('contract-tree-baselines-v3');
      }
      if (contract && pending('contract-optional-check-digests-v1')) {
        const units = [...contract.units];
        let optionalDigest = [...contract.checks, ...contract.groups.flatMap(group => group.checks)]
          .some(check => check.evidenceDigest === undefined);
        while (units.length && !optionalDigest) {
          const unit = units.pop()!;
          optionalDigest = unit.checks.some(check => check.evidenceDigest === undefined);
          units.push(...(unit.attemptUnits ?? []));
        }
        if (optionalDigest) formats.push('contract-optional-check-digests-v1');
      }
      if (contract && pending('optional-review-binding-v1')) {
        if (contract.decisions.some(decision => {
          if (![`${contract.id}.final-answer-review`, `${contract.id}.goal-obligations`, `${contract.id}.original-obligations`].includes(decision.targetId)) return false;
          const receipt = decisionReceipt(decision);
          return receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)
            && (!Object.hasOwn(receipt, 'stateHash')
              || decision.targetId === `${contract.id}.final-answer-review` && !Object.hasOwn(receipt, 'evidenceDigest'));
        })) formats.push('optional-review-binding-v1');
      }
      if (contract?.inputSnapshot?.indexFingerprint.startsWith('git-index-v2:')) formats.push('contract-input-index-observations-v1');
      if (isOpaqueContractId(contract?.id)) formats.push('contract-opaque-identities-v1');
      if (contract?.nativeSource?.continuation?.version === 2) formats.push('native-conversation-captures-v2');
      for (const format of formats) {
        publishFormat(format, 'Contract data format publication requires a synchronous native owner');
      }
    } });
  const { priceUsage, priceProvenance } = buildPricingSeams(options.providerRegistry);
  const planner = createBenchmarkRoutePlanner({
    catalog: options.providerRegistry,
    tiers: options.providerRegistry.modelTiers,
    providerHealth: routeProviderHealth(options.providerRegistry),
  }, options.providerRegistry.benchmarks, () => options.providerRegistry.ready());
  const runner = createContractRunner({
    providersReady: () => options.providerRegistry.ready(),
    routingChanged: (signal) => options.providerRegistry.routingChanged(signal),
    judgmentLog: options.judgmentLog,
    readOwnerEvidence: options.surfaceRoot || options.ownerConversationMessages
      ? createOwnerReadEvidenceReader({
        liveMessages: options.ownerConversationMessages,
        surfaceDirectory: options.surfaceRoot ? resolveSurfaceDirectory(options.projectRoot, options.surfaceRoot) : undefined,
      })
      : undefined,
    getSelectedModel: () => options.providerRegistry.getCurrentModel(),
    ...(options.nativeOwner === undefined ? {} : { nativeDecisions: options.nativeOwner.decisions, durableAdmission: options.nativeOwner.admission }),
    agentManager: options.agentManager,
    messageBus: options.agentMessageBus,
    runtimeBus: options.runtimeBus,
    configManager: options.configManager,
    projectRoot: options.projectRoot,
    readAccessFilter: options.readAccessFilter,
    routeSelector: createRoutePlannerContractSelector(planner, {
      getSelectedModel: () => options.providerRegistry.getCurrentModel(),
      catalogSettled: async () => {
        await Promise.all([options.providerRegistry.modelDiscoverySettled(), options.providerRegistry.benchmarks.benchmarksSettled()]);
      },
    }),
    decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: options.agentManager }),
    createEngine: (input) => createOrchestrationEngine({
      nativeDataWriter: options.nativeDataWriter,
      agentManager: options.agentManager,
      configManager: options.configManager,
      runtimeBus: options.runtimeBus,
      projectRoot: input.projectRoot,
      initializeWorktree: input.initializeWorktree,
      prepareInputAuthority: input.prepareInputAuthority,
      stateRoot: input.stateRoot,
      stateNamespace: input.stateNamespace,
      sessionId: input.sessionId,
      contractUnitSettlement: input.contractUnitSettlement,
      fleetCapacity: input.fleetCapacity,
      onFleetSlotReleased: options.onFleetSlotReleased ?? ((listener) => options.agentManager.onFleetSlotReleased(listener)),
      judgeAttempts: input.judgeAttempts,
      admitSetupCommand: options.admitSetupCommand,
      priceUsage,
      priceProvenance,
    }),
    fleetCapacity: options.fleetCapacity,
    priceUsage,
    priceProvenance,
    store,
    ...(options.workPlanService === undefined ? {} : { workPlanService: options.workPlanService }),
    ...(options.planManager === undefined ? {} : { planManager: options.planManager }),
  });
  options.agentManager.setContractRunner(runner);
  return {
    runner,
    store,
    dispose: () => {
      options.agentManager.setContractRunner(null);
      releaseResumedRoots(runner);
      runner.dispose();
      store.dispose();
    },
  };
}

/**
 * The resume of each project root this process started, with the runner that
 * started it. Two live compositions can share a root in one process (the
 * daemon's own services and a hosted-session floor on the same workspace); only
 * the first resumes what is on disk, so no contract runs twice, and every later
 * call for the root gets the same promise. The entry ends when its owning
 * runner is disposed or when the resume failed, so a rebuilt composition or a
 * retry resumes what is still on disk.
 */
/** A resume that failed as a whole (no contract was taken up), with why. */
export interface ContractResumeFailure {
  readonly failed: string;
}

const resumedRoots = new Map<string, { readonly owner: object; readonly resuming: Promise<ResumeReport | ContractResumeFailure> }>();

function releaseResumedRoots(owner: object): void {
  for (const [root, entry] of resumedRoots) {
    if (entry.owner === owner) resumedRoots.delete(root);
  }
}

/**
 * Resumes the contracts left on disk under `projectRoot`, once per root while
 * the runner that started it is alive. Every call for a root returns the same
 * promise: it resolves to the report of what was resumed, queued or reaped
 * (also logged), or to `{ failed }` with the reason when resuming failed as a
 * whole (logged, not thrown into startup; a failure is not remembered, so the
 * next call tries again). One contract that cannot be resumed is a `refused`
 * entry of the report, not a whole failure. A host shows either to the owner;
 * one that follows the resumed contracts (the contract CLI) awaits it.
 */
export function resumeContracts(runner: Pick<ContractRunner, 'resumeAll'>, projectRoot: string): Promise<ResumeReport | ContractResumeFailure> {
  const root = resolve(projectRoot);
  const started = resumedRoots.get(root);
  if (started !== undefined) return started.resuming;
  const resuming: Promise<ResumeReport | ContractResumeFailure> = runner.resumeAll().then(
    (report): ResumeReport => {
      logger.info('[contracts] resumed contracts from disk', { projectRoot: root, report });
      return report;
    },
    (error: unknown): ContractResumeFailure => {
      const failed = summarizeError(error);
      logger.error('[contracts] resuming contracts from disk failed', { projectRoot: root, error: failed });
      if (resumedRoots.get(root)?.resuming === resuming) resumedRoots.delete(root);
      return { failed };
    },
  );
  resumedRoots.set(root, { owner: runner, resuming });
  return resuming;
}

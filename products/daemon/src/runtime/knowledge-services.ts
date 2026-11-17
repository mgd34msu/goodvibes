// ---------------------------------------------------------------------------
// knowledge-services.ts, the knowledge/wiki + home-graph stack
//
// Constructs the three KnowledgeStores (regular wiki, agent, home-graph), their
// semantic services, the ingest services, the home-graph service, and the
// project-planning + work-plan stores. Extracted into its own module rather
// than built inline in services.ts, which sits at the architecture check's
// 800-line cap (scripts/check-architecture.ts), new/large construction blocks
// get their own module and a single wiring call there (mirrors
// createWorkstreamServices / createDurabilityServices / createCodeIndexServices).
//
// The semantic services + ingest services receive the memory-governor
// backpressure seams (isBackgroundPaused for the knowledge-self-improvement job
// + admitExpensiveWork for the critical-tier refusal), mirroring the platform's own
// createRuntimeServices. The web-knowledge gap repairer is wired by the caller
// AFTER webSearchService exists (it is constructed later in services.ts), using
// the semantic + ingest handles this returns.
// ---------------------------------------------------------------------------

import {
  HomeGraphService,
  GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  HOME_GRAPH_KNOWLEDGE_DB_FILE,
  REGULAR_KNOWLEDGE_DB_FILE,
  HOME_GRAPH_KNOWLEDGE_EXTENSION,
  KnowledgeService,
  KnowledgeSemanticService,
  KnowledgeStore,
  ProjectPlanningService,
  ProjectWorkPlan,
  createConfiguredPlanningStore,
  configureKnowledgeArtifactReferences,
  createProviderBackedKnowledgeSemanticLlm,
} from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import type { ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';
import type { RuntimeEventBus } from './index.js';
import { join } from 'node:path';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { AsyncDisposalRegistry } from '@goodvibes-jev/engine/platform/platform/runtime/disposal';
import { createNativeWorkLedgerOwner, type NativeWorkLedgerOwner } from './work-ledger-composition.js';

export interface KnowledgeServicesDeps {
  /** Acquire owners immediately, including when a later constructor fails. */
  readonly ownership: {
    readonly registry: AsyncDisposalRegistry;
    ownUntilRegistered(label: string, dispose: () => void | Promise<void>): void;
  };
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  readonly artifactStore: ArtifactStore;
  readonly memoryRegistry: MemoryRegistry;
  readonly runtimeBus: RuntimeEventBus;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** True while the 'knowledge-self-improvement' job is governor-paused. */
  readonly isBackgroundPaused: () => boolean;
  /** Critical-tier admission gate for expensive knowledge work. */
  readonly admitExpensiveWork: (label: string) => { allowed: boolean; reason?: string | undefined };
}

export interface KnowledgeServices {
  readonly knowledgeStore: KnowledgeStore;
  readonly agentKnowledgeStore: KnowledgeStore;
  readonly homeGraphKnowledgeStore: KnowledgeStore;
  readonly knowledgeSemanticService: KnowledgeSemanticService;
  readonly homeGraphSemanticService: KnowledgeSemanticService;
  readonly agentKnowledgeSemanticService: KnowledgeSemanticService;
  readonly knowledgeService: KnowledgeService;
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  /** The project work plan: the planning service's task rows for this project, also served by projectPlanning.workPlan.*. */
  readonly workPlanStore: ProjectWorkPlan;
  /** Trusted host-local authority; the runtime exposes only its service. */
  readonly workLedgerOwner: NativeWorkLedgerOwner;
}

/** Construct the knowledge/wiki + home-graph stack with governor backpressure wired in. */
export function createKnowledgeServices(deps: KnowledgeServicesDeps): KnowledgeServices {
  const { configManager, providerRegistry, artifactStore, memoryRegistry, runtimeBus, isBackgroundPaused, admitExpensiveWork } = deps;
  const knowledgeStore = createConfiguredPlanningStore(configManager, REGULAR_KNOWLEDGE_DB_FILE, { family: 'wiki' });
  deps.ownership.registry.add('regular knowledge store', () => knowledgeStore.close());
  const agentKnowledgeStore = KnowledgeStore.forFamily({ configManager, dbFileName: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE, family: 'agent' });
  deps.ownership.registry.add('agent knowledge store', () => agentKnowledgeStore.close());
  const homeGraphKnowledgeStore = KnowledgeStore.forFamily({ configManager, dbFileName: HOME_GRAPH_KNOWLEDGE_DB_FILE, family: 'home-graph' });
  deps.ownership.registry.add('home graph knowledge store', () => homeGraphKnowledgeStore.close());
  configureKnowledgeArtifactReferences({ artifactStore, controlPlaneDirectory: configManager.getControlPlaneConfigDir(), stores: [knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore] });
  const knowledgeSemanticLlm = createProviderBackedKnowledgeSemanticLlm(providerRegistry, { timeoutMs: 20_000, maxConcurrent: 1 });
  const knowledgeSemanticService = new KnowledgeSemanticService(knowledgeStore, { llm: knowledgeSemanticLlm, maxLlmSourcesPerReindex: 3, isBackgroundPaused, admitExpensiveWork });
  deps.ownership.registry.add('regular knowledge semantic service', () => knowledgeSemanticService.dispose());
  const homeGraphSemanticService = new KnowledgeSemanticService(homeGraphKnowledgeStore, { llm: knowledgeSemanticLlm, maxLlmSourcesPerReindex: 3, objectProfiles: HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles, isBackgroundPaused, admitExpensiveWork });
  deps.ownership.registry.add('home graph semantic service', () => homeGraphSemanticService.dispose());
  const agentKnowledgeSemanticService = new KnowledgeSemanticService(agentKnowledgeStore, { llm: knowledgeSemanticLlm, maxLlmSourcesPerReindex: 3, isBackgroundPaused, admitExpensiveWork });
  deps.ownership.registry.add('agent knowledge semantic service', () => agentKnowledgeSemanticService.dispose());
  const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry, runtimeBus, semanticService: knowledgeSemanticService, admitExpensiveWork });
  deps.ownership.ownUntilRegistered('knowledge service', () => knowledgeService.dispose());
  knowledgeService.attachRuntimeBus(runtimeBus);
  const agentKnowledgeService = new KnowledgeService(agentKnowledgeStore, artifactStore, undefined, { memoryRegistry, runtimeBus, semanticService: agentKnowledgeSemanticService, admitExpensiveWork });
  deps.ownership.ownUntilRegistered('agent knowledge service', () => agentKnowledgeService.dispose());
  agentKnowledgeService.attachRuntimeBus(runtimeBus);
  const homeGraphService = new HomeGraphService(homeGraphKnowledgeStore, artifactStore, { semanticService: homeGraphSemanticService, admitExpensiveWork });
  deps.ownership.ownUntilRegistered('home graph service', () => homeGraphService.dispose());
  const { service: projectPlanningService, projectId: projectPlanningProjectId } = ProjectPlanningService.forConfiguredWorkspace(knowledgeStore, configManager, deps.workingDirectory, { waitForStartup: () => knowledgeService.whenReady(), runtimeBus });
  const workLedgerOwner = createNativeWorkLedgerOwner({ projectId: projectPlanningProjectId, knowledgeStore });
  deps.ownership.registry.add('native work ledger', workLedgerOwner.close);
  const workPlanStore = new ProjectWorkPlan({
    service: projectPlanningService,
    projectId: projectPlanningProjectId,
    projectRoot: deps.workingDirectory,
    surface: GOODVIBES_DAEMON_SURFACE_ROOT,
    exportDirectory: join(deps.homeDirectory, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'work-plans'),
  });
  return {
    knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore,
    knowledgeSemanticService, homeGraphSemanticService, agentKnowledgeSemanticService,
    knowledgeService, agentKnowledgeService, homeGraphService,
    projectPlanningService, projectPlanningProjectId, workPlanStore, workLedgerOwner,
  };
}

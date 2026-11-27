import type { ArtifactDescriptor, ArtifactContentRead } from '@goodvibes/engine/platform/platform/artifacts';

export interface AgentHarnessModelRoutingArgs {
  readonly modelRouteId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly fields?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly timeoutMs?: unknown;
}

export type ModelRouteResolution =
  | { readonly status: 'found'; readonly route: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

export type ModelRouteLookupSource = 'modelRouteId' | 'target' | 'query';

export interface ModelCandidate {
  readonly kind: 'model';
  readonly id: string;
  readonly registryKey: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly current: boolean;
  readonly contextWindow: number | null;
  readonly reasoningEffort: readonly string[];
  readonly capabilities: unknown;
  readonly tier?: string;
  readonly benchmarkCompositeScore?: number | null;
  readonly benchmarkQualityTier?: string;
  readonly localBenchmarkLatency?: LocalModelBenchmarkRouteLatency | null;
  /** null when the favorites could not be read: unknown, not "not pinned". */
  readonly pinned: boolean | null;
  readonly available?: boolean | null;
  readonly configured?: boolean | null;
}

export interface RouteCandidate {
  readonly kind: 'route';
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly currentValue: unknown;
  readonly settingKeys: readonly string[];
  readonly commands: readonly string[];
  readonly uiSurfaces: readonly string[];
}

export interface LocalModelDetection {
  readonly providerIds: readonly string[];
  readonly modelRoutes: readonly string[];
  readonly stacks: readonly string[];
}

export interface LocalModelHardwareProfile {
  readonly platform: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuThreads: number;
  readonly ramGb: number;
  readonly freeRamGb: number;
  readonly acceleratorHint: 'apple-silicon' | 'cuda-env' | 'none-detected';
  readonly privacy: 'local-only';
  readonly caveat: string;
}

export interface LocalModelRecipe {
  readonly id: string;
  readonly label: string;
  readonly fit: string;
  readonly bestFor: string;
  readonly hardware: string;
  readonly setup: readonly string[];
  readonly modelExamples: readonly string[];
  readonly cautions: readonly string[];
}

export interface LocalModelRecipeFit {
  readonly score: number | null;
  readonly level: 'weak' | 'usable' | 'good' | 'strong' | null;
  readonly outcome: ModelReadingOutcome;
  readonly confidence: number | null;
  readonly decisionId: string | null;
  readonly memoryTier: 'constrained' | 'starter' | 'comfortable' | 'large' | null;
  readonly provenance: unknown;
  readonly reasons: readonly string[];
}

export type ModelReadingOutcome = 'ready' | 'held' | 'rejected' | 'deferred' | 'unavailable';

export interface ModelReadinessDimension {
  readonly id: 'latency' | 'context-window' | 'tool-support' | 'vision' | 'cost' | 'privacy';
  readonly label: string;
  readonly score: number | null;
  readonly confidence: number | null;
  readonly outcome: ModelReadingOutcome;
  readonly weight: number;
  readonly summary: string;
}

/** What this Agent process measured on its own calls to a provider route (the engine's LLM call metrics). */
export interface ModelProviderHealthSignal {
  readonly status: 'measured' | 'not-measured';
  readonly providerId: string;
  readonly modelRouteId?: string;
  /** Set when the measurement is of this exact model, not of the provider as a whole. */
  readonly measuredRouteId?: string;
  readonly measuredProviderId?: string;
  readonly measurementRecordedAt?: string | null;
  readonly source: 'agent-provider-calls';
  readonly successCalls?: number;
  readonly errorCalls?: number;
  readonly errorRate?: number;
  readonly avgLatencyMs?: number;
  readonly minLatencyMs?: number;
  readonly maxLatencyMs?: number;
  readonly missingSignals: readonly string[];
  readonly policy: string;
}

export interface ModelReadinessScore {
  readonly score: number | null;
  readonly normalized?: number | null;
  readonly level: 'risky' | 'usable' | 'good' | 'excellent' | null;
  readonly outcome: ModelReadingOutcome;
  readonly confidence: number | null;
  readonly decisionId: string | null;
  readonly provenance: unknown;
  readonly cloudTransfer: unknown;
  readonly exampleVision?: readonly unknown[];
  readonly dimensions: readonly ModelReadinessDimension[];
  readonly missingSignals: readonly string[];
  readonly providerHealth?: ModelProviderHealthSignal;
  readonly nextStep: string;
}

export interface ModelRouteReadinessScore extends ModelReadinessScore {
  readonly providerHealth: ModelProviderHealthSignal;
}

export interface LocalModelBenchmarkPlan {
  readonly status: 'plan-ready';
  readonly prompt: string;
  readonly measurements: readonly string[];
  readonly capabilityRoute: string;
  readonly compareRoute: string;
  readonly refreshRoute: string;
  readonly notes: readonly string[];
}

export interface LocalModelBenchmarkWinner {
  readonly judgmentArtifactId: string;
  readonly sourceArtifactId: string | null;
  readonly registryKey: string;
  readonly stack: string | null;
  readonly promptPreview: string;
  readonly reviewRoute: string;
  readonly exportRoute: string;
  readonly applyRoute: string;
}

export interface LocalModelBenchmarkRouteLatency {
  readonly registryKey: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly blindId: string;
  readonly latencyMs: number;
  readonly status: string;
  readonly artifactId: string;
  readonly comparisonId: string | null;
  readonly createdAt: string | null;
  readonly reviewRoute: string;
}

export interface LocalModelBenchmarkEvidence {
  readonly status: 'unavailable' | 'unmeasured' | 'comparison-saved' | 'reviewed-winner';
  readonly comparisonCount: number;
  readonly completedCandidateCount: number;
  readonly revealedJudgmentCount: number;
  readonly hiddenJudgmentCount: number;
  readonly winnerStacks: readonly string[];
  readonly winnerModels: readonly LocalModelBenchmarkWinner[];
  readonly routeLatencies: readonly LocalModelBenchmarkRouteLatency[];
  readonly summary: string;
  readonly confidence: 'estimated' | 'measured';
}

export type LocalModelEndpointSource = 'provider-registry' | 'model-registry' | 'environment';

export interface LocalModelServerEndpoint {
  readonly kind: 'local-server-endpoint';
  readonly id: string;
  readonly providerId: string | null;
  readonly stack: string | null;
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly diagnosticStatus: 'registered-route-needs-smoke' | 'needs-provider-after-smoke';
  readonly inspectRoute: string;
  readonly sources: readonly LocalModelEndpointSource[];
  readonly sourceDetails: readonly string[];
  readonly modelRoutes: readonly string[];
  readonly smokeCommand: string;
  readonly smokeRoute: string;
  readonly refreshRoute: string;
  readonly addProviderRoute: string | null;
  readonly notes: readonly string[];
  /** The last confirmed smoke of this endpoint in this session; absent until `models action:"smoke"` probes it. */
  readonly lastSmoke?: LocalModelLastSmoke;
  readonly diagnostics?: {
    readonly liveProbe: 'not-run';
    readonly successCriteria: readonly string[];
    readonly failureTriage: readonly string[];
    readonly afterSmoke: readonly string[];
    readonly policy: string;
  };
}

/** The last confirmed smoke of an endpoint in this Agent process: what the probe actually saw. */
export interface LocalModelLastSmoke {
  readonly status: 'passed' | 'http-error' | 'invalid-json' | 'no-models' | 'timeout' | 'unreachable' | 'blocked';
  readonly reachable: boolean;
  readonly httpStatus: number | null;
  readonly modelCount: number;
  readonly sampleModelIds: readonly string[];
  readonly elapsedMs: number | null;
  readonly checkedAt: string;
}

export interface LocalModelServerDefaultEndpoint {
  readonly id: string;
  readonly label: string;
  readonly stack: string;
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly smokeCommand: string;
  readonly addProviderRoute: string;
  readonly startHint: string;
}

export interface LocalModelServerHealthMap {
  readonly status: 'candidate-endpoints' | 'no-local-endpoints';
  readonly liveProbe: 'not-run';
  readonly endpointCount: number;
  readonly returnedEndpoints: number;
  readonly endpoints: readonly LocalModelServerEndpoint[];
  readonly suggestedDefaults: readonly LocalModelServerDefaultEndpoint[];
  readonly nextActions: readonly string[];
  readonly policy: string;
}

export interface LocalModelSmokeTarget {
  readonly kind: 'local-server-endpoint' | 'suggested-local-server';
  readonly id: string;
  readonly label: string;
  readonly providerId: string | null;
  readonly stack: string | null;
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly smokeCommand: string;
  readonly smokeRoute: string;
  readonly refreshRoute: string;
  readonly addProviderRoute: string | null;
  readonly source: string;
  readonly notes: readonly string[];
}

export interface MutableLocalModelServerEndpoint {
  providerId: string | null;
  stack: string | null;
  readonly baseUrl: string;
  readonly sources: Set<LocalModelEndpointSource>;
  readonly sourceDetails: Set<string>;
  readonly modelRoutes: Set<string>;
  readonly notes: Set<string>;
}

export interface LocalModelSetupPlan {
  readonly status: 'detected' | 'ready-to-try' | 'needs-hardware-review' | 'unknown';
  readonly priority: number | null;
  readonly downloadGuidance: readonly string[];
  readonly providerRoutes: readonly string[];
  readonly benchmarkPlan: LocalModelBenchmarkPlan;
  readonly confirmationBoundary: string;
}

export interface ArtifactListLike {
  readonly list?: (limit?: number) => readonly ArtifactDescriptor[];
  readonly readContent?: (id: string) => Promise<ArtifactContentRead>;
}

export interface ProviderApiLike {
  readonly getFavorites: () => Promise<unknown>;
  readonly getCurrentModel: () => Promise<unknown>;
  readonly listModels: (options?: { readonly selectableOnly?: boolean }) => Promise<readonly unknown[]>;
  readonly listProviderIds: () => readonly string[];
}

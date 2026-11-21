import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentManager } from '../../tools/agent/index.js';
import type { AgentRecord } from '../../tools/agent/manager.js';
import type { RuntimeStore } from '../store/index.js';
import type { AcpConnection } from '../store/domains/acp.js';
import { logger } from '../../utils/logger.js';
import type {
  RemoteExecutionArtifact,
  RemoteRunnerContract,
  RemoteRunnerCapabilityCeiling,
  RemoteRunnerEvidenceSummary,
  RemoteRunnerPool,
  RemoteSessionBundle,
} from './types.js';
import type { RuntimeTask } from '../store/domains/tasks.js';
import { summarizeError } from '../../utils/error-display.js';

const DEFAULT_ARTIFACT_DIR = '.goodvibes/remote-artifacts';
const DEFAULT_SESSION_BUNDLE_DIR = '.goodvibes/remote-sessions';
/** Captured artifacts hold whole agent output, so the registry keeps only the newest. */
const MAX_ARTIFACTS = 100;

/**
 * Imports are checked for the fields the review, contract and artifact views
 * read before anything is stored, so a file that is not an export cannot sit
 * in the registry and break those views until restart. The first missing
 * field is named, so the person importing knows what is wrong with the file.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingField(value: Record<string, unknown>, fields: Readonly<Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>>, prefix: string): string | null {
  for (const [field, kind] of Object.entries(fields)) {
    const entry = value[field];
    const ok = kind === 'array' ? Array.isArray(entry) : kind === 'object' ? isObject(entry) : typeof entry === kind;
    if (!ok) return `${prefix}${field} (${kind})`;
  }
  return null;
}

function contractProblem(value: unknown, prefix: string): string | null {
  if (!isObject(value)) return `${prefix || 'contract'} (object)`;
  const missing = missingField(value, { id: 'string', runnerId: 'string', label: 'string', template: 'string', capabilityCeiling: 'object', createdAt: 'number', lastUpdatedAt: 'number' }, prefix);
  if (missing) return missing;
  // A local runner's contract has no transport; one that is present must be readable.
  if (value['transport'] !== undefined && !isObject(value['transport'])) return `${prefix}transport (object)`;
  return missingField(value['capabilityCeiling'] as Record<string, unknown>, { allowedTools: 'array', capabilityCeilingTools: 'array', successCriteria: 'array', requiredEvidence: 'array', writeScope: 'array' }, `${prefix}capabilityCeiling.`);
}

function artifactProblem(value: unknown, prefix: string): string | null {
  if (!isObject(value)) return `${prefix || 'artifact'} (object)`;
  const missing = missingField(value, { id: 'string', runnerId: 'string', createdAt: 'number', runnerContract: 'object', task: 'object', evidence: 'object', knowledgeInjections: 'array' }, prefix);
  if (missing) return missing;
  return contractProblem(value['runnerContract'], `${prefix}runnerContract.`)
    ?? missingField(value['task'] as Record<string, unknown>, { task: 'string', status: 'string', summary: 'string', startedAt: 'number' }, `${prefix}task.`)
    ?? missingField(value['evidence'] as Record<string, unknown>, { toolCallCount: 'number', errorCount: 'number' }, `${prefix}evidence.`);
}

function bundleProblem(value: unknown): string | null {
  if (!isObject(value)) return 'session bundle (object)';
  const missing = missingField(value, { pools: 'array', contracts: 'array', artifacts: 'array' }, '');
  if (missing) return missing;
  const pools = value['pools'] as unknown[];
  for (const [index, pool] of pools.entries()) {
    if (!isObject(pool)) return `pools[${index}] (object)`;
    const problem = missingField(pool, { id: 'string', label: 'string', runnerIds: 'array' }, `pools[${index}].`);
    if (problem) return problem;
  }
  for (const [index, contract] of (value['contracts'] as unknown[]).entries()) {
    const problem = contractProblem(contract, `contracts[${index}].`);
    if (problem) return problem;
  }
  for (const [index, artifact] of (value['artifacts'] as unknown[]).entries()) {
    const problem = artifactProblem(artifact, `artifacts[${index}].`);
    if (problem) return problem;
  }
  return null;
}

async function readImportFile(path: string, kind: string): Promise<unknown> {
  const raw = await readFile(resolve(path), 'utf-8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Cannot import ${kind} from ${path}: the file is not JSON. Import a file written by the matching remote export.`);
  }
}

function buildCapabilityCeiling(agent: AgentRecord): RemoteRunnerCapabilityCeiling {
  return Object.freeze({
    allowedTools: [...agent.tools],
    capabilityCeilingTools: [...(agent.capabilityCeilingTools ?? agent.tools)],
    executionProtocol: agent.executionProtocol,
    reviewMode: agent.reviewMode,
    communicationLane: agent.communicationLane,
    orchestrationDepth: agent.orchestrationDepth,
    successCriteria: [...(agent.successCriteria ?? [])],
    requiredEvidence: [...(agent.requiredEvidence ?? [])],
    writeScope: [...(agent.writeScope ?? [])],
  });
}

function buildEvidenceSummary(agent: AgentRecord, connection?: AcpConnection): RemoteRunnerEvidenceSummary {
  return Object.freeze({
    toolCallCount: agent.toolCallCount,
    errorCount: connection?.errorCount ?? 0,
    ...(connection ? { transportState: connection.transportState, connectedAt: connection.connectedAt } : {}),
    lastError: connection?.lastError ?? agent.error,
    hasKnowledgeInjections: (agent.knowledgeInjections?.length ?? 0) > 0,
  });
}

function summarizeOutput(agent: AgentRecord): string {
  const raw = agent.fullOutput ?? agent.progress ?? agent.error ?? 'No output recorded.';
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function buildContract(agent: AgentRecord, workspaceRoot: string | undefined, connection?: AcpConnection, existing?: RemoteRunnerContract): RemoteRunnerContract {
  return Object.freeze({
    id: `runner:${agent.id}`,
    runnerId: agent.id,
    poolId: existing?.poolId,
    taskId: existing?.taskId,
    label: connection?.label ?? `${agent.template} runner`,
    sourceTransport: connection ? 'acp' : 'daemon',
    trustClass: connection ? 'self-hosted-acp' : 'local-daemon',
    template: agent.template,
    parentAgentId: agent.parentAgentId,
    orchestrationGraphId: agent.orchestrationGraphId,
    orchestrationNodeId: agent.orchestrationNodeId,
    capabilityCeiling: buildCapabilityCeiling(agent),
    workspaceRoot: workspaceRoot ?? existing?.workspaceRoot,
    createdAt: agent.startedAt,
    lastUpdatedAt: agent.completedAt ?? Date.now(),
    ...(connection
      ? {
          transport: Object.freeze({
            state: connection.transportState,
            connectedAt: connection.connectedAt,
            errorCount: connection.errorCount,
            lastError: connection.lastError,
          }),
        }
      : {}),
  });
}

function buildArtifact(agent: AgentRecord, contract: RemoteRunnerContract, connection?: AcpConnection): RemoteExecutionArtifact {
  return Object.freeze({
    id: `artifact:${agent.id}:${Date.now()}-${randomUUID().slice(0, 8)}`,
    runnerId: agent.id,
    createdAt: Date.now(),
    runnerContract: contract,
    task: Object.freeze({
      task: agent.task,
      status: agent.status,
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      summary: summarizeOutput(agent),
      fullOutput: agent.fullOutput,
      error: agent.error,
      progress: agent.progress,
    }),
    evidence: buildEvidenceSummary(agent, connection),
    knowledgeInjections: Object.freeze([...(agent.knowledgeInjections ?? [])]),
  });
}

function summarizeTaskOutput(task?: RuntimeTask): string {
  if (!task) return 'No task output recorded.';
  const payload = (
    typeof task.result === 'string'
      ? task.result
      : task.error
        ?? (task.result !== undefined ? JSON.stringify(task.result) : task.description)
        ?? task.title
  );
  const normalized = String(payload).replace(/\s+/g, ' ').trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

function findTaskForContract(contract: RemoteRunnerContract, store?: RuntimeStore): RuntimeTask | undefined {
  if (!store) return undefined;
  const tasks = store.getState().tasks.tasks;
  if (contract.taskId) {
    const byTaskId = tasks.get(contract.taskId);
    if (byTaskId) return byTaskId;
  }
  for (const task of tasks.values()) {
    if (task.owner === contract.runnerId && task.kind === 'acp') {
      return task;
    }
  }
  return undefined;
}

/**
 * The artifact's status for the store's task. A task the store no longer holds
 * (evicted after it ended, or a contract imported from a file) is `unknown`,
 * never `running`: nothing says the work is still going.
 */
function mapTaskStatus(
  task?: RuntimeTask,
): RemoteExecutionArtifact['task']['status'] {
  if (!task) return 'unknown';
  switch (task.status) {
    case 'queued':
      return 'pending';
    case 'running':
    case 'blocked':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function buildArtifactFromStore(
  contract: RemoteRunnerContract,
  store?: RuntimeStore,
): RemoteExecutionArtifact {
  const connection = contract.runnerId ? store?.getState().acp.connections.get(contract.runnerId) : undefined;
  const task = findTaskForContract(contract, store);
  return Object.freeze({
    id: `artifact:${contract.runnerId}:${Date.now()}-${randomUUID().slice(0, 8)}`,
    runnerId: contract.runnerId,
    createdAt: Date.now(),
    runnerContract: contract,
    task: Object.freeze({
      task: task?.description ?? task?.title ?? contract.label,
      status: mapTaskStatus(task),
      startedAt: task?.startedAt ?? contract.createdAt,
      completedAt: task?.endedAt,
      summary: summarizeTaskOutput(task),
      ...(typeof task?.result === 'string' ? { fullOutput: task.result } : {}),
      ...(task?.error ? { error: task.error } : {}),
    }),
    evidence: Object.freeze({
      toolCallCount: 0,
      errorCount: connection?.errorCount ?? contract.transport?.errorCount ?? 0,
      transportState: connection?.transportState ?? contract.transport?.state,
      connectedAt: connection?.connectedAt ?? contract.transport?.connectedAt,
      lastError: connection?.lastError ?? contract.transport?.lastError,
      hasKnowledgeInjections: false,
    }),
    knowledgeInjections: Object.freeze([]),
  });
}

export class RemoteRunnerRegistry {
  private readonly contracts = new Map<string, RemoteRunnerContract>();
  private readonly artifacts = new Map<string, RemoteExecutionArtifact>();
  private readonly pools = new Map<string, RemoteRunnerPool>();
  /**
   * @param workspaceRoot The runtime's working directory; carried on every
   *   contract this registry builds.
   */
  constructor(
    private readonly agentManager: Pick<AgentManager, 'getStatus' | 'list'>,
    private readonly workspaceRoot?: string | undefined,
  ) {
  }

  private storeArtifact(artifact: RemoteExecutionArtifact): void {
    // Evict by storage order, not createdAt: an older artifact being imported must not be the one dropped at once.
    this.artifacts.delete(artifact.id);
    this.artifacts.set(artifact.id, artifact);
    for (const oldest of this.artifacts.keys()) {
      if (this.artifacts.size <= MAX_ARTIFACTS) break;
      this.artifacts.delete(oldest);
    }
  }

  /** A runner the agent manager still tracks keeps the contract built from its live state. */
  private storeImportedContract(contract: RemoteRunnerContract): void {
    if (!this.agentManager.getStatus(contract.runnerId)) this.contracts.set(contract.runnerId, contract);
  }

  /**
   * Why an imported contract may not be stored: a file must not replace the
   * capability ceiling of a runner this runtime already holds with a different
   * one. Every import path (artifact, session bundle) asks this before storing.
   */
  private importedCeilingConflict(contract: RemoteRunnerContract): string | undefined {
    const existing = this.contracts.get(contract.runnerId);
    if (!existing || this.agentManager.getStatus(contract.runnerId)) return undefined;
    if (JSON.stringify(existing.capabilityCeiling) === JSON.stringify(contract.capabilityCeiling)) return undefined;
    return `runner ${contract.runnerId} already has a different capability ceiling in this session, and the file would replace it`;
  }

  private resolveConnection(agentId: string, store?: RuntimeStore): AcpConnection | undefined {
    return store?.getState().acp.connections.get(agentId);
  }

  upsertContractForAgent(agentId: string, store?: RuntimeStore): RemoteRunnerContract | null {
    const agent = this.agentManager.getStatus(agentId);
    if (!agent) return null;
    const contract = buildContract(agent, this.workspaceRoot, this.resolveConnection(agentId, store), this.contracts.get(agentId) ?? undefined);
    this.contracts.set(agentId, contract);
    if (contract.poolId) {
      this.assignRunnerToPool(contract.poolId, contract.runnerId);
    }
    return contract;
  }

  getContract(agentId: string): RemoteRunnerContract | null {
    return this.contracts.get(agentId) ?? null;
  }

  /** The contract a live runner would have now, built without storing it; an imported one as stored. */
  readContractForAgent(agentId: string, store?: RuntimeStore): RemoteRunnerContract | null {
    const agent = this.agentManager.getStatus(agentId);
    if (!agent) return this.getContract(agentId);
    return buildContract(agent, this.workspaceRoot, this.resolveConnection(agentId, store), this.contracts.get(agentId) ?? undefined);
  }

  registerContract(contract: RemoteRunnerContract): RemoteRunnerContract {
    const previousPoolId = this.contracts.get(contract.runnerId)?.poolId;
    this.contracts.set(contract.runnerId, contract);
    // A contract that names another pool takes the runner out of the one the replaced contract named.
    if (previousPoolId !== undefined && previousPoolId !== contract.poolId) this.dropFromPoolList(previousPoolId, contract.runnerId);
    if (contract.poolId) {
      this.assignRunnerToPool(contract.poolId, contract.runnerId);
    }
    return contract;
  }

  listContracts(): RemoteRunnerContract[] {
    return [...this.contracts.values()].sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  }

  createPool(input: {
    id: string;
    label?: string | undefined;
    description?: string | undefined;
    trustClass?: RemoteRunnerPool['trustClass'] | undefined;
    preferredTemplate?: string | undefined;
    maxRunners?: number | undefined;
  }): RemoteRunnerPool {
    const existing = this.pools.get(input.id);
    const now = Date.now();
    const pool: RemoteRunnerPool = Object.freeze({
      id: input.id,
      label: input.label ?? existing?.label ?? input.id,
      description: input.description ?? existing?.description,
      trustClass: input.trustClass ?? existing?.trustClass ?? 'self-hosted-acp',
      preferredTemplate: input.preferredTemplate ?? existing?.preferredTemplate,
      maxRunners: input.maxRunners ?? existing?.maxRunners,
      runnerIds: existing?.runnerIds ?? [],
      createdAt: existing?.createdAt ?? now,
      lastUpdatedAt: now,
    });
    this.pools.set(pool.id, pool);
    return pool;
  }

  getPool(poolId: string): RemoteRunnerPool | null {
    return this.pools.get(poolId) ?? null;
  }

  listPools(): RemoteRunnerPool[] {
    return [...this.pools.values()].sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
  }

  /** Takes `runnerId` out of one pool's list; the contract is left to the caller. */
  private dropFromPoolList(poolId: string, runnerId: string): void {
    const pool = this.pools.get(poolId);
    if (!pool || !pool.runnerIds.includes(runnerId)) return;
    this.pools.set(poolId, Object.freeze({
      ...pool,
      runnerIds: pool.runnerIds.filter((id) => id !== runnerId),
      lastUpdatedAt: Date.now(),
    }));
  }

  assignRunnerToPool(poolId: string, runnerId: string): RemoteRunnerPool | null {
    const contract = this.contracts.get(runnerId);
    const pool = this.pools.get(poolId) ?? this.createPool({ id: poolId, label: poolId });
    if (pool.maxRunners !== undefined && !pool.runnerIds.includes(runnerId) && pool.runnerIds.length >= pool.maxRunners) {
      return null;
    }
    const nextRunnerIds = pool.runnerIds.includes(runnerId)
      ? pool.runnerIds
      : [...pool.runnerIds, runnerId];
    const nextPool: RemoteRunnerPool = Object.freeze({
      ...pool,
      runnerIds: nextRunnerIds,
      lastUpdatedAt: Date.now(),
    });
    this.pools.set(poolId, nextPool);
    if (contract && contract.poolId !== poolId) {
      // A runner is in at most one pool: moving it takes it out of the pool its contract named.
      if (contract.poolId !== undefined) this.dropFromPoolList(contract.poolId, runnerId);
      this.contracts.set(runnerId, Object.freeze({ ...contract, poolId, lastUpdatedAt: Date.now() }));
    }
    return nextPool;
  }

  removeRunnerFromPool(poolId: string, runnerId: string): RemoteRunnerPool | null {
    const pool = this.pools.get(poolId);
    if (!pool) return null;
    const nextPool: RemoteRunnerPool = Object.freeze({
      ...pool,
      runnerIds: pool.runnerIds.filter((id) => id !== runnerId),
      lastUpdatedAt: Date.now(),
    });
    this.pools.set(poolId, nextPool);
    const contract = this.contracts.get(runnerId);
    if (contract?.poolId === poolId) {
      this.contracts.set(runnerId, Object.freeze({ ...contract, poolId: undefined, lastUpdatedAt: Date.now() }));
    }
    return nextPool;
  }

  captureArtifactForAgent(agentId: string, store?: RuntimeStore): RemoteExecutionArtifact | null {
    const agent = this.agentManager.getStatus(agentId);
    if (!agent) return null;
    const connection = this.resolveConnection(agentId, store);
    const contract = this.upsertContractForAgent(agentId, store) ?? buildContract(agent, this.workspaceRoot, connection);
    const artifact = buildArtifact(agent, contract, connection);
    this.storeArtifact(artifact);
    return artifact;
  }

  captureArtifactForRunner(runnerId: string, store?: RuntimeStore): RemoteExecutionArtifact | null {
    const byAgent = this.captureArtifactForAgent(runnerId, store);
    if (byAgent) return byAgent;
    const contract = this.contracts.get(runnerId);
    if (!contract) return null;
    const artifact = buildArtifactFromStore(contract, store);
    this.storeArtifact(artifact);
    return artifact;
  }

  getArtifact(artifactId: string): RemoteExecutionArtifact | null {
    return this.artifacts.get(artifactId) ?? null;
  }

  listArtifacts(): RemoteExecutionArtifact[] {
    return [...this.artifacts.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async exportArtifact(
    artifactId: string,
    explicitPath?: string,
  ): Promise<{ artifact: RemoteExecutionArtifact; path: string } | null> {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) return null;
    const path = explicitPath
      ? resolve(explicitPath)
      : resolve(this.workspaceRoot ?? process.cwd(), DEFAULT_ARTIFACT_DIR, `${artifact.id.replace(/[:]/g, '_')}.json`);
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    return { artifact, path };
  }

  /** Whether a record held under an id would be replaced by `next`; holding the same record under the id is no replacement. */
  private differs(held: unknown, next: unknown): boolean {
    return held !== undefined && JSON.stringify(held) !== JSON.stringify(next);
  }

  /** Import one artifact; one that would replace a different artifact held under its id is refused unless `replace` is set. */
  async importArtifact(path: string, options: { readonly replace?: boolean | undefined } = {}): Promise<RemoteExecutionArtifact> {
    const value = await readImportFile(path, 'a remote artifact');
    const problem = artifactProblem(value, '');
    if (problem) {
      throw new Error(`Cannot import a remote artifact from ${path}: it has no valid ${problem}. Nothing was imported; import a file written by a remote artifact export.`);
    }
    const parsed = value as unknown as RemoteExecutionArtifact;
    const conflict = this.importedCeilingConflict(parsed.runnerContract);
    if (conflict) {
      throw new Error(`Cannot import a remote artifact from ${path}: ${conflict}. Nothing was imported; export the runner's current contract, or import into a session that does not know this runner.`);
    }
    if (this.differs(this.artifacts.get(parsed.id), parsed) && options.replace !== true) {
      throw new Error(`Not imported: ${path} would replace artifact ${parsed.id}. Nothing was changed; run the import again with --yes to replace it.`);
    }
    this.storeArtifact(parsed);
    this.storeImportedContract(parsed.runnerContract);
    return parsed;
  }

  buildSessionBundle(store?: RuntimeStore): RemoteSessionBundle {
    this.ensureContractsFromStore(store);
    const activeConnectionIds = store?.getState().acp.activeConnectionIds ?? [];
    const conversationSessionId = store?.getState().session.conversationSessionId;
    return Object.freeze({
      version: 1,
      exportedAt: Date.now(),
      sessionId: store?.getState().session.id || 'unknown-session',
      ...(conversationSessionId ? { conversationSessionId } : {}),
      activeConnectionIds: Object.freeze([...activeConnectionIds]),
      pools: Object.freeze(this.listPools()),
      contracts: Object.freeze(this.listContracts()),
      artifacts: Object.freeze(this.listArtifacts()),
    });
  }

  async exportSessionBundle(
    store?: RuntimeStore,
    explicitPath?: string,
  ): Promise<{ bundle: RemoteSessionBundle; path: string }> {
    const bundle = this.buildSessionBundle(store);
    const path = explicitPath
      ? resolve(explicitPath)
      : resolve(this.workspaceRoot ?? process.cwd(), DEFAULT_SESSION_BUNDLE_DIR, `${bundle.sessionId}-${bundle.exportedAt}.json`);
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    return { bundle, path };
  }

  /**
   * Validate a parsed session bundle and say what importing it would replace,
   * with no write: the look before an import, and the same check the import
   * makes. `replaces` names the pools, runner contracts and artifacts this
   * runtime already holds under the bundle's ids.
   */
  describeSessionBundleImport(value: unknown):
    | { readonly ok: false; readonly problem: string }
    | { readonly ok: true; readonly bundle: RemoteSessionBundle; readonly replaces: readonly string[] } {
    const problem = bundleProblem(value);
    if (problem) return { ok: false, problem: `it has no valid ${problem}` };
    const bundle = value as unknown as RemoteSessionBundle;
    const differs = (held: unknown, next: unknown): boolean => this.differs(held, next);
    const replaces = [
      ...bundle.pools.filter((pool) => differs(this.pools.get(pool.id), pool)).map((pool) => `pool ${pool.id}`),
      ...bundle.contracts.filter((contract) => !this.agentManager.getStatus(contract.runnerId) && differs(this.contracts.get(contract.runnerId), contract)).map((contract) => `runner contract ${contract.runnerId}`),
      ...bundle.artifacts.filter((artifact) => differs(this.artifacts.get(artifact.id), artifact)).map((artifact) => `artifact ${artifact.id}`),
    ];
    return { ok: true, bundle, replaces };
  }

  /** Import a session bundle; one that would replace what this runtime holds is refused unless `replace` is set. */
  async importSessionBundle(path: string, options: { readonly replace?: boolean | undefined } = {}): Promise<RemoteSessionBundle> {
    const value = await readImportFile(path, 'a remote session bundle');
    const described = this.describeSessionBundleImport(value);
    if (!described.ok) {
      throw new Error(`Cannot import a remote session bundle from ${path}: ${described.problem}. Nothing was imported; import a file written by a remote session bundle export.`);
    }
    const parsed = described.bundle;
    if (parsed.artifacts.length > MAX_ARTIFACTS) {
      throw new Error(`Cannot import a remote session bundle from ${path}: it holds ${parsed.artifacts.length} artifacts and this runtime keeps at most ${MAX_ARTIFACTS}. Nothing was imported; export a smaller bundle.`);
    }
    const conflicts = parsed.contracts.map((contract) => this.importedCeilingConflict(contract)).filter((reason) => reason !== undefined);
    if (conflicts.length > 0) {
      throw new Error(`Cannot import a remote session bundle from ${path}: ${conflicts.join('; ')}. Nothing was imported; export the runners' current contracts, or import into a session that does not know these runners.`);
    }
    if (described.replaces.length > 0 && options.replace !== true) {
      throw new Error(`Not imported: ${path} would replace ${described.replaces.join(', ')}. Nothing was changed; run the import again with --yes to replace them.`);
    }
    for (const pool of parsed.pools) {
      this.pools.set(pool.id, pool);
    }
    for (const contract of parsed.contracts) {
      this.storeImportedContract(contract);
    }
    for (const artifact of parsed.artifacts) {
      this.storeArtifact(artifact);
    }
    return parsed;
  }

  buildReviewSummary(artifactId: string): string | null {
    const artifact = this.getArtifact(artifactId);
    if (!artifact) return null;
    const lines = [
      `Remote Artifact ${artifact.id}`,
      `  runner: ${artifact.runnerId}`,
      `  template: ${artifact.runnerContract.template}`,
      `  status: ${artifact.task.status}`,
      `  summary: ${artifact.task.summary}`,
      `  tools: ${artifact.runnerContract.capabilityCeiling.allowedTools.join(', ') || '(none)'}`,
      `  evidence: toolCalls=${artifact.evidence.toolCallCount} errors=${artifact.evidence.errorCount}`,
    ];
    if (artifact.task.error) lines.push(`  error: ${artifact.task.error}`);
    if (artifact.knowledgeInjections.length > 0) {
      lines.push(`  knowledge: ${artifact.knowledgeInjections.map((entry) => entry.id).join(', ')}`);
    }
    return lines.join('\n');
  }

  ensureContractsFromStore(store?: RuntimeStore): void {
    for (const agent of this.agentManager.list()) {
      if (agent.orchestrationGraphId || agent.parentAgentId || store?.getState().acp.connections.has(agent.id)) {
        this.upsertContractForAgent(agent.id, store);
      }
    }
  }

  clear(): void {
    this.contracts.clear();
    this.artifacts.clear();
    this.pools.clear();
  }
}

export async function exportRemoteArtifactForAgent(
  registry: RemoteRunnerRegistry,
  agentId: string,
  store?: RuntimeStore,
  path?: string,
): Promise<{ artifact: RemoteExecutionArtifact; path: string } | null> {
  const artifact = registry.captureArtifactForAgent(agentId, store);
  if (!artifact) return null;
  return registry.exportArtifact(artifact.id, path);
}

export async function importRemoteArtifact(
  registry: RemoteRunnerRegistry,
  path: string,
): Promise<RemoteExecutionArtifact> {
  try {
    return await registry.importArtifact(path);
  } catch (error) {
    logger.warn('RemoteRunnerRegistry.importArtifact failed', { path, error: summarizeError(error) });
    throw error;
  }
}

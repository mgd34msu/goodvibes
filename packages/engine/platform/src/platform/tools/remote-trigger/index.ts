import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Tool } from '../../types/tools.js';
import { summarizeError } from '../../utils/error-display.js';
import { RemoteRunnerRegistry } from '../../runtime/remote/runner-registry.js';
import { REMOTE_TRIGGER_TOOL_SCHEMA, type RemoteTriggerToolInput } from './schema.js';

function summarizePool(pool: ReturnType<RemoteRunnerRegistry['listPools']>[number]) {
  return {
    id: pool.id,
    label: pool.label,
    runnerCount: pool.runnerIds.length,
    runnerIds: pool.runnerIds,
    updatedAt: pool.lastUpdatedAt,
  };
}

function summarizeContract(contract: ReturnType<RemoteRunnerRegistry['listContracts']>[number]) {
  return {
    id: contract.id,
    runnerId: contract.runnerId,
    label: contract.label,
    sourceTransport: contract.sourceTransport,
    trustClass: contract.trustClass,
    template: contract.template,
    transportState: contract.transport.state,
    toolCount: contract.capabilityCeiling.allowedTools.length,
    reviewMode: contract.capabilityCeiling.reviewMode,
    communicationLane: contract.capabilityCeiling.communicationLane,
  };
}

function summarizeArtifact(artifact: ReturnType<RemoteRunnerRegistry['listArtifacts']>[number]) {
  return {
    id: artifact.id,
    runnerId: artifact.runnerId,
    createdAt: artifact.createdAt,
    task: artifact.task.task,
    status: artifact.task.status,
    hasKnowledgeInjections: artifact.knowledgeInjections.length > 0,
  };
}

export interface RemoteToolOptions {
  /** When set, `import-artifact` reads only files inside this directory (the host's project). */
  readonly importRoot?: string | undefined;
}

/** The runner contract an artifact file carries, or undefined when the file does not hold one. */
async function contractInFile(path: string): Promise<{ runnerId: string } & Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resolve(path), 'utf-8'));
    const contract = (parsed as { runnerContract?: Record<string, unknown> } | null)?.runnerContract;
    return typeof contract?.runnerId === 'string' ? { ...contract, runnerId: contract.runnerId } : undefined;
  } catch {
    return undefined; // importArtifact reports unreadable or malformed files with its own message
  }
}

export function createRemoteTool(registry: RemoteRunnerRegistry, options: RemoteToolOptions = {}): Tool {
  return {
    definition: {
      name: 'remote',
      description: 'Manage remote runner pools, contracts, and portable artifacts.',
      parameters: REMOTE_TRIGGER_TOOL_SCHEMA.parameters,
      sideEffects: ['workflow', 'state', 'read_fs'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as RemoteTriggerToolInput;
      const view = input.view ?? 'summary';

      if (input.mode === 'create-pool') {
        if (!input.poolId) return { success: false, error: 'create-pool requires poolId.' };
        const known = registry.getPool(input.poolId);
        if (known) {
          return { success: false, error: `Pool ${input.poolId} already exists (label "${known.label}", ${known.runnerIds.length} runner(s)). Nothing was changed. Use assign to add runners to it.` };
        }
        const pool = registry.createPool({ id: input.poolId, label: input.label });
        return { success: true, output: JSON.stringify(pool) };
      }

      if (input.mode === 'pools') {
        const pools = registry.listPools();
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: pools.length,
            pools: view === 'full' ? pools : pools.map(summarizePool),
          }),
        };
      }

      if (input.mode === 'assign') {
        if (!input.poolId || !input.runnerId) return { success: false, error: 'assign requires poolId and runnerId.' };
        const target = registry.getPool(input.poolId);
        if (!target) {
          const known = registry.listPools().map((entry) => entry.id);
          return { success: false, error: `Unknown pool: ${input.poolId}. Nothing was assigned. Create it with create-pool first${known.length ? `, or use one of: ${known.join(', ')}` : ''}.` };
        }
        if (!registry.listContracts().some((contract) => contract.runnerId === input.runnerId)) {
          return { success: false, error: `Unknown runner: ${input.runnerId}. Nothing was assigned. Use mode=contracts to see the runners that can be assigned.` };
        }
        const pool = registry.assignRunnerToPool(input.poolId, input.runnerId);
        if (!pool) return { success: false, error: `Pool ${input.poolId} is full (maxRunners ${target.maxRunners ?? 'unset'}); ${input.runnerId} was not assigned. Unassign a runner first or use another pool.` };
        return { success: true, output: JSON.stringify(pool) };
      }

      if (input.mode === 'unassign') {
        if (!input.poolId || !input.runnerId) return { success: false, error: 'unassign requires poolId and runnerId.' };
        const pool = registry.removeRunnerFromPool(input.poolId, input.runnerId);
        if (!pool) return { success: false, error: `Unknown pool: ${input.poolId}` };
        return { success: true, output: JSON.stringify(pool) };
      }

      if (input.mode === 'contracts') {
        const contracts = registry.listContracts();
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: contracts.length,
            contracts: view === 'full' ? contracts : contracts.map(summarizeContract),
          }),
        };
      }

      if (input.mode === 'artifacts') {
        const artifacts = registry.listArtifacts();
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: artifacts.length,
            artifacts: view === 'full' ? artifacts : artifacts.map(summarizeArtifact),
          }),
        };
      }

      if (input.mode === 'review') {
        if (!input.artifactId) return { success: false, error: 'review requires artifactId.' };
        const summary = registry.buildReviewSummary(input.artifactId);
        if (!summary) return { success: false, error: `Unknown artifact: ${input.artifactId}` };
        return { success: true, output: summary };
      }

      if (input.mode === 'import-artifact') {
        if (!input.path) return { success: false, error: 'import-artifact requires path.' };
        if (options.importRoot !== undefined) {
          const rel = relative(resolve(options.importRoot), resolve(input.path));
          if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
            return { success: false, error: `import-artifact reads only files inside the project (${resolve(options.importRoot)}); ${resolve(input.path)} is outside it. Nothing was imported.` };
          }
        }
        // An import installs the file's runner contract, so it may add a runner but never replace one that is registered.
        const incoming = await contractInFile(input.path);
        const current = incoming ? registry.listContracts().find((contract) => contract.runnerId === incoming.runnerId) : undefined;
        // Compared as JSON so optional fields the registry leaves undefined match a file that omits them.
        if (incoming && current && !isDeepStrictEqual(JSON.parse(JSON.stringify(current)), JSON.parse(JSON.stringify(incoming)))) {
          return { success: false, error: `Runner ${incoming.runnerId} already has a contract, and the file carries a different one (trust class ${current.trustClass}, workspace, transport, template or pool may differ). Nothing was imported; a registered contract is not replaced by a file.` };
        }
        try {
          const artifact = await registry.importArtifact(input.path);
          return { success: true, output: JSON.stringify(artifact) };
        } catch (error) {
          return { success: false, error: summarizeError(error) };
        }
      }

      return { success: false, error: `Unknown mode: ${input.mode}` };
    },
  };
}

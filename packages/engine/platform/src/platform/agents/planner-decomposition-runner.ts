import { getContractInputAuthority, assertContractInputAuthority } from '../contract/input-authority.js';
import { getContractActionSource, getContractActionPort, hasContractPlanConsumer } from '../tools/agent/contract-binding.js';
/**
 * Production `DecompositionRunner` backed by the real `AgentManager`.
 *
 * This is the concrete driver that spawns a bounded, READ-ONLY `planner`
 * agent through the existing agents machinery and awaits its completion. It
 * lives in the agents layer (not `core`) precisely so `core/plan-decomposition.ts`
 * can stay free of any agent-machinery import and be unit-tested against a
 * stubbed runner. The planning agent it spawns is an ordinary `AgentManager`
 * agent, so it surfaces in the fleet like any other and honours kill/steer;
 * an external kill lands here as a `'cancelled'` result → heuristic fallback.
 *
 * Completion is the agent's own `join`, so the result is read the moment the
 * run settles. The bounds are checked on a slower tick while it runs:
 *   - token ceiling: `cancel()` once input+output tokens exceed the ceiling
 *   - turns: `cancel()` once `usage.turnCount` exceeds `maxTurns`
 * Both collapse to a `'cancelled'` run result (with a `detail`), which the
 * service turns into an honest `fallbackReason`. No clock stops a planner: it
 * ends when its run ends, a bound above is passed, or its caller stops it.
 * Without `join` the tick alone finds completion.
 */

import type { AgentManager } from '../tools/agent/manager.js';
import { builtinAgentTemplate } from './builtin-templates.js';
import type { AgentInput } from '../tools/agent/schema.js';
import { summarizeError } from '../utils/error-display.js';
import { spendingName } from '../runtime/cost/model-usage.js';
import type {
  DecompositionRunner,
  DecompositionRunnerRequest,
  DecompositionRunResult,
} from '../core/plan-decomposition.js';
import type { DecompositionAgentUsage } from '../core/plan-proposal.js';

/** The planner template's read-only tool set, passed with restrictTools for a hard cap. */
export const PLANNER_DECOMPOSITION_TOOLS: readonly string[] = builtinAgentTemplate('planner')!.tools;

export interface AgentManagerDecompositionRunnerDeps {
  agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'> & Partial<Pick<AgentManager, 'join'>>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** How often the token and turn bounds are checked, in ms (default 500 with `join`, 50 without). */
  pollIntervalMs?: number;
  /** Optional model registry key override for the planner agent. */
  model?: string | undefined;
  /** Optional provider override for the planner agent. */
  provider?: string | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function mapUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} | undefined): DecompositionAgentUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
}

/** The spawn's model fields: the request's route when it carries one, else the runner's configured model. */
function routeFields(request: DecompositionRunnerRequest, deps: AgentManagerDecompositionRunnerDeps): Partial<AgentInput> {
  const route = request.route;
  if (route === undefined) {
    return { ...(deps.model ? { model: deps.model } : {}), ...(deps.provider ? { provider: deps.provider } : {}) };
  }
  return {
    model: route.model,
    provider: route.provider,
    ...(route.fallbackModels ? { fallbackModels: [...route.fallbackModels] } : {}),
    ...(route.routing ? { routing: route.routing } : {}),
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
  };
}

export function createAgentManagerDecompositionRunner(
  deps: AgentManagerDecompositionRunnerDeps,
): DecompositionRunner {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? (deps.agentManager.join ? 500 : 50);

  return {
    async run(request: DecompositionRunnerRequest): Promise<DecompositionRunResult> {
      const start = now();
      if (request.signal?.aborted) return { status: 'cancelled', output: '', elapsedMs: 0, detail: 'stopped before planner admission' };
      const onStarted = request.onStarted;
      const join = deps.agentManager.join?.bind(deps.agentManager);
      if (onStarted && !join) return { status: 'failed', output: '', elapsedMs: now() - start,
        detail: 'Planner start notification requires joinable agent execution' };

      const spawnInput: AgentInput = {
        mode: 'spawn',
        task: request.userPrompt,
        template: 'planner',
        workingDirectory: request.workingDir,
        tools: [...PLANNER_DECOMPOSITION_TOOLS],
        restrictTools: true,
        executionIntent: { filesystemPolicy: 'read-only', networkPolicy: 'deny', riskClass: 'safe' },
        reviewMode: 'none',
        outsideContract: true,
        systemPromptAddendum: request.systemPrompt,
        ...routeFields(request, deps),
      };
      // Its spending is the work's it plans (Money, Spending): the owner's source, else the work by what was asked.
      const owner = request.forAgentId ? deps.agentManager.getStatus(request.forAgentId) : null;
      const spendingSource = owner?.spendingSource ?? (owner ? `work "${spendingName(owner.task)}"` : undefined);
      if (spendingSource) spawnInput.spendingSource = spendingSource;

      let agentId: string;
      try {
        const authority = getContractInputAuthority(request);
        const autonomousSource = getContractActionSource(request);
        if (authority) await assertContractInputAuthority(authority, request.workingDir, request.signal);
        request.signal?.throwIfAborted();
        autonomousSource?.();
        const sourceBinding = autonomousSource ? { autonomousSource, autonomousPort: getContractActionPort(request), ...(authority ? { inputReadAuthority: authority } : {}) }
          : authority ? { inputReadAuthority: authority } : undefined;
        const binding = hasContractPlanConsumer(request)
          ? { ...sourceBinding, proposalConsumer: 'contract-plan' as const, autonomousSignal: request.signal } : sourceBinding;
        const record = deps.agentManager.spawn(spawnInput, binding);
        agentId = record.id;
      } catch (err) {
        return { status: 'failed', output: '', elapsedMs: now() - start, detail: summarizeError(err) };
      }

      if (onStarted && join) {
        try {
          await onStarted(agentId);
        } catch (error) {
          // A failed ownership/checkpoint handoff must not leave the admitted
          // planner running. Terminal record status can precede async cleanup.
          deps.agentManager.cancel(agentId, 'kill');
          await join(agentId);
          return { status: 'failed', output: '', elapsedMs: now() - start, detail: summarizeError(error), agentId };
        }
      }

      let stopDetail: string | undefined;
      // Settles when the run does, or when the caller stops it, so neither waits out a tick.
      const woken = Promise.race([
        ...(join ? [join(agentId).then(() => undefined, () => undefined)] : []),
        ...(request.signal ? [new Promise<void>((resolve) => {
          if (request.signal!.aborted) resolve();
          else request.signal!.addEventListener('abort', () => resolve(), { once: true });
        })] : []),
      ]);
      let wokenSettled = false;
      void woken.then(() => { wokenSettled = true; });

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const cur = deps.agentManager.getStatus(agentId);
        if (!cur) {
          return { status: 'failed', output: '', elapsedMs: now() - start, detail: 'agent record disappeared', agentId };
        }
        if (cur.status === 'completed' || cur.status === 'failed' || cur.status === 'cancelled') break;

        const tokens = (cur.usage?.inputTokens ?? 0) + (cur.usage?.outputTokens ?? 0);
        if (request.bounds.tokenCeiling > 0 && tokens > request.bounds.tokenCeiling) {
          stopDetail = `token ceiling exceeded (${tokens} > ${request.bounds.tokenCeiling})`;
          deps.agentManager.cancel(agentId, 'kill');
          break;
        }
        if (request.bounds.maxTurns > 0 && (cur.usage?.turnCount ?? 0) > request.bounds.maxTurns) {
          stopDetail = `max turns exceeded (${request.bounds.maxTurns})`;
          deps.agentManager.cancel(agentId, 'kill');
          break;
        }
        if (request.signal?.aborted === true) {
          stopDetail = 'stopped by its caller';
          deps.agentManager.cancel(agentId, 'kill');
          break;
        }
        const tick = sleep(pollIntervalMs);
        // Once woken has settled it is only a tick: a status that lags its join must not spin this loop.
        await (wokenSettled ? tick : Promise.race([tick, woken]));
      }

      const final = deps.agentManager.getStatus(agentId);
      if (!final) {
        return { status: 'failed', output: '', elapsedMs: now() - start, detail: 'agent record disappeared', agentId };
      }
      const elapsedMs = (final.completedAt ?? now()) - start;
      const usage = mapUsage(final.usage);
      const output = final.fullOutput ?? '';

      if (final.status === 'completed') {
        return { status: 'completed', output, ...(usage ? { usage } : {}), elapsedMs, agentId };
      }
      if (final.status === 'cancelled') {
        return { status: 'cancelled', output, ...(usage ? { usage } : {}), elapsedMs, ...(stopDetail ? { detail: stopDetail } : {}), agentId };
      }
      return { status: 'failed', output, ...(usage ? { usage } : {}), elapsedMs, ...(final.error ? { detail: final.error } : {}), agentId };
    },
  };
}

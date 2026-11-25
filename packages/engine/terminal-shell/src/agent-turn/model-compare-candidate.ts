import { assertCurrentToolEffect, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import type { ToolExecuteOptions } from '@goodvibes/engine/platform/platform/tools';
import { runCandidate, listSelectableModels, parseArtifactCandidate } from './model-compare-run.js';
import { type AgentModelCompareToolDeps, type CompareCandidateResult, type ResolvedCompareModel } from './model-compare-types.js';
import { assertComparisonCandidateSource, createComparisonCandidateProjector } from './model-compare-candidate-input.js';

const NAME = 'agent_model_compare_candidate';
let sequence = 0;

/** Concrete metered requests are admitted with their complete transmitted arguments. */
export function registerComparisonCandidate(registry: ToolRegistry, deps: AgentModelCompareToolDeps): void {
  if (registry.has(NAME)) return;
  const candidate: Tool = {
    definition: { name: NAME, description: 'Run one metered blind-comparison candidate using an exact model and bounded output.', sideEffects: ['network'], concurrency: 'parallel', parameters: {
      type: 'object', properties: {
        registryKey: { type: 'string', description: 'The model\'s registry key; with modelId and providerId it must name a model that can still be selected.' },
        modelId: { type: 'string', description: 'The exact model id to run.' },
        providerId: { type: 'string', description: 'The provider that serves the model.' },
        blindId: { type: 'string', description: 'The label this candidate\'s answer is shown under in the blind comparison.' },
        prompt: { type: 'string', description: 'The prompt every candidate of the comparison is sent.' },
        systemPrompt: { type: 'string', description: 'The system prompt every candidate of the comparison is sent.' },
        maxTokens: { type: 'integer', minimum: 0, description: 'The most output tokens the candidate may produce.' },
        metered: { type: 'boolean', const: true, description: 'Must be true: the call is a paid model request.' },
        comparisonRequest: { type: 'object', additionalProperties: true, description: 'The comparison request this candidate belongs to, checked against the screening.' },
        screeningId: { type: 'string', description: 'The screening agent_model_compare mode "run" made of the request; a candidate without a current one is held.' },
      }, required: ['registryKey', 'modelId', 'providerId', 'blindId', 'prompt', 'systemPrompt', 'maxTokens', 'metered', 'comparisonRequest', 'screeningId'], additionalProperties: false,
    } },
    async execute(args, options) {
      const assertSend = () => { options?.signal?.throwIfAborted(); assertComparisonCandidateSource(args); if (!assertCurrentToolEffect(args, options, 'send')) throw new Error('Metered comparison requires current recorded send admission.'); };
      try {
        assertSend();
        const { registryKey, modelId, providerId, blindId, prompt, systemPrompt, maxTokens } = args;
        if (typeof registryKey !== 'string' || typeof modelId !== 'string' || typeof providerId !== 'string' || typeof blindId !== 'string'
          || typeof prompt !== 'string' || typeof systemPrompt !== 'string' || typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens)
          || maxTokens < 0 || args.metered !== true) {
          return { success: false, error: 'Invalid comparison request.' };
        }
        const models = await listSelectableModels(deps.modelCatalog);
        assertSend();
        const model = models.find(item => item.registryKey === registryKey && item.modelId === modelId && item.providerId === providerId);
        if (!model) return { success: false, error: 'Comparison model is no longer selectable.' };
        const result = await runCandidate(deps, model, blindId, prompt, systemPrompt, maxTokens, assertSend, options?.signal);
        assertSend();
        return { success: true, output: JSON.stringify(result) };
      } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Comparison candidate was held.' }; }
    },
  };
  registry.register(candidate, { inputProjection: createComparisonCandidateProjector(registry, deps) });
}

export async function runAdmittedComparisonCandidate(registry: ToolRegistry | undefined, options: ToolExecuteOptions | undefined,
  model: ResolvedCompareModel, blindId: string, prompt: string, systemPrompt: string, maxTokens: number, assertCurrent: () => void,
  comparisonRequest: Record<string, unknown>, screeningId: string,
  dispatch?: AgentModelCompareToolDeps['dispatchCandidate']): Promise<CompareCandidateResult> {
  if (!registry) throw new Error('Metered comparison requires its owning tool registry.');
  const args = {
    registryKey: model.registryKey, modelId: model.modelId, providerId: model.providerId, blindId, prompt, systemPrompt, maxTokens, metered: true,
    comparisonRequest, screeningId,
  };
  const result = dispatch
    ? await (assertCurrent(), dispatch(NAME, args))
    : await registry.executeNested(`comparison-candidate-${++sequence}`, NAME, args, options, { assertCurrent, signal: options?.signal });
  if (!result.success || typeof result.output !== 'string') throw new Error(result.error || 'Comparison candidate was not admitted.');
  const parsed: unknown = JSON.parse(result.output);
  const candidate = parseArtifactCandidate(parsed, 0);
  if (!candidate || candidate.blindId !== blindId || candidate.model.registryKey !== model.registryKey
    || candidate.model.modelId !== model.modelId || candidate.model.providerId !== model.providerId) throw new Error('Comparison candidate result does not match its exact request.');
  return candidate;
}

/**
 * model-compare-runner.ts, the daemon's runner for model comparisons
 * (capabilities/builtin/compare.ts): one prompt sent to two to four models
 * with their names hidden, the answers kept as a review artifact, and a
 * judgment, a model decision, a report or a reviewer handoff saved from it.
 *
 * Every act is one call of the `agent_model_compare` tool (model-compare-tool.ts),
 * run here in the daemon on its provider stack and its artifact store, under its
 * permission gate as the owner's confirmed act (a deny rule still refuses), for
 * whoever asked: the terminal app, the Agent, the web UI, a model, an outside
 * agent or a script. Switching to a winner changes the daemon's default model,
 * the one every conversation that has not chosen its own uses. Each saved
 * artifact is announced as LIST_CHANGED `artifacts`.
 *
 * The person who pressed a control reads the result in his own words
 * (model-compare-person.ts); a model or another agent reads the tool's text,
 * which names the ids and the next calls, and everyone gets what was saved as
 * data.
 */
import { CapabilityRefusal, type ActionValues, type CapabilityCaller, type CapabilityResult, type ModelComparisonRunner } from '@goodvibes/engine/platform/platform/capabilities';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import { noteListChanged } from '@goodvibes/engine/platform/platform/runtime/emitters';
import { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { registerAgentModelCompareTool } from './model-compare-tool.js';
import type { AgentModelCompareModelCatalog, AgentModelCompareProviderRegistry } from './model-compare-types.js';
import { given, positiveNumber, splitWords } from './agent-store-common.js';
import { bindAgentResearchSourceOwner } from './protected-research-report.js';
import { createClassicProtectedSourceOwner } from '@goodvibes/engine/platform/platform/security/source-screening/classic-owner';
import { randomUUID } from 'node:crypto';
import { loadComparisonFromArtifact } from './model-compare-run.js';
import { comparisonWords, savedComparisons, savedComparisonsWords, savedComparisonWords, savedNowWords, winnersWords, withoutToolLines, type SavedComparisonEntry } from './model-compare-person.js';

const TOOL = 'agent_model_compare';

/** The task a local-model benchmark sets when no prompt is given. */
const BENCHMARK_PROMPT = 'Benchmark this local route on one practical task: 1. summarize the current project goal in five bullets, 2. identify one likely setup risk, 3. propose one next action with a command or route.';
const BENCHMARK_RUBRIC = 'Prefer fast first useful output, correct project context, concrete setup-risk identification, and one actionable next route or command.';

export interface ModelComparisonRunnerDeps {
  /** The daemon's models: what can be compared, and the default model. */
  readonly modelCatalog: AgentModelCompareModelCatalog;
  /** The daemon's providers, which each answer is asked of. */
  readonly providerRegistry: AgentModelCompareProviderRegistry;
  /** The daemon's artifact store, which comparisons, judgments, reports and handoffs are kept in. */
  readonly artifactStore: ArtifactStore;
  /** The daemon's permission gate: the tool calls run under it as the owner's confirmed act. */
  readonly permissionManager: NonNullable<ConstructorParameters<typeof ToolRegistry>[0]>;
  /** The daemon's settings: the default model a winner becomes. */
  readonly config: { get(key: 'provider.model'): unknown; set(key: 'provider.model', value: string): void };
}

/** The arguments of a comparison run, from a capability's values. */
function runArgs(values: ActionValues, prompt: string, rubric: string, tag: string, task: string): Record<string, unknown> {
  const models = splitWords(values.models);
  const count = positiveNumber(values.count);
  const maxTokens = positiveNumber(values.maxTokens);
  return {
    mode: 'run', prompt,
    ...(values.source ? { artifactId: values.source } : {}),
    ...(models.length > 0 ? { modelRefs: models } : count ? { candidateCount: count } : {}),
    ...(rubric ? { rubric } : {}), ...(values.system ? { systemPrompt: values.system } : {}), ...(maxTokens ? { maxTokens } : {}),
    ...(tag ? { benchmarkKind: tag } : {}), ...(task ? { taskType: task } : {}), ...(values.document ? { documentId: values.document } : {}),
    reveal: values.reveal === 'yes', confirm: true, explicitUserRequest: `Compare models on: ${prompt.slice(0, 200)}`,
  };
}

/** Each capability as the tool call it is, with the words the owner's request is recorded in; `saves` when it keeps an artifact. */
const ACTS: Readonly<Record<string, (values: ActionValues) => { readonly args: Record<string, unknown>; readonly what: string; readonly saves: boolean }>> = {
  'compare.review': (values) => {
    const related = splitWords(values.related);
    const previewBytes = positiveNumber(values.bytes);
    return {
      args: {
        mode: values.view === 'side-by-side' ? 'sideBySide' : 'review', ...(values.comparison ? { artifactId: values.comparison } : {}),
        ...(related.length > 0 ? { relatedArtifactIds: related } : {}), ...(previewBytes ? { previewBytes } : {}), reveal: values.reveal === 'yes',
      },
      what: 'show model comparisons', saves: false,
    };
  },
  'compare.run': (values) => ({ args: runArgs(values, values.prompt ?? '', values.rubric ?? '', values.tag ?? '', values.task ?? ''), what: 'compare models', saves: true }),
  'compare.benchmark': (values) => ({ args: runArgs(values, values.prompt || BENCHMARK_PROMPT, BENCHMARK_RUBRIC, 'local-model-route', 'local-model-route'), what: 'benchmark local models', saves: true }),
  'compare.judge': (values) => ({
    args: {
      mode: 'judge', artifactId: values.comparison, winnerBlindId: values.winner, reasons: values.reasons, ...given(values, 'notes'),
      reveal: values.reveal === 'yes', confirm: true, explicitUserRequest: `Judge comparison ${values.comparison}: ${values.winner} won.`,
    },
    what: `judge comparison ${values.comparison}`, saves: true,
  }),
  'compare.apply': (values) => ({
    args: { mode: 'apply', artifactId: values.judgment, confirm: true, explicitUserRequest: `Switch to the winner of judgment ${values.judgment}.` },
    what: `switch to the winner of ${values.judgment}`, saves: true,
  }),
  'compare.record-decision': (values) => ({
    args: { mode: 'routeDecision', artifactId: values.judgment, decision: 'left-unchanged', confirm: true, explicitUserRequest: `Record that judgment ${values.judgment} left the model unchanged.` },
    what: `record a model decision for ${values.judgment}`, saves: true,
  }),
  'compare.export': (values) => {
    const related = splitWords(values.related);
    const as = values.as || 'report';
    return {
      args: {
        mode: as === 'handoff' ? 'handoff' : as === 'archive' ? 'handoffArchive' : 'export', artifactId: values.source,
        ...(related.length > 0 ? { relatedArtifactIds: related } : {}), reveal: values.reveal === 'yes', confirm: true, explicitUserRequest: `Save a ${as} from ${values.source}.`,
      },
      what: `save a ${as} from ${values.source}`, saves: true,
    };
  },
  'compare.diff-handoffs': (values) => ({
    args: { mode: 'handoffDiff', ...(values.left ? { leftArtifactId: values.left } : {}), ...(values.right ? { rightArtifactId: values.right } : {}), ...given(values, 'section') },
    what: 'compare reviewer handoffs', saves: false,
  }),
  'compare.analytics': (values) => {
    const limit = positiveNumber(values.limit);
    return {
      args: {
        mode: values.view === 'synthesis' ? 'synthesis' : 'analytics', ...(limit ? { limit } : {}),
        ...(values.tag ? { benchmarkKind: values.tag } : {}), ...(values.task ? { taskType: values.task } : {}), ...(values.document ? { documentId: values.document } : {}),
        includeReasons: values.reasons !== 'no',
      },
      what: 'see comparison judgments', saves: false,
    };
  },
};

export function createModelComparisonRunner(deps: ModelComparisonRunnerDeps): ModelComparisonRunner {
  const registry = new ToolRegistry(deps.permissionManager);
  // The prompt every candidate is sent is screened for private text first, by code on this machine (nothing sent
  // anywhere), as the Agent's own comparisons are; a candidate is never sent text the screening held.
  const lifetime = new AbortController();
  bindAgentResearchSourceOwner(registry, createClassicProtectedSourceOwner(Object.freeze({
    ownerId: `daemon-model-compare-${randomUUID()}`, revision: randomUUID(), signal: lifetime.signal, assertCurrent: () => lifetime.signal.throwIfAborted(),
  })));
  registerAgentModelCompareTool(registry, {
    modelCatalog: deps.modelCatalog,
    providerRegistry: deps.providerRegistry,
    artifactStore: deps.artifactStore,
    // The person asked for the comparison, so each candidate's call is his confirmed act too: admitted under the same gate
    // (a deny rule or plan mode still refuses), never asked again per model.
    dispatchCandidate: (name, args) => registry.executeOwnerConfirmed(`capability-${name}-${randomUUID()}`, name, { ...args }, {
      goal: 'The owner asked for this: compare models on one prompt.',
      criteria: [`Run ${name} with exactly the values the comparison gave.`],
    }),
    // The winner becomes the daemon's default model: every conversation that has not chosen its own uses it.
    applyModelRoute: (registryKey) => {
      const previousModel = String(deps.config.get('provider.model') ?? '').trim();
      deps.config.set('provider.model', registryKey);
      if (deps.config.get('provider.model') !== registryKey) throw new Error('The default model could not be changed in the daemon\'s settings.');
      noteListChanged({ list: 'models', change: 'changed' });
      return { ...(previousModel ? { previousModel } : {}), selectedModel: registryKey };
    },
  });
  const store = deps.artifactStore;
  return {
    async run(id: string, values: ActionValues, caller: CapabilityCaller): Promise<CapabilityResult> {
      const act = ACTS[id];
      if (!act) throw new CapabilityRefusal(`${id} is not a model comparison act; nothing was done.`);
      const person = caller.personAsked === true;
      // The saved comparisons are a read of the daemon's own store: no tool call adds anything to it.
      if (id === 'compare.review' && !values.comparison) {
        const saved = savedComparisons(store);
        return { text: savedComparisonsWords(saved, !person), data: { saved } };
      }
      // One saved comparison, judgment, decision or report, read for the person who asked.
      if (id === 'compare.review' && person) {
        const entry = savedComparisons(store).find((saved) => saved.id === values.comparison);
        return { text: await savedComparisonWords(store, values.comparison!, values.reveal === 'yes'), data: { saved: entry ? [entry] : [] } };
      }
      const { args, what, saves } = act(values);
      const before = new Set(savedComparisons(store).map((entry) => entry.id));
      const modelBefore = String(deps.config.get('provider.model') ?? '').trim();
      const result = await registry.executeOwnerConfirmed(`capability-${TOOL}`, TOOL, { ...args }, {
        goal: `The owner asked for this: ${what}.`,
        criteria: [`Run ${TOOL} with exactly the values the owner gave.`],
      });
      if (!result.success) {
        const why = result.error ?? `${TOOL} did not succeed and gave no reason.`;
        throw new CapabilityRefusal(`Not done: ${person ? withoutToolLines(why) || why : why}`);
      }
      if (saves) noteListChanged({ list: 'artifacts', change: 'created' });
      const output = result.output?.trim() || `${what}: done.`;
      const made = savedComparisons(store).filter((entry) => !before.has(entry.id));
      const data = { saved: made };
      // A model or another agent reads the tool's own text: it names the ids and the next calls to make.
      if (!person) return { text: output, data };
      return { text: await personWords(id, values, made, output, modelBefore), data };
    },
  };

  /** What the person who pressed the control reads after the act, from what it saved. */
  async function personWords(id: string, values: ActionValues, made: readonly SavedComparisonEntry[], output: string, modelBefore: string): Promise<string> {
    const saved = (kind: SavedComparisonEntry['kind']) => made.find((entry) => entry.kind === kind);
    switch (id) {
      case 'compare.run':
      case 'compare.benchmark': {
        const entry = saved('comparison');
        const comparison = entry ? await loadComparisonFromArtifact(store, entry.id) : null;
        if (!comparison) return withoutToolLines(output);
        return comparisonWords(comparison, values.reveal === 'yes', id === 'compare.benchmark'
          ? `The models on this machine were given the same task, with their names hidden (kept with your comparisons):`
          : `Sent to ${comparison.candidates.length} models with their names hidden (kept with your comparisons):`);
      }
      case 'compare.judge': {
        const entry = saved('judgment');
        return entry ? savedComparisonWords(store, entry.id, true) : withoutToolLines(output);
      }
      case 'compare.apply': {
        const now = String(deps.config.get('provider.model') ?? '').trim();
        const unsaved = /route decision receipt unavailable: (.*)/.exec(output)?.[1];
        return [
          `The default model is now ${now}${modelBefore && modelBefore !== now ? ` (it was ${modelBefore})` : ''}: every conversation that has not chosen its own model uses it from its next message, in every program.`,
          saved('decision') ? 'The decision is kept with your comparisons.' : `The decision could not be kept: ${unsaved ?? 'it was not saved.'}`,
        ].join(' ');
      }
      case 'compare.record-decision': {
        const entry = saved('decision');
        return entry ? savedComparisonWords(store, entry.id, true) : withoutToolLines(output);
      }
      case 'compare.export':
        return savedNowWords(made[0]);
      case 'compare.analytics':
        return values.view === 'synthesis' ? withoutToolLines(output) : winnersWords(store, positiveNumber(values.limit) ?? 20);
      case 'compare.diff-handoffs': {
        if (values.left && values.right) return withoutToolLines(output);
        const handoffs = savedComparisons(store).filter((entry) => entry.kind === 'handoff').length;
        return handoffs < 2 ? `There ${handoffs === 1 ? 'is one reviewer handoff' : 'are no reviewer handoffs'} yet: two are needed to see what changed between them.`
          : `${handoffs} reviewer handoffs are saved: choose two to see what changed between them.`;
      }
      default:
        return withoutToolLines(output);
    }
  }
}

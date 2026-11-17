/**
 * Counting fakes for the two ports that would leave the machine: the decision
 * model (JudgmentPort) and the conversation model (LLMProvider). Each returns a
 * plausible answer at once and counts requests and the JSON size of what would
 * have been sent.
 *
 * Decision answers come from the same readings the engine tests use
 * (test/_helpers), routed the way test/_helpers/hosted-session-readings.ts
 * routes them. A decision none of them claims gets a neutral answer (first
 * choice, "no", lowest score) and is counted under `unrouted`.
 */
import { withDecisionLog, type JudgmentPort, type JudgmentRequest, type Question, type Questions, type SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { toolReadingsPort } from '../../test/_helpers/tool-readings.ts';
import { coreReadingsPort } from '../../test/_helpers/core-readings.ts';
import { compactionQualityPort } from '../../test/_helpers/compaction-quality.ts';
import { forgetGateReadings, READ_ONLY, type GateReadingTable } from '../../test/_helpers/gate-readings.ts';
import type { ChatRequest, ChatResponse, LLMProvider } from '../../platform/src/platform/providers/interface.ts';
import type { ModelDefinition } from '../../platform/src/platform/providers/registry.ts';

export interface PortCounts {
  requests: number;
  bytes: number;
  /** Requests per decision site/battery, for the notes. */
  bySite: Record<string, number>;
  /** Requests no fixture claimed (answered neutrally). */
  unrouted: Record<string, number>;
}

export const decisionCounts: PortCounts = { requests: 0, bytes: 0, bySite: {}, unrouted: {} };
/** Conversation-model requests; `tools` and `toolBytes` are the tool definitions those requests carried. */
export const providerCounts = { requests: 0, bytes: 0, tools: 0, toolBytes: 0, lastTools: [] as Array<{ readonly name: string; readonly bytes: number; readonly parameters: boolean }> };

export function resetFakeCounts(): void {
  decisionCounts.requests = 0; decisionCounts.bytes = 0; decisionCounts.bySite = {}; decisionCounts.unrouted = {};
  providerCounts.requests = 0; providerCounts.bytes = 0; providerCounts.tools = 0; providerCounts.toolBytes = 0; providerCounts.lastTools = [];
}

function sizeOf(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value, (key, inner: unknown) => key === 'signal' || inner instanceof AbortSignal ? undefined : inner) ?? ''); }
  catch { return 0; }
}

function neutral(question: Question): unknown {
  if (question.type === 'choice') return choiceAnswer(question, Object.keys(question.criteria)[0]!, 0.9);
  if (question.type === 'score') return scoreAnswer(question, 0, 0.9);
  return noulAnswer(0.03);
}

/** Extra fixtures a scenario may add: decided before the shared routing. */
export type ExtraRoute = (request: JudgmentRequest<Questions>) => JudgmentPort | undefined;

/** The answering port, without counting or logging. */
export function readingsPort(options: { readonly gate?: GateReadingTable; readonly extra?: ExtraRoute } = {}): JudgmentPort {
  const intake = fakePort((name, question) => name === 'route' ? choiceAnswer(question, 'converse', 0.97) : neutral(question));
  const admission = fakePort((name, question) => name === 'disposition' ? choiceAnswer(question, 'act', 0.97) : neutral(question));
  // The completion request also carries the routing question when the evidence is small; the measured turns are tasks.
  const completion = fakePort((name) => noulAnswer(name === 'completion_required' ? 0.99 : 0.01));
  const applicability = fakePort((name, question) => name === 'completion_required' ? noulAnswer(0.99) : neutral(question));
  const compaction = compactionQualityPort();
  const core = coreReadingsPort({ intent: 'chat', needsPlan: false, strategy: 'single' });
  const tools = toolReadingsPort([], options.gate ?? [['"tool":"read"', READ_ONLY], ['"tool":"find"', READ_ONLY]]);
  const fallback = fakePort((_name, question) => neutral(question));
  const included = fakePort((_name, question) => question.type === 'noul' ? noulAnswer(0.97) : neutral(question));
  // Knowledge relevance: the measured searches ask about deploying the service; a source titled for it is useful evidence.
  const relevant = fakePort((_name, question, state) => question.type === 'noul'
    ? noulAnswer(/deploying the service/i.test(String((state as { candidate?: { title?: unknown } } | undefined)?.candidate?.title ?? '')) ? 0.97 : 0.03)
    : neutral(question));
  return {
    model: intake.port.model,
    ask(request) {
      const extra = options.extra?.(request as JudgmentRequest<Questions>);
      if (extra) return extra.ask(request);
      const battery = request.context?.battery;
      if (request.context?.site === 'engine.gate.autonomous-tool') return admission.port.ask(request);
      if (battery === 'engine.core.completion-applicability') return applicability.port.ask(request);
      if (battery === 'engine.core.execution-strategy') return core.port.ask(request);
      if (['engine.core.response-completion', 'engine.core.execution-assurance', 'engine.core.delegation-consolidation', 'engine.agents.brief-fidelity'].includes(battery ?? '')) return completion.port.ask(request);
      if (['engine.compaction.retention', 'engine.compaction.fidelity'].includes(battery ?? '')) return compaction.port.ask(request);
      if (battery === 'contract.request-route') return intake.port.ask(request);
      // Knowledge scope: every measured source is ordinary content that belongs in the view.
      if (battery === 'engine.knowledge.scope-selection') return included.port.ask(request);
    if (battery === 'engine.knowledge.answer-evidence-relevance') return relevant.port.ask(request);
      if (battery?.startsWith('engine.gate.') || battery?.startsWith('engine.tools.')) return tools.port.ask(request);
      const key = battery ?? request.context?.site ?? '(unnamed)';
      decisionCounts.unrouted[key] = (decisionCounts.unrouted[key] ?? 0) + 1;
      return fallback.port.ask(request);
    },
  };
}

/** Wrap a port so every request is counted with the JSON size of what it would send. */
export function countingPort(inner: JudgmentPort): JudgmentPort {
  return {
    get model() { return inner.model; },
    async ask(request) {
      request.signal?.throwIfAborted();
      request.beforeAttempt?.();
      decisionCounts.requests++;
      decisionCounts.bytes += sizeOf({ model: request.model, questions: request.questions, state: request.state, context: request.context });
      const site = request.context?.battery ?? request.context?.site ?? '(unnamed)';
      decisionCounts.bySite[site] = (decisionCounts.bySite[site] ?? 0) + 1;
      return inner.ask(request);
    },
  };
}

/**
 * Install the counting fake as the process's decision port. With a decision
 * log it records like the product's composeJudgment port does
 * (runtime/judgment-services.ts), so the log's disk writes are measured too.
 */
export function installCountingJudgment(options: { readonly log?: SqliteDecisionLog; readonly gate?: GateReadingTable; readonly extra?: ExtraRoute } = {}): { readonly port: JudgmentPort; restore(): void } {
  const counted = countingPort(readingsPort(options));
  const port = options.log ? withDecisionLog(counted, options.log) : counted;
  forgetGateReadings();
  const previous = installJudgmentPort(port);
  return { port, restore() { installJudgmentPort(previous); forgetGateReadings(); } };
}

export const PROVIDER = 'measure';
export const MODEL = 'measure-1';

export function measureModel(): ModelDefinition {
  return {
    id: MODEL, provider: PROVIDER, registryKey: `${PROVIDER}:${MODEL}`, displayName: MODEL, description: 'counting fake',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
    contextWindow: 200_000, selectable: true, tier: 'standard',
  } as unknown as ModelDefinition;
}

export function textAnswer(content: string): ChatResponse {
  return { content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' } as ChatResponse;
}

export function toolCallAnswer(calls: ReadonlyArray<{ id: string; name: string; arguments: Record<string, unknown> }>): ChatResponse {
  return { content: '', toolCalls: [...calls], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'tool_call' } as unknown as ChatResponse;
}

/** A provider that answers from `script` in order (then a plain answer), counting each request. */
export function countingProvider(script: ChatResponse[]): LLMProvider {
  return {
    name: PROVIDER,
    models: [MODEL],
    credentialAuthority: 'anonymous',
    modelSource: { kind: 'dated-static', asOf: '2026-01-01' },
    isConfigured: () => true,
    chat: async (request: ChatRequest): Promise<ChatResponse> => {
      providerCounts.requests++;
      providerCounts.bytes += sizeOf({ model: request.model, systemPrompt: request.systemPrompt, messages: request.messages, tools: request.tools });
      providerCounts.tools += request.tools?.length ?? 0;
      providerCounts.toolBytes += sizeOf(request.tools ?? []);
      providerCounts.lastTools = (request.tools ?? []).map((tool) => ({
        name: tool.name, bytes: sizeOf(tool),
        parameters: Object.keys((tool.parameters as { properties?: object } | undefined)?.properties ?? {}).length > 0,
      }));
      return script.shift() ?? textAnswer('Done.');
    },
  } as unknown as LLMProvider;
}

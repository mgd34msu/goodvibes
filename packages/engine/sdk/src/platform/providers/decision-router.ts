import { AsyncLocalStorage } from 'node:async_hooks';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { toJson, type JudgmentPort } from '@goodvibes-jev/judgment';
import { captureDecisionRouterSettings, type DecisionRouterTarget } from '../config/decision-router-settings.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { decisionRouterCategory } from '../routing/batteries/decision-router.js';
import type { ResolvedReasoningEffort } from './reasoning-effort.js';
import { resolveEffortForModelSurface } from './reasoning-effort-surface.js';
import type { ChatRequest, ChatResponse, LLMProvider, ProviderModelSource } from './interface.js';
import type { ModelDefinition } from './registry-types.js';
import { buildDecisionRoutingPreview, rememberRoutingTask, routingMessageText, type DecisionRoutingContext } from './decision-router-context.js';

const routingScope = new AsyncLocalStorage<boolean>();

export interface DecisionRouterRouteInfo {
  readonly category: string;
  readonly resolvedCategory: string;
  readonly provider: string;
  readonly model: string;
  readonly requestedEffort?: string;
  readonly effort?: string;
  readonly effortNote?: string;
  readonly fallback?: 'empty-category' | 'uncertain' | 'classic';
  readonly provenance?: 'decision' | 'classic';
  readonly expandedContext: boolean;
  readonly decisionIds: readonly string[];
  readonly decisionModels: readonly string[];
}
export interface PreparedDecisionRoute {
  readonly provider: LLMProvider;
  readonly model: ModelDefinition;
  readonly effort: ResolvedReasoningEffort;
  readonly info: DecisionRouterRouteInfo;
  readonly assertCurrent: () => void;
}
export interface DecisionRouterPrepareInput {
  readonly messages: ChatRequest['messages'];
  readonly context?: DecisionRoutingContext;
  readonly signal?: AbortSignal;
  readonly beforeAttempt?: ChatRequest['beforeAttempt'];
  readonly assertCurrent?: () => void;
}
interface ResolvedTarget { readonly provider: LLMProvider; readonly model: ModelDefinition; }
export interface DecisionRouterProviderOptions {
  readonly settings: () => unknown;
  readonly resolveTarget: (target: DecisionRouterTarget) => ResolvedTarget;
  readonly capturePort?: () => { readonly port: JudgmentPort; readonly assertCurrent: () => void };
}

/** A virtual provider: classification is invoked only when this provider is selected. */
export class DecisionRouterProvider implements LLMProvider {
  readonly name = 'decision-router';
  readonly models = ['auto'];
  readonly modelSource: ProviderModelSource = { kind: 'dated-static', asOf: '2026-11-05' };
  readonly credentialAuthority = 'anonymous' as const;
  private readonly turns = new Map<string, { readonly result: Promise<PreparedDecisionRoute>; pending: boolean }>();
  private readonly tasks = new Map<string, string>();

  constructor(private readonly options: DecisionRouterProviderOptions) {}

  isConfigured(): boolean {
    try {
      const general = captureDecisionRouterSettings(this.options.settings()).categories['general']?.target;
      return general !== null && general !== undefined && this.options.resolveTarget(general).provider.isConfigured?.() !== false;
    } catch { return false; }
  }

  describeRuntime() {
    return {
      setup: { description: 'Opt-in request categorization over your configured model, provider and effort per category. Configure General first; empty categories use General. Decision backends use the separate judgment settings.' },
      models: { models: this.models },
    };
  }

  async prepare(input: DecisionRouterPrepareInput): Promise<PreparedDecisionRoute> {
    if (routingScope.getStore()) throw new Error('Nested Decision Router routes are forbidden.');
    input.signal?.throwIfAborted(); input.assertCurrent?.();
    const key = input.context ? JSON.stringify([input.context.sessionId ?? '', input.context.turnId]) : undefined;
    if (key !== undefined) {
      const previous = this.turns.get(key);
      if (previous) {
        const result = await previous.result;
        input.signal?.throwIfAborted(); input.assertCurrent?.(); result.assertCurrent();
        return result;
      }
      if (this.turns.size >= 256) {
        const expired = [...this.turns].find(([, entry]) => !entry.pending)?.[0];
        if (expired === undefined) throw new Error('Decision Router is busy; retry when another turn finishes.');
        this.turns.delete(expired);
      }
    }
    const result = decisionOrClassic(() => this.choose(input), () => this.classicGeneral(input));
    if (key !== undefined) {
      const entry = { result, pending: true }; this.turns.set(key, entry);
      void result.then(() => { entry.pending = false; }, () => { this.turns.delete(key); });
    }
    return result;
  }

  private classicGeneral(input: DecisionRouterPrepareInput): PreparedDecisionRoute {
    const settings = captureDecisionRouterSettings(this.options.settings());
    const target = settings.categories['general']?.target;
    if (!target) throw new Error('Configure the Decision Router General model before selecting this provider.');
    const resolved = this.options.resolveTarget(target);
    if (target.provider === this.name || resolved.provider.name === this.name) throw new Error('Decision Router cannot route to itself.');
    const current = () => { input.signal?.throwIfAborted(); input.assertCurrent?.(); };
    current();
    const effort = resolveEffortForModelSurface(target.effort, resolved.model);
    return { provider: resolved.provider, model: resolved.model, effort, assertCurrent: current,
      info: Object.freeze({ category: 'general', resolvedCategory: 'general', provider: resolved.provider.name,
        model: resolved.model.id, ...(target.effort === undefined ? {} : { requestedEffort: target.effort }),
        ...(effort.value === undefined ? {} : { effort: effort.value }), ...(effort.note === undefined ? {} : { effortNote: effort.note }),
        fallback: 'classic', provenance: 'classic', expandedContext: false, decisionIds: Object.freeze([]), decisionModels: Object.freeze([]) }),
    };
  }

  private async choose(input: DecisionRouterPrepareInput): Promise<PreparedDecisionRoute> {
    const settings = captureDecisionRouterSettings(this.options.settings());
    const general = settings.categories['general']?.target;
    if (!general) throw new Error('Configure the Decision Router General model before selecting this provider.');
    if (general.provider === this.name) throw new Error('Decision Router cannot route to itself.');
    const generalTarget = this.options.resolveTarget(general);
    if (generalTarget.provider.name === this.name) throw new Error('Decision Router cannot route to itself.');
    const callerCurrent = () => { input.signal?.throwIfAborted(); input.assertCurrent?.(); };
    callerCurrent();
    const captured = this.options.capturePort?.() ?? captureJudgmentPort(decisionRouterCategory.name);
    const temporaryOwner = new AbortController();
    const signal = input.signal ?? temporaryOwner.signal;
    const current = () => { callerCurrent(); captured.assertCurrent(); };
    const decisionIds: string[] = [], decisionModels: string[] = [];
    const inner = captured.port;
    const port: JudgmentPort = {
      model: inner.model,
      ...(inner.recorder === undefined ? {} : { recorder: inner.recorder }),
      async ask(request) {
        const result = await inner.ask(request);
        if (result.decisionId) decisionIds.push(result.decisionId);
        decisionModels.push(result.model);
        return result;
      },
    };
    const candidates = Object.entries(settings.categories).map(([id, category]) => ({ id, content: { category: id, description: category.description } }));
    const sessionId = input.context?.sessionId;
    const remembered = sessionId ? this.tasks.get(sessionId) : undefined;
    let expanded = false;
    try {
      const classify = async (expandedContext: boolean) => {
        const context = buildDecisionRoutingPreview(input.messages, input.context, remembered,
          expandedContext ? settings.expandedContextChars : settings.initialContextChars, expandedContext);
        assertJudgmentInput({ context, candidates });
        return decisionRouterCategory.select(port, toJson(context), candidates, { signal, site: decisionRouterCategory.name,
          beforeAttempt: current,
          ...(input.beforeAttempt === undefined ? {} : { beforeAsyncAttempt: input.beforeAttempt }),
        });
      };
      let selected = await classify(false); current();
      if (selected.outcome !== 'act' || selected.chosen === undefined) {
        expanded = true; selected = await classify(true); current();
      }
      const uncertain = selected.outcome !== 'act' || selected.chosen === undefined;
      const category = uncertain ? 'general' : selected.chosen ?? 'general';
      const configured = settings.categories[category];
      const target = configured?.target ?? general;
      const resolvedCategory = configured?.target ? category : 'general';
      const resolved = target === general ? generalTarget : this.options.resolveTarget(target);
      if (target.provider === this.name || resolved.provider.name === this.name) throw new Error('Decision Router cannot route to itself.');
      const effort = resolveEffortForModelSurface(target.effort, resolved.model);
      selected.recordAction(`Route ${category} to ${resolved.provider.name}:${resolved.model.id}`);
      if (sessionId && category && category !== 'lookup-navigation' && category !== 'general' && !uncertain) {
        const user = input.messages.findLast(message => message.role === 'user');
        const prompt = input.context?.prompt ?? (user ? routingMessageText(user) : '');
        if (this.tasks.size >= 128 && !this.tasks.has(sessionId)) {
          const oldest = this.tasks.keys().next().value;
          if (oldest !== undefined) this.tasks.delete(oldest);
        }
        this.tasks.set(sessionId, rememberRoutingTask(prompt));
      }
      return { provider: resolved.provider, model: resolved.model, effort, assertCurrent: callerCurrent,
        info: Object.freeze({ category: category, resolvedCategory,
          provider: resolved.provider.name, model: resolved.model.id,
          ...(target.effort === undefined ? {} : { requestedEffort: target.effort }),
          ...(effort.value === undefined ? {} : { effort: effort.value }),
          ...(effort.note === undefined ? {} : { effortNote: effort.note }),
          ...(uncertain ? { fallback: 'uncertain' as const } : !configured?.target ? { fallback: 'empty-category' as const } : {}),
          expandedContext: expanded, decisionIds: Object.freeze(decisionIds), decisionModels: Object.freeze(decisionModels),
        }),
      };
    } finally { temporaryOwner.abort(); }
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const owner = new AbortController();
    try {
      const prepared = await this.prepare({ messages: params.messages,
        ...(params.signal === undefined ? {} : { signal: params.signal }),
        ...(params.routingContext === undefined ? {} : { context: params.routingContext }),
        ...(params.beforeAttempt === undefined ? {} : { beforeAttempt: params.beforeAttempt }),
      });
      prepared.assertCurrent();
      const response = await chatWithDecisionRoute(prepared, { ...params, signal: params.signal ?? owner.signal, model: prepared.model.id,
        reasoningEffort: prepared.effort.value, reasoningEffortSpec: prepared.effort.spec,
        beforeAttempt: async () => { prepared.assertCurrent(); await params.beforeAttempt?.(); prepared.assertCurrent(); },
      });
      prepared.assertCurrent();
      return { ...response, decisionRoute: prepared.info };
    } finally { owner.abort(); }
  }
}

/** Resolve before normal context preflight so the answer model's actual limits and pricing apply. */
export async function prepareDecisionRouterTurn(provider: LLMProvider, input: DecisionRouterPrepareInput): Promise<PreparedDecisionRoute | undefined> {
  return provider instanceof DecisionRouterProvider ? provider.prepare(input) : undefined;
}

export function describeDecisionRoute(route: DecisionRouterRouteInfo): string {
  return `Decision Router: ${route.category}${route.resolvedCategory !== route.category ? ' → General' : ''} → ${route.provider} / ${route.model}`
    + (route.effort ? ` · effort ${route.effort}` : '') + (route.fallback === 'uncertain' ? ' · General after an uncertain classification' : '')
    + (route.fallback === 'classic' ? ' · Classic operation; no decision classification' : '')
    + (route.effortNote ? ` · ${route.effortNote}` : '');
}

/** Shared fence also covers indirect providers that might otherwise re-enter the virtual provider. */
export async function chatWithDecisionRoute(route: PreparedDecisionRoute, request: ChatRequest): Promise<ChatResponse> {
  if (routingScope.getStore()) throw new Error('Nested Decision Router routes are forbidden.');
  route.assertCurrent();
  return routingScope.run(true, async () => {
    const response = await route.provider.chat(request);
    route.assertCurrent();
    return { ...response, decisionRoute: route.info };
  });
}

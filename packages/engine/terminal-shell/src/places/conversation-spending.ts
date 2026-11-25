/**
 * conversation-spending.ts, what this conversation has used and cost, as the
 * program holding it keeps it, for the top of Money's Spending tab.
 *
 * The tracker is built once when the program starts and listens to the turn
 * and agent event feeds for the life of the conversation, so the turn history
 * and the agents' costs accumulate whether or not Money is ever opened. The
 * place reads it (`conversationSpendingSource`): one row for the conversation
 * (context, tokens, cost, the spending alert, the split with its agents), one
 * for its turns, one per agent it started. Both terminal programs build it the
 * same way. Nothing here waits on a clock: a running agent's tokens are read
 * again each time the list is read (on any change, and on the place's read-again
 * key).
 *
 * The spending alert is the daemon's setting `behavior.budgetAlertUsd`, read
 * from this program's copy of the daemon's settings.
 */
import type { AgentRecord } from '@goodvibes/engine/platform/platform/tools';
import {
  BUDGET_ALERT_USD_CONFIG_KEY,
  calcSessionCost,
  computeBudgetBreach,
  describePricingSource,
  isModelPriced,
  MODEL_PRICES_CONFIG_KEY,
  readBudgetAlertUsd,
  resolveSessionCost,
  type SessionPricing,
} from '@goodvibes/engine/platform/platform/providers';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { isConversationUsageAvailable } from '@goodvibes/engine/platform/platform/core';
import type { AgentEvent, TurnEvent } from '@goodvibes/engine/platform/events';
import { evaluateSessionMaintenance } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { SessionMemoryQuery, UiEventFeed, UiReadModel, UiSessionSnapshot } from '@goodvibes/engine/platform/platform/runtime/ui';
import type { PlaceProgramSource } from './place-host.js';
import type { PlaceDetailLine, PlaceItem } from './place-types.js';

/** Tokens one completed turn added. */
export interface UsageTurn {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Unix ms the turn completed. */
  readonly ts: number;
}

export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type UsageAgentStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** One spawned agent's tokens and cost. */
export interface UsageAgentEntry {
  readonly agentId: string;
  readonly task: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly status: UsageAgentStatus;
}

/** What the conversation cost, and where the price came from. */
export interface UsageCost {
  readonly usd: number;
  /** False when the model has no known price (the figure is then not a real zero). */
  readonly priced: boolean;
  /** "your price", "catalog price, as of …", or null. */
  readonly source: string | null;
}

export interface UsageTrackerDeps {
  readonly turnEvents: UiEventFeed<TurnEvent>;
  readonly agentEvents: UiEventFeed<AgentEvent>;
  /** Cumulative main-conversation usage (the orchestrator's counters). */
  readonly getUsage: () => UsageTotals & { readonly model?: string | undefined; readonly costUsd?: number | undefined };
  /** Tokens in the context window right now. */
  readonly getContextTokens: () => number;
  /** The current model's context window (0 when unknown). */
  readonly getContextWindow: () => number;
  /** The current model id (for pricing). */
  readonly getModelId: () => string;
  /** The current model as `provider:model`: the key a price of your own is set under (Money, Spending, "your price"). */
  readonly getModelKey?: (() => string) | undefined;
  /** What usage is priced with: the runtime's ProviderRegistry. */
  readonly pricing: SessionPricing;
  /** An agent's live record, for its usage and model. */
  readonly getAgentStatus?: ((agentId: string) => AgentRecord | null) | undefined;
  /** The fleet's priced total (every agent, chain and workflow), or null when nothing is priced. */
  readonly getFleetCost?: (() => number | null) | undefined;
  /** This program's settings, the daemon's (the spending alert) as its copy holds them; told when that copy changes. */
  readonly configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'subscribe'>>;
  readonly sessionMemoryStore?: SessionMemoryQuery | undefined;
  readonly sessionReadModel?: UiReadModel<UiSessionSnapshot> | undefined;
  readonly requestRender?: (() => void) | undefined;
}

/** The daemon's one spending alert (platform config-ownership.ts). */
const SPENDING_ALERT_KEY = BUDGET_ALERT_USD_CONFIG_KEY;

/** Turns kept in history. */
const MAX_TURNS = 100;
/** Agents kept in the cost ledger (oldest finished ones go first). */
const MAX_AGENTS = 200;

/**
 * What one model's answers in this conversation used and were charged at the time (from each answer's
 * LLM_RESPONSE_RECEIVED), so the conversation's cost can be priced again at today's price when a price changes.
 */
interface ModelSpend {
  readonly provider: string;
  readonly model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** What was added to the conversation's spent cost for these answers, in USD. */
  spentUsd: number;
}

interface MutableAgent {
  agentId: string;
  task: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  status: UsageAgentStatus;
}

export class UsageTracker {
  private readonly turnsList: UsageTurn[] = [];
  private readonly agentMap = new Map<string, MutableAgent>();
  private prevCumulative: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** True from a turn's submission until it ends; usage that moves outside one is a resume or rewind, not the turn's. */
  private turnOpen = false;
  /** The conversation's own turns (TURN_SUBMITTED), whose answers are this conversation's spending. */
  private readonly ownTurns = new Set<string>();
  /** This conversation's answers per model, as spent (ModelSpend). */
  private readonly spendByModel = new Map<string, ModelSpend>();
  private readonly unsubs: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: UsageTrackerDeps) {
    this.unsubs.push(deps.turnEvents.on('TURN_COMPLETED', () => { this.turnOpen = false; this.recordTurn(); }));
    this.unsubs.push(deps.turnEvents.on('TURN_CANCEL', () => { this.turnOpen = false; }));
    this.unsubs.push(deps.turnEvents.on('PREFLIGHT_FAIL', () => { this.turnOpen = false; }));
    this.unsubs.push(deps.turnEvents.on('TURN_ERROR', () => { this.turnOpen = false; }));
    this.unsubs.push(deps.turnEvents.on('TURN_SUBMITTED', (payload) => {
      // A resumed, rewound or imported conversation re-hydrates the orchestrator's cumulative usage between turns:
      // the start of a fresh turn is the new baseline. A submission inside an open turn (a failover retry) keeps it.
      if (!this.turnOpen) this.rebase();
      this.turnOpen = true;
      this.ownTurns.add(payload.turnId);
      this.emit();
    }));
    // Each answer of this conversation, by model, with what it was charged then: a price set later prices it again.
    this.unsubs.push(deps.turnEvents.on('LLM_RESPONSE_RECEIVED', (payload) => {
      // An answer served through a subscription has no per-token price to change; one of another conversation's turn is not this one's.
      if (!this.ownTurns.has(payload.turnId) || payload.costSource === 'subscription') return;
      const key = `${payload.provider}:${payload.model}`;
      const entry = this.spendByModel.get(key) ?? { provider: payload.provider, model: payload.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, spentUsd: 0 };
      entry.input += payload.inputTokens;
      entry.output += payload.outputTokens;
      entry.cacheRead += payload.cacheReadTokens ?? 0;
      entry.cacheWrite += payload.cacheWriteTokens ?? 0;
      entry.spentUsd += typeof payload.costUsdCents === 'number' && Number.isFinite(payload.costUsdCents) ? payload.costUsdCents / 100 : 0;
      this.spendByModel.set(key, entry);
    }));
    this.unsubs.push(deps.agentEvents.on('AGENT_SPAWNING', (payload) => {
      this.agentMap.set(payload.agentId, { agentId: payload.agentId, task: payload.task, model: 'unknown', inputTokens: 0, outputTokens: 0, cost: 0, status: 'running' });
      this.trimAgents();
      this.emit();
    }));
    const ended = (status: UsageAgentStatus) => (payload: { readonly agentId: string }) => {
      const entry = this.agentMap.get(payload.agentId);
      if (!entry) return;
      // The final read: a cancelled agent that spent tokens keeps its cost.
      entry.status = status;
      this.readAgentUsage(entry);
      this.emit();
    };
    // The spending alert set anywhere (Money in another program, the web UI, a script) reaches this program's copy of
    // the daemon's settings; what the conversation's row says about it is read again then.
    const alertChanged = deps.configManager.subscribe?.(SPENDING_ALERT_KEY, () => this.emit());
    if (alertChanged) this.unsubs.push(alertChanged);
    // A price of your own set anywhere (Money, Spending, here or in another program) changes what the rows say it cost.
    const priceChanged = deps.configManager.subscribe?.(MODEL_PRICES_CONFIG_KEY, () => this.emit());
    if (priceChanged) this.unsubs.push(priceChanged);
    this.unsubs.push(deps.agentEvents.on('AGENT_COMPLETED', ended('done')));
    this.unsubs.push(deps.agentEvents.on('AGENT_FAILED', ended('failed')));
    this.unsubs.push(deps.agentEvents.on('AGENT_CANCELLED', ended('cancelled')));
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.listeners.clear();
  }

  /** Called on every change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
    this.deps.requestRender?.();
  }

  private rebase(): void {
    if (this.available()) this.prevCumulative = this.totals();
  }

  /** Snapshot a completed turn (the delta since the previous one). */
  recordTurn(now: number = Date.now()): void {
    if (this.available()) {
      const cu = this.totals();
      this.turnsList.push({
        input: Math.max(0, cu.input - this.prevCumulative.input),
        output: Math.max(0, cu.output - this.prevCumulative.output),
        cacheRead: Math.max(0, cu.cacheRead - this.prevCumulative.cacheRead),
        cacheWrite: Math.max(0, cu.cacheWrite - this.prevCumulative.cacheWrite),
        ts: now,
      });
      this.prevCumulative = cu;
      if (this.turnsList.length > MAX_TURNS) this.turnsList.shift();
    }
    this.emit();
  }

  private readAgentUsage(entry: MutableAgent): boolean {
    const rec = this.deps.getAgentStatus?.(entry.agentId);
    if (!rec?.usage) return false;
    const input = rec.usage.inputTokens + (rec.usage.cacheReadTokens ?? 0) + (rec.usage.cacheWriteTokens ?? 0);
    const model = rec.model && rec.model !== 'unknown' ? rec.model : entry.model;
    const cost = calcSessionCost(this.deps.pricing, rec.usage.inputTokens, rec.usage.outputTokens, rec.usage.cacheReadTokens ?? 0, rec.usage.cacheWriteTokens ?? 0, model);
    const changed = input !== entry.inputTokens || rec.usage.outputTokens !== entry.outputTokens || cost !== entry.cost || model !== entry.model;
    entry.inputTokens = input;
    entry.outputTokens = rec.usage.outputTokens;
    entry.cost = cost;
    entry.model = model;
    return changed;
  }

  /** Read the live usage of agents still running; whether anything changed. */
  readRunningAgents(): boolean {
    let changed = false;
    for (const entry of this.agentMap.values()) if (entry.status === 'running' && this.readAgentUsage(entry)) changed = true;
    return changed;
  }

  private trimAgents(): void {
    if (this.agentMap.size <= MAX_AGENTS) return;
    for (const [id, entry] of this.agentMap) {
      if (this.agentMap.size <= MAX_AGENTS) break;
      if (entry.status !== 'running') this.agentMap.delete(id);
    }
  }

  available(): boolean { return isConversationUsageAvailable(this.deps.getUsage()); }

  contextAvailable(): boolean { return this.available() || this.deps.getContextTokens() > 0; }

  totals(): UsageTotals {
    const u = this.deps.getUsage();
    return { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
  }

  /** Completed turns, oldest first. */
  turns(): readonly UsageTurn[] { return this.turnsList; }

  /** Agents started in this conversation, in the order they started. */
  agents(): readonly UsageAgentEntry[] { return [...this.agentMap.values()]; }

  modelId(): string { return this.deps.getUsage().model || this.deps.getModelId(); }

  /** The model in use as `provider:model`, the key `usage.price` sets a price under. */
  modelKey(): string { return this.deps.getModelKey?.() ?? this.modelId(); }

  contextTokens(): number { return Math.max(0, this.deps.getContextTokens()); }

  contextWindow(): number { return Math.max(0, this.deps.getContextWindow()); }

  /** Where auto-compaction starts, as a fraction of the window (0 when it is off): the figure the compactor uses. */
  compactThreshold(): number {
    const session = this.deps.sessionReadModel?.getSnapshot();
    return evaluateSessionMaintenance({
      configManager: this.deps.configManager as ConfigManager,
      currentTokens: this.contextTokens(),
      contextWindow: this.contextWindow(),
      messageCount: session?.totalTurns,
      sessionMemoryCount: this.deps.sessionMemoryStore?.list().length ?? 0,
      session: session?.session,
    }).thresholdPct / 100;
  }

  sessionCost(): UsageCost {
    // The cost as spent (each response at its own model's price) when the conversation has it.
    const spent = this.deps.getUsage().costUsd;
    if (typeof spent === 'number' && Number.isFinite(spent)) {
      // The answers this program saw are priced at today's price of the model that gave each (a price of your own set
      // since, in Money, prices them again, as the daemon's rows are); answers from before it started (a resumed
      // conversation) stay at what they were charged.
      let repriced = spent;
      for (const entry of this.spendByModel.values()) {
        const now = resolveSessionCost(this.deps.pricing, entry.input, entry.output, entry.cacheRead, entry.cacheWrite, entry.model, entry.provider);
        if (now.priced) repriced += now.cost - entry.spentUsd;
      }
      return { usd: Math.max(0, repriced), priced: this.available(), source: this.available() ? 'each answer at the current price of the model that gave it' : null };
    }
    const u = this.totals();
    const model = this.modelId();
    const priced = this.available() && isModelPriced(this.deps.pricing, model);
    return { usd: calcSessionCost(this.deps.pricing, u.input, u.output, u.cacheRead, u.cacheWrite, model), priced, source: priced ? describePricingSource(this.deps.pricing, model) : null };
  }

  /** Cost of everything the fleet ran (agents, chains, workflows), or null when nothing is priced. */
  fleetCost(): number | null {
    const fromFleet = this.deps.getFleetCost?.() ?? null;
    if (fromFleet !== null) return fromFleet;
    const ledger = [...this.agentMap.values()].reduce((sum, a) => sum + a.cost, 0);
    return ledger > 0 ? ledger : null;
  }

  /** True when some spend has no known price (so totals undercount it). */
  hasUnpricedSpend(): boolean {
    const u = this.totals();
    if (!isModelPriced(this.deps.pricing, this.modelId()) && (u.input + u.output + u.cacheRead + u.cacheWrite) > 0) return true;
    return [...this.agentMap.values()].some((a) => a.inputTokens > 0 && !isModelPriced(this.deps.pricing, a.model));
  }

  /** The spending alert in USD (0 = none): the daemon's setting, from this program's copy. */
  budget(): number {
    return readBudgetAlertUsd((key) => this.deps.configManager.get(key as Parameters<ConfigManager['get']>[0]));
  }

  overBudget(): boolean {
    return this.available() && computeBudgetBreach(this.sessionCost().usd, this.budget());
  }
}

// ---------------------------------------------------------------------------- the Spending tab's rows

/** One row of this conversation's spending: the conversation, its turns, or an agent it started. */
export interface ConversationSpendItem extends PlaceItem {
  readonly state: 'conversation' | 'turns' | 'agent';
  readonly kind: 'here';
  readonly title: string;
  readonly right: string;
  readonly attention: boolean;
  readonly lines: readonly PlaceDetailLine[];
  /** The conversation's row: the model in use as `provider:model`, which its "your price" control prices. */
  readonly modelKey?: string | undefined;
}

/** '53.0K', '1.2M'. */
function count(n: number): string {
  const value = Math.max(0, Math.round(n));
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** Under a dollar, up to four places (Money's rows say the same): $0.001, $0.0243, $0.50. */
function usd(value: number): string {
  return `$${value > 0 && value < 1 ? value.toFixed(4).replace(/0{1,2}$/, '') : value.toFixed(2)}`;
}

/** The conversation, its turns and its agents as rows, read now. */
export function conversationSpendItems(tracker: UsageTracker): readonly ConversationSpendItem[] {
  tracker.readRunningAgents();
  const available = tracker.available();
  const cost = tracker.sessionCost();
  const totals = tracker.totals();
  const budget = tracker.budget();
  const over = tracker.overBudget();
  const costWords = !available ? 'unavailable' : cost.priced ? usd(cost.usd) : 'price unknown';
  const lines: PlaceDetailLine[] = [{ label: 'Model', text: tracker.modelId() }];
  if (tracker.contextAvailable()) {
    const window = tracker.contextWindow();
    const used = tracker.contextTokens();
    const threshold = tracker.compactThreshold();
    lines.push({
      label: 'Context',
      text: window > 0
        ? `${count(used)} of ${count(window)} tokens, ${Math.min(100, Math.round((used / window) * 100))}%; ${threshold > 0 ? `shortened at ${Math.round(threshold * 100)}%` : 'auto-compaction is off'}`
        : `${count(used)} tokens; the context window is not known`,
    });
  } else {
    lines.push({ label: 'Context', text: 'unavailable', tone: 'muted' });
  }
  if (available) {
    lines.push(
      { label: 'Input', text: `${count(totals.input)} tokens` },
      { label: 'Output', text: `${count(totals.output)} tokens` },
      { label: 'Cache read', text: `${count(totals.cacheRead)} tokens` },
      { label: 'Cache write', text: `${count(totals.cacheWrite)} tokens` },
      { label: 'In all', text: `${count(totals.input + totals.output + totals.cacheRead + totals.cacheWrite)} tokens` },
    );
  } else {
    lines.push({ text: 'Usage and cost unavailable: the saved token usage is not valid.', tone: 'muted' });
  }
  lines.push({ label: 'Cost', text: costWords, ...(over ? { tone: 'warning' as const } : {}) });
  if (available && !cost.priced) lines.push({ text: 'The model has no known price, so its cost is not counted.', tone: 'muted' });
  else if (cost.source) lines.push({ text: cost.source, tone: 'muted' });
  lines.push({ label: 'Spending alert', text: budget > 0 ? `${usd(budget)}, ${available ? Math.round((cost.usd / budget) * 100) : 0}% reached` : 'none', ...(over ? { tone: 'warning' as const } : {}) });
  if (over) lines.push({ text: 'This conversation has cost more than the spending alert.', tone: 'warning' });
  if (tracker.hasUnpricedSpend() && budget > 0) lines.push({ text: 'Some of what was spent has no known price and is not counted.', tone: 'warning' });
  const fleet = tracker.fleetCost();
  lines.push({ label: 'Split', text: `you ${costWords}, agents ${fleet === null ? 'none priced' : usd(fleet)}` });

  const items: ConversationSpendItem[] = [{
    id: 'here:conversation', kind: 'here', state: 'conversation', title: 'This conversation', right: costWords, attention: over, lines,
    modelKey: tracker.modelKey(),
  }];

  const turns = tracker.turns();
  items.push({
    id: 'here:turns', kind: 'here', state: 'turns', title: 'Its turns, one by one',
    right: `${turns.length} turn${turns.length === 1 ? '' : 's'}`, attention: false,
    lines: !available
      ? [{ text: 'Turn usage unavailable: the saved token usage is not valid.', tone: 'muted' }]
      : turns.length === 0
        ? [{ text: 'No turns recorded yet: each answer that finishes adds one, with its input, output and cache tokens.', tone: 'muted' }]
        : turns.map((turn, index) => ({ index, turn })).reverse().map(({ index, turn }) => ({
          label: `Turn ${index + 1}`,
          text: `${count(turn.input)} in, ${count(turn.output)} out, ${count(turn.cacheRead)} read from cache, ${count(turn.cacheWrite)} written to cache; ${count(turn.input + turn.output + turn.cacheRead + turn.cacheWrite)} in all`,
        })),
  });

  const agents = tracker.agents();
  const planCost = agents.reduce((sum, agent) => sum + agent.cost, 0) + cost.usd;
  for (const agent of agents) {
    const unpriced = agent.inputTokens > 0 && agent.cost === 0 && agent.model === 'unknown';
    items.push({
      id: `here:agent:${agent.agentId}`, kind: 'here', state: 'agent',
      title: `Agent ${agent.agentId.slice(0, 8)}: ${agent.task.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 60)}`,
      right: unpriced ? 'not priced' : agent.cost > 0 ? usd(agent.cost) : agent.status === 'running' ? 'running' : '-',
      attention: agent.status === 'failed',
      lines: [
        { label: 'Task', text: agent.task.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ') },
        { label: 'Model', text: agent.model },
        { label: 'Tokens', text: agent.inputTokens > 0 ? `${count(agent.inputTokens)} in, ${count(agent.outputTokens)} out` : 'none used yet' },
        { label: 'Cost', text: unpriced ? 'not priced' : usd(agent.cost) },
        { label: 'State', text: agent.status === 'done' ? 'finished' : agent.status },
        { label: 'Whole plan', text: `${!available ? 'unavailable' : cost.priced ? usd(planCost) : 'price unknown'} for this conversation and its ${agents.length} agent${agents.length === 1 ? '' : 's'}` },
      ],
    });
  }
  return items;
}

/**
 * The spending alert at the end of a turn: the warning to say once when this conversation's cost first passes the
 * daemon's alert (read from this program's copy of its settings, no call in the turn), else undefined. It is said
 * again only after the cost was back under it or the alert changed. An unpriced model is never "over".
 */
export function spendingAlertWatch(tracker: UsageTracker): () => string | undefined {
  let lastBudget = -1;
  let said = false;
  return () => {
    const budget = tracker.budget();
    if (budget !== lastBudget) { lastBudget = budget; said = false; }
    const cost = tracker.sessionCost();
    if (budget <= 0 || !cost.priced) return undefined;
    if (!tracker.overBudget()) { said = false; return undefined; }
    if (said) return undefined;
    said = true;
    return `This conversation has cost ${usd(cost.usd)}, more than your spending alert of ${usd(budget)}. Money, Spending, shows what it went on and changes the alert.`;
  };
}

/** Money's "this conversation" rows, from this program's tracker: read when the place asks, told of every change. */
export function conversationSpendingSource(tracker: () => UsageTracker | undefined): PlaceProgramSource {
  return {
    read: () => {
      const live = tracker();
      return live ? conversationSpendItems(live) : [];
    },
    subscribe: (onChange) => tracker()?.subscribe(onChange) ?? (() => {}),
  };
}

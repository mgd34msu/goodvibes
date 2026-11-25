/**
 * routes/attribution-ingest.ts, the runtime-bus → cost-attribution ingest.
 *
 * LLM usage lands from LLM_RESPONSE_RECEIVED turn events (with agent /
 * tool / hook / MCP origin dimensions and quota-window snapshots from
 * rate-limit headers). Metered VOICE spend rides the same ledger from
 * PROVIDER_VOICE_USAGE events: the billable unit count lands on inputTokens
 * under a voice-scoped model key (e.g. `elevenlabs:voice-tts:characters`),
 * honestly UNPRICED until the one-key manual price (pricing.modelPrices)
 * names the USD per 1M units. Local voice engines never emit the event,
 * no billing dimension at all, never a fake $0.00.
 */
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { CostAttributionService } from '../../runtime/cost/attribution.js';
import type { QuotaWindowTracker } from '../../runtime/cost/quota-window.js';
import { noteSpendingAlertPassed, onModelUsage, SPENDING_ALERT_PASSED_ID_PREFIX, spendingAlertPassedSentence } from '../../runtime/cost/model-usage.js';
import { noteListChanged } from '../../runtime/list-changes.js';

/** What is currently bound to each bus, so binding again replaces it instead of recording every event twice. */
const bound = new WeakMap<object, () => void>();

/** The sources that are not the daemon's own runs: a conversation (each program warns for its own), voice, an unnamed record. */
const NOT_A_RUN = new Set(['conversation', 'voice', '(unattributed)']);

/**
 * The spending alert over the daemon's own runs (schedules, work, web chat, shared sessions): checked when one of
 * them records a cost, said once when what they cost in the last 24 hours first passes the alert, again only after it
 * was back under it or the alert changed. Nothing waits on a clock.
 */
function spendingAlertOverRuns(
  costAttribution: Pick<CostAttributionService, 'attribution'>,
  readAlertUsd: () => number,
): () => void {
  let lastAlert = -1;
  let said = false;
  return () => {
    const alert = readAlertUsd();
    if (alert !== lastAlert) { lastAlert = alert; said = false; }
    if (!(alert > 0)) return;
    const runs = costAttribution.attribution('24h', 'source').rows.filter((row) => !NOT_A_RUN.has(row.key));
    const spent = runs.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    if (spent <= alert) { said = false; return; }
    if (said) return;
    said = true;
    noteSpendingAlertPassed({ costUsd: spent, alertUsd: alert, text: spendingAlertPassedSentence(spent, alert) });
    // Every connected program and the web UI say it once as a notice: the crossing is announced with its own id, which
    // each reads `usage.by-source`'s `data.alert.text` for (terminal-shell spending-alert-follow.ts, the web UI's
    // SpendingAlertNotice).
    noteListChanged({ list: 'spending', change: 'changed', id: `${SPENDING_ALERT_PASSED_ID_PREFIX}${Date.now()}` });
  };
}

/**
 * Returns the function that removes the subscriptions this call made. `readAlertUsd` is the daemon's spending alert
 * (`behavior.budgetAlertUsd`); with it, the daemon's own runs are checked against it as they record.
 */
export function bindCostAttributionIngest(
  bus: Pick<RuntimeEventBus, 'onDomain'>,
  costAttribution: Pick<CostAttributionService, 'record' | 'attribution'>,
  quotaWindow: Pick<QuotaWindowTracker, 'record'>,
  readAlertUsd?: () => number,
): () => void {
  bound.get(bus)?.();
  // An agent's request (a schedule's run, a piece of work, a shared session's answer) and a web chat turn, said where
  // each reads its usage from the provider's answer (runtime/cost/model-usage.ts), with what it was for.
  const checkAlert = readAlertUsd ? spendingAlertOverRuns(costAttribution, readAlertUsd) : undefined;
  const offRuns = onModelUsage((usage) => {
    costAttribution.record(usage);
    checkAlert?.();
  });
  const offProviders = bus.onDomain('providers', (envelope) => {
    const event = envelope.payload;
    if (event.type === 'PROVIDER_VOICE_USAGE') {
      costAttribution.record({
        at: Date.now(),
        provider: event.provider,
        model: `${event.provider}:voice-${event.kind}:${event.unit}`,
        source: 'voice',
        sessionId: envelope.sessionId,
        inputTokens: event.billableUnits,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    }
  });
  const offTurn = bus.onDomain('turn', (envelope) => {
    const event = envelope.payload;
    if (event.type === 'LLM_RESPONSE_RECEIVED') {
      costAttribution.record({
        at: Date.now(),
        provider: event.provider,
        model: event.model,
        // A conversation's own loop (a session the daemon holds); its agents and the web chat say their own source.
        source: 'conversation',
        sessionId: envelope.sessionId,
        // Attribution dimensions: the agent (from the envelope) and the
        // tool/hook/MCP-server cause (stamped by the cost-origin scope); each
        // stays undefined when the emit carried no such origin.
        ...(envelope.agentId !== undefined ? { agentId: envelope.agentId } : {}),
        ...(event.originTool !== undefined ? { tool: event.originTool } : {}),
        ...(event.originHook !== undefined ? { hook: event.originHook } : {}),
        ...(event.originMcpServer !== undefined ? { mcpServer: event.originMcpServer } : {}),
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens ?? 0,
        cacheWriteTokens: event.cacheWriteTokens ?? 0,
      });
      // Quota snapshot from rate-limit headers on THIS (successful) response,
      // the pre-limit signal, not just the post-429 cooldown.
      if (event.rateLimit) {
        quotaWindow.record({
          provider: event.provider,
          at: Date.now(),
          ...(event.rateLimit.limit !== undefined ? { limit: event.rateLimit.limit } : {}),
          ...(event.rateLimit.remaining !== undefined ? { remaining: event.rateLimit.remaining } : {}),
          ...(event.rateLimit.resetAt !== undefined ? { resetAt: event.rateLimit.resetAt } : {}),
          ...(event.rateLimit.retryAfterMs !== undefined ? { retryAfterMs: event.rateLimit.retryAfterMs } : {}),
        });
      }
    } else if (event.type === 'STREAM_RETRY' && event.rateLimited === true) {
      // A rate-limit retry carries the provider's requested backoff, the real
      // cooldown window the fan-out assessment reasons over. The retry site
      // states the facts; nothing reads the sentence.
      quotaWindow.record({ provider: event.provider, at: Date.now(), retryAfterMs: event.retryAfterMs ?? event.delayMs });
    }
  });
  const unbind = (): void => {
    offRuns();
    offProviders();
    offTurn();
    if (bound.get(bus) === unbind) bound.delete(bus);
  };
  bound.set(bus, unbind);
  return unbind;
}

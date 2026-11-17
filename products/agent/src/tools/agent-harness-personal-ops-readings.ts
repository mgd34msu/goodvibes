import { classicPersonalOpsResultField, classicPersonalOpsReceiptStatus, decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { captureJudgmentPort, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult, sideEffect } from '@goodvibes-jev/engine/platform/platform/gate';
import { personalOpsSampleField, personalOpsToolLane, personalOpsReceiptStatus, personalOpsResultField } from '@goodvibes-jev/engine/platform/platform/routing';
import { booleanValue, ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { personalOpsEntry, personalOpsJson } from './agent-harness-personal-ops-source.ts';

function assertNativeCancellation(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/** Only the pure interpretation phase is replaceable. The complete original protected source remains owned. */
async function withPersonalOpsReading<S, T>(source: S, options: CatalogRankingOptions, site: string,
  read: (captured: S, authority: JudgmentPortCapture) => Promise<T>, classic: (captured: S) => T, skip?: (captured: S) => boolean): Promise<T> {
  return withConfiguredDecisionModelPolicy(() => withModelReadingSource(source, options, async (captured, current) => {
    const assertCurrent = () => { assertNativeCancellation(current.signal); current.assertCurrent?.(); };
    if (skip?.(captured)) { assertCurrent(); return classic(captured); }
    return decisionOrClassic(async () => {
      const authority = captureJudgmentPort(site, { signal: current.signal, assertCurrent, prepareResultCapture: prepareJudgmentResult });
      try { const result = await read(captured, authority); authority.assertCurrent(); return result; }
      finally {
        const observation = authority.consumeObservation();
        const retained = () => { assertNativeCancellation(current.signal); assertNativeCancellation(authority.signal);
          if (!isClassicOperation()) observation.assertCurrent(); };
        current.retainCurrent?.(retained, site); retained();
      }
    }, () => { assertCurrent(); return classic(captured); }, () => { assertCurrent(); return true; });
  }));
}

export type DiscoveryLane = 'inbox' | 'calendar' | 'tasks' | 'reminders' | 'approvals' | 'automation' | 'schedules';

/**
 * Classic lane membership, by explicit method id. The lane word is not searched for
 * in a method's text: the schedule methods say "schedule", never "reminders", so a
 * word match leaves the reminders lane empty. An entry ending in a dot is a prefix.
 */
const CLASSIC_LANE_METHODS: Readonly<Record<DiscoveryLane, readonly string[]>> = {
  inbox: ['email.', 'channels.inbox.'],
  calendar: ['calendar.'],
  tasks: ['tasks.', 'projectPlanning.workPlan.task'],
  reminders: ['automation.schedules.'],
  approvals: ['approvals.'],
  automation: ['automation.'],
  schedules: ['automation.schedules.'],
};

/**
 * Methods the lane's own tools dispatch, whatever a reading or the lane word says.
 * agent_schedule_edit calls automation.jobs.update, so the reminders lane must see it.
 */
export const LANE_DEPENDENCY_METHODS: Readonly<Partial<Record<DiscoveryLane, readonly string[]>>> = {
  reminders: ['automation.jobs.update'],
};

/**
 * `unassessed` receives the entries a reading could not settle (not acted on, or
 * uncertain). They are left out of the lane rather than failing the whole lane,
 * and the caller reports how many there were.
 */
export async function personalOpsLaneMembers<T>(entries: readonly T[], lane: DiscoveryLane, describe: (entry: T) => {
  readonly id: string; readonly description: string; readonly evidence: unknown;
}, options: CatalogRankingOptions, unassessed?: (entries: readonly T[]) => void,
  /** False when the entry ids are not contract method ids (connector server names): Classic then keeps every entry. */
  idsAreMethods = true): Promise<readonly T[]> {
  if (!entries.length) return [];
  const result = await rankHarnessCatalog(entries, lane, describe, `agent.personal-ops.lane-member:${lane}`,
    { ...options, requirePreservedSource: true }, 'agent.personal-ops.lane-member');
  if (result.provenance === 'classic') {
    if (!idsAreMethods) return entries;
    const prefixes = CLASSIC_LANE_METHODS[lane];
    return entries.filter((entry) => { const id = describe(entry).id; return prefixes.some((prefix) => id.startsWith(prefix)); });
  }
  const members: T[] = [], unsettled: T[] = [];
  for (const { entry, judgment } of result.matches) {
    if (judgment?.reading.outcome !== 'act' || judgment.reading.verdict === 'uncertain') unsettled.push(entry);
    else if (judgment.reading.verdict === 'yes') members.push(entry);
  }
  if (unsettled.length) unassessed?.(unsettled);
  return members;
}

export interface PersonalOpsToolContract {
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export async function readPersonalOpsTool(contract: PersonalOpsToolContract, options: CatalogRankingOptions): Promise<{
  readonly lane: 'inbox' | 'calendar'; readonly effect: 'read-only' | 'confirmed-effect';
} | null> {
  const site = 'agent.personal-ops.tool-lane';
  return withPersonalOpsReading(contract, options, site, async (captured, authority) => {
    const lane = await personalOpsToolLane.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent();
    lane.recordAction('read-only connector lane classification');
    const reading = lane.readings.lane;
    if (reading.outcome !== 'act' || reading.choice === 'neither') return null;
    const effects = await sideEffect.run(authority.port, personalOpsEntry({ ...captured, arguments: {} }), {
      site: 'agent.personal-ops.tool-effect', only: ['mutates', 'outward', 'secrets'], signal: authority.signal, beforeAttempt: authority.assertCurrent,
    });
    authority.assertCurrent(); effects.recordAction('read-only connector effect classification');
    const { mutates, outward, secrets } = effects.readings;
    if (!mutates || !outward || !secrets || mutates.outcome !== 'act' || outward.outcome !== 'act' || secrets.outcome !== 'act'
      || secrets.verdict !== 'no') return null;
    return { lane: reading.choice, effect: mutates.verdict === 'yes' || outward.verdict === 'yes' ? 'confirmed-effect' as const : 'read-only' as const };
  }, () => null);
}

export async function readPersonalOpsSampleField(source: {
  readonly field: string; readonly lane: 'inbox' | 'calendar'; readonly effect: 'read-only' | 'confirmed-effect';
  readonly contract: PersonalOpsToolContract; readonly inputSchema: unknown;
}, options: CatalogRankingOptions): Promise<unknown> {
  const site = 'agent.personal-ops.sample-field';
  return withPersonalOpsReading(source, options, site, async (captured, authority) => {
    const run = await personalOpsSampleField.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only schema placeholder classification');
    const role = run.readings.role;
    if (role.outcome !== 'act') throw new ToolInputProjectionError('held');
    const calendar = captured.lane === 'calendar';
    switch (role.choice) {
      case 'count': return 10;
      case 'preview': return captured.effect === 'confirmed-effect';
      case 'include': return true;
      case 'start': return calendar ? '<start-iso>' : '<since>';
      case 'end': return calendar ? '<end-iso>' : '<until>';
      case 'record': return calendar ? '<event-id>' : '<message-or-thread-id>';
      case 'calendar': return '<calendar-or-event-id>';
      case 'query': return calendar ? 'today' : 'is:unread newer_than:7d';
      case 'mailbox': return calendar ? '<calendar-name>' : '<mailbox-or-label>';
      case 'account': return '<account-or-calendar>';
      case 'subject': return '<reviewed subject>';
      case 'body': return '<reviewed draft text>';
      case 'attendees': return ['<attendee@example.com>'];
      case 'other': return `<${captured.field}>`;
    }
  }, captured => `<${captured.field}>`);
}

export async function readPersonalOpsBoolean(source: {
  readonly parameter: string; readonly value: unknown; readonly record: unknown;
}, options: CatalogRankingOptions): Promise<boolean | null> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (typeof source.value === 'boolean') return source.value;
  if (source.value === 'true' || source.value === 'false') return source.value === 'true';
  if (typeof source.value !== 'string') return null;
  const site = 'agent.personal-ops.provider-boolean';
  return withPersonalOpsReading(source, options, site, async (captured, authority) => {
    const run = await booleanValue.run(authority.port, personalOpsEntry({ ...captured, tool: 'provider published personal-ops record',
      description: 'The named boolean flag on the complete provider record; read its meaning in the record context.',
    }), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only provider boolean classification');
    const reading = run.readings.boolean_value;
    if (reading.outcome !== 'act' || reading.choice === 'neither') return null;
    return reading.choice === 'true';
  }, () => null);
}

export async function readPersonalOpsReceiptStatus(source: unknown, options: CatalogRankingOptions): Promise<string> {
  const site = 'agent.personal-ops.receipt-status';
  return withPersonalOpsReading(source, options, site, async (captured, authority) => {
    const run = await personalOpsReceiptStatus.run(authority.port, personalOpsEntry(captured), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only published effect receipt classification');
    if (run.readings.status.outcome !== 'act') throw new ToolInputProjectionError('held');
    return run.readings.status.choice;
  }, captured => classicPersonalOpsReceiptStatus(captured));
}

export async function readPersonalOpsResultField(source: Readonly<Record<string, unknown>>, purpose: string, options: CatalogRankingOptions): Promise<string | null> {
  const site = 'agent.personal-ops.result-field';
  return withPersonalOpsReading({ source, purpose }, options, site, async (captured, authority) => {
    const keys = Object.keys(captured.source);
    if (!keys.length) return null;
    const run = await personalOpsResultField.select(authority.port, personalOpsEntry(captured), keys.map((key, index) => ({
      id: String(index), content: personalOpsJson({ key, value: captured.source[key] }),
    })), { site, signal: authority.signal, beforeAttempt: authority.assertCurrent });
    authority.assertCurrent(); run.recordAction('read-only provider result field selection');
    if (run.outcome !== 'act') throw new ToolInputProjectionError('held');
    if (run.chosen === undefined) return null;
    const key = keys[Number(run.chosen)];
    if (key === undefined || String(Number(run.chosen)) !== run.chosen) throw new ToolInputProjectionError('held');
    return key;
  }, captured => classicPersonalOpsResultField(captured.source, captured.purpose), captured => Object.keys(captured.source).length === 0);
}

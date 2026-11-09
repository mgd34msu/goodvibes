import type { DecisionEntry, DecisionVolumeEntry } from '@goodvibes-jev/judgment';
import { array, strictObject, string, number } from 'zod/v4';

export type JudgmentVolumeEntry = DecisionEntry | DecisionVolumeEntry;

export interface JudgmentVolumeRow {
  readonly battery: string;
  readonly site: string;
  readonly logicalDecisions: number;
  readonly recordedEntries: number;
  readonly targetAttempts: number;
  readonly wireAttempts: number;
  readonly unknownDispatchAttempts: number;
  readonly callsWithoutAttemptEvidence: number;
}
export interface JudgmentVolume extends Omit<JudgmentVolumeRow, 'battery' | 'site'> {
  readonly rows: readonly JudgmentVolumeRow[];
}
export interface JudgmentVolumeBudget {
  readonly name: string;
  readonly battery?: string;
  readonly site?: string;
  readonly maxLogicalDecisions: number;
  readonly maxWireAttempts?: number;
}
export interface JudgmentVolumeBreach {
  readonly budget: string;
  readonly kind: 'logical-decisions' | 'wire-attempts' | 'incomplete-wire-evidence';
  readonly observed: number;
  readonly maximum: number;
}

const count = number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const budgetSchema = array(strictObject({ name: string().min(1).max(256), battery: string().min(1).optional(), site: string().min(1).optional(),
  maxLogicalDecisions: count, maxWireAttempts: count.optional() }));
export function captureJudgmentVolumeBudgets(value: unknown): readonly JudgmentVolumeBudget[] {
  return budgetSchema.parse(value).map(budget => ({ name: budget.name, maxLogicalDecisions: budget.maxLogicalDecisions,
    ...(budget.battery === undefined ? {} : { battery: budget.battery }),
    ...(budget.site === undefined ? {} : { site: budget.site }),
    ...(budget.maxWireAttempts === undefined ? {} : { maxWireAttempts: budget.maxWireAttempts }) }));
}

function tallyVolume(values: readonly JudgmentVolumeEntry[]) {
  const identities = new Set<string>();
  let targetAttempts = 0, wireAttempts = 0, unknownDispatchAttempts = 0, callsWithoutAttemptEvidence = 0;
  for (const entry of values) {
    const identity = ('status' in entry ? entry.lineage?.logicalRequestId : entry.volume.logicalRequestId) ?? entry.id;
    if (identities.has(identity)) continue;
    identities.add(identity);
    if (!('status' in entry)) {
      targetAttempts += entry.volume.targetAttempts; wireAttempts += entry.volume.wireAttempts;
      unknownDispatchAttempts += entry.volume.unknownDispatchAttempts; callsWithoutAttemptEvidence += entry.volume.callsWithoutAttemptEvidence;
      continue;
    }
    const lineage = entry.lineage;
    if (!lineage || (lineage.attempts.length === 0 && !lineage.omittedAttempts)) { callsWithoutAttemptEvidence++; continue; }
    targetAttempts += lineage.attempts.length + (lineage.omittedAttempts ?? 0);
    wireAttempts += lineage.attempts.filter(attempt => attempt.dispatched === true).length;
    unknownDispatchAttempts += lineage.attempts.filter(attempt => attempt.dispatched === undefined).length + (lineage.omittedAttempts ?? 0);
  }
  return { recordedEntries: values.length, logicalDecisions: identities.size, targetAttempts, wireAttempts, unknownDispatchAttempts, callsWithoutAttemptEvidence };
}

/** Count logical readings separately from target selection and actual transport dispatch. */
export function judgmentVolume(entries: readonly JudgmentVolumeEntry[]): JudgmentVolume {
  const groups = new Map<string, JudgmentVolumeEntry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.context.battery ?? '<unnamed>', entry.context.site ?? '<unnamed>']);
    const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group);
  }

  const rows = [...groups].map(([key, values]) => {
    const [battery, site] = JSON.parse(key) as [string, string];
    return { battery, site, ...tallyVolume(values) };
  }).sort((a, b) => b.logicalDecisions - a.logicalDecisions || a.battery.localeCompare(b.battery) || a.site.localeCompare(b.site));
  return { ...tallyVolume(entries), rows };
}

/** Unknown historical dispatch cannot certify a wire budget. No live model calls are needed. */
export function judgmentVolumeBreaches(entries: readonly JudgmentVolumeEntry[], budgets: readonly JudgmentVolumeBudget[]): readonly JudgmentVolumeBreach[] {
  const breaches: JudgmentVolumeBreach[] = [];
  for (const budget of captureJudgmentVolumeBudgets(budgets)) {
    const volume = tallyVolume(entries.filter(entry => (budget.battery === undefined || entry.context.battery === budget.battery) && (budget.site === undefined || entry.context.site === budget.site)));
    const logical = volume.logicalDecisions, wire = volume.wireAttempts;
    const unknown = volume.unknownDispatchAttempts + volume.callsWithoutAttemptEvidence;
    if (logical > budget.maxLogicalDecisions) breaches.push({ budget: budget.name, kind: 'logical-decisions', observed: logical, maximum: budget.maxLogicalDecisions });
    if (budget.maxWireAttempts !== undefined) {
      if (wire > budget.maxWireAttempts) breaches.push({ budget: budget.name, kind: 'wire-attempts', observed: wire, maximum: budget.maxWireAttempts });
      if (unknown) breaches.push({ budget: budget.name, kind: 'incomplete-wire-evidence', observed: unknown, maximum: 0 });
    }
  }
  return breaches;
}

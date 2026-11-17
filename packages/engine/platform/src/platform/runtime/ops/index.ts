import { rankClassicCatalog } from '../classic-catalog.js';
/**
 * Operational runbooks: `/doctor <symptom>` in both terminal apps and the
 * `ops.doctor` operator method find the playbook for a symptom and run its
 * checks against the live state of the process that answers.
 *
 * Finding a playbook is a lookup over seven fixed entries (an id or tag the
 * symptom names, then word overlap with names, descriptions and symptoms); no
 * model is asked.
 */

export type {
  DiagnosticSeverity,
  DiagnosticCheckResult,
  DiagnosticCheck,
  PlaybookStepKind,
  PlaybookStep,
  Playbook,
  PlaybookRegistryEntry,
  PlaybookRegistry,
} from './types.js';

export {
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
} from './playbooks/index.js';

export {
  createOpsCheckContext,
  createOpsEventObserver,
  type OpsCheckContext,
  type OpsCheckContextOptions,
  type OpsLatencyReading,
  type OpsPendingApproval,
} from './runtime-context.js';

import type { DiagnosticCheckResult, Playbook, PlaybookRegistry, PlaybookRegistryEntry, PlaybookStep } from './types.js';
import type { OpsCheckContext } from './runtime-context.js';
import { safeCheck } from './safe-check.js';
import {
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
} from './playbooks/index.js';

/** All registered playbooks in definition order. */
const ALL_PLAYBOOKS: readonly Playbook[] = [
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
];

/** Registry version, bump when playbooks are added or updated. */
export const REGISTRY_VERSION = '2.0.0';

/** The registry, keyed by playbook id. */
export function getPlaybookRegistry(): PlaybookRegistry {
  const registry: PlaybookRegistry = new Map<string, PlaybookRegistryEntry>();
  for (const playbook of ALL_PLAYBOOKS) {
    registry.set(playbook.id, { playbook, version: REGISTRY_VERSION, updatedAt: '2026-11-16' });
  }
  return registry;
}

/** Look up a single playbook by id. */
export function getPlaybook(id: string): Playbook | undefined {
  return ALL_PLAYBOOKS.find((p) => p.id === id);
}

/** Playbooks with at least one of these tags. */
export function findPlaybooksByTag(...tags: string[]): Playbook[] {
  const tagSet = new Set(tags.map((tag) => tag.toLowerCase()));
  return ALL_PLAYBOOKS.filter((p) => p.tags.some((t) => tagSet.has(t)));
}

/**
 * The playbooks for a symptom in the person's own words, best first: an exact
 * id, then playbooks a word of the symptom tags, then word overlap with names,
 * descriptions and symptoms. Empty when nothing matches.
 */
export function findPlaybooksBySymptom(query: string): Playbook[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const exact = getPlaybook(text);
  if (exact) return [exact];
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  const tagged = findPlaybooksByTag(...words);
  const ranked = rankClassicCatalog(ALL_PLAYBOOKS, text, (playbook) => ({
    id: playbook.id,
    description: `${playbook.name} ${playbook.description} ${playbook.symptoms.join(' ')} ${playbook.tags.join(' ')}`,
  })).map((match) => match.entry);
  return [...new Set([...tagged, ...ranked])];
}

/** One check's outcome: pass, fail, or unknown when it could not look. */
export type DoctorCheckOutcome = 'pass' | 'fail' | 'unknown';

export interface DoctorCheckReport {
  readonly id: string;
  readonly label: string;
  readonly outcome: DoctorCheckOutcome;
  readonly severity: DiagnosticCheckResult['severity'];
  readonly summary: string;
}

export interface DoctorPlaybookReport {
  readonly id: string;
  readonly name: string;
  readonly checks: readonly DoctorCheckReport[];
  readonly steps: readonly PlaybookStep[];
}

export interface DoctorReport {
  readonly symptom: string;
  /** The matched playbooks, best first; empty when the symptom matched none. */
  readonly playbooks: readonly DoctorPlaybookReport[];
  /** Every playbook id and name, for a symptom that matched nothing. */
  readonly available: readonly { readonly id: string; readonly name: string }[];
}

/** Most playbooks a diagnosis runs for one symptom. */
const MAX_PLAYBOOKS = 2;

/** Find the playbooks for a symptom and run their checks against live state. Paid only when asked. */
export async function runDoctor(symptom: string, context: OpsCheckContext): Promise<DoctorReport> {
  const matched = findPlaybooksBySymptom(symptom).slice(0, MAX_PLAYBOOKS);
  const playbooks = await Promise.all(matched.map(async (playbook): Promise<DoctorPlaybookReport> => ({
    id: playbook.id,
    name: playbook.name,
    steps: playbook.steps,
    checks: await Promise.all(playbook.checks.map(async (check): Promise<DoctorCheckReport> => {
      const result = await safeCheck(() => check.run(context));
      return {
        id: check.id,
        label: check.label,
        outcome: result.evaluated === false ? 'unknown' : result.passed ? 'pass' : 'fail',
        severity: result.severity,
        summary: result.summary,
      };
    })),
  })));
  return { symptom, playbooks, available: ALL_PLAYBOOKS.map((p) => ({ id: p.id, name: p.name })) };
}

/** The plain lines a terminal prints for a diagnosis. */
export function formatDoctorReport(report: DoctorReport): string[] {
  if (report.playbooks.length === 0) {
    return [
      `Nothing matched "${report.symptom}".`,
      `Name one of: ${report.available.map((p) => p.id).join(', ')}; for example /doctor stuck turn.`,
    ];
  }
  const lines: string[] = [];
  for (const playbook of report.playbooks) {
    lines.push(`${playbook.name}`);
    for (const check of playbook.checks) {
      lines.push(`  ${check.outcome.toUpperCase().padEnd(7)} ${check.label}: ${check.summary}`);
    }
    const failing = playbook.checks.some((check) => check.outcome === 'fail');
    lines.push(failing ? '  Next:' : '  If it still happens:');
    for (const step of playbook.steps) lines.push(`    ${step.step}. ${step.title}: ${step.action}`);
  }
  return lines;
}

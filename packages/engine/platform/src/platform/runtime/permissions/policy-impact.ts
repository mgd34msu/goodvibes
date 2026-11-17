/**
 * What a candidate policy bundle would change on this installation: the
 * calls the permission audit recorded here, decided again under the active
 * rules and under the candidate's, by code (no model request; the calls were
 * already classified when they were made). The operator reviews this list,
 * with the rule diff, before promoting; nothing here is a threshold.
 *
 * Each call is rebuilt in the shape its tool declares (a command for exec, a
 * URL for fetch, a path for the file tools) and carries its subjects, so the
 * rules read the same arguments the live gate reads.
 */
import { LayeredPolicyEvaluator } from './evaluator.js';
import type { CommandClassification } from './normalization/types.js';
import type { PolicyRule } from './types.js';
import type { CallSubjects } from './types.js';
import type { PermissionAuditEntry } from './policy-runtime.js';

export interface PolicyImpactCall {
  readonly callId: string;
  readonly tool: string;
  readonly target: string;
  readonly before: 'allow' | 'deny';
  readonly after: 'allow' | 'deny';
  /** The candidate rule that decided it, when one did. */
  readonly rule?: string | undefined;
}

export interface PolicyImpact {
  /** Recorded calls decided again. */
  readonly checkedCalls: number;
  /** Recorded calls with no target to decide on, skipped. */
  readonly skippedCalls: number;
  /** The calls the candidate decides differently, newest first. */
  readonly changed: readonly PolicyImpactCall[];
}

const CLASSIFICATIONS: ReadonlySet<string> = new Set(['read', 'write', 'network', 'destructive', 'escalation']);

function classificationOf(entry: PermissionAuditEntry): CommandClassification {
  if (CLASSIFICATIONS.has(entry.classification)) return entry.classification as CommandClassification;
  if (entry.category === 'read') return 'read';
  if (entry.category === 'network' || entry.tool === 'fetch' || entry.tool === 'web_search') return 'network';
  return 'write';
}

function hostOf(target: string): string | undefined {
  try { return new URL(target).hostname || undefined; } catch { return undefined; }
}

/** The call as its tool declares it, and the subjects the gate reads from that declaration. */
function rebuildCall(entry: PermissionAuditEntry): { readonly args: Record<string, unknown>; readonly subjects: CallSubjects } | null {
  const target = entry.target?.trim();
  if (!target) return null;
  if (entry.tool === 'exec' || entry.category === 'execute') {
    return { args: { commands: [{ cmd: target }] }, subjects: { commands: [target] } };
  }
  if (entry.tool === 'fetch') {
    const host = entry.host ?? hostOf(target);
    return { args: { urls: [{ url: target }] }, subjects: host ? { hosts: [host] } : {} };
  }
  return { args: { path: target }, subjects: { paths: [target] } };
}

function decidingRule(decision: ReturnType<LayeredPolicyEvaluator['evaluate']>): string | undefined {
  const step = [...decision.evaluationTrace].reverse().find((entry) => entry.matched && entry.detail);
  return step?.detail;
}

export function policyImpact(input: {
  readonly currentRules: readonly PolicyRule[];
  readonly candidateRules: readonly PolicyRule[];
  readonly projectRoot: string;
  readonly calls: readonly PermissionAuditEntry[];
}): PolicyImpact {
  const config = (rules: readonly PolicyRule[]) => ({ mode: 'default' as const, projectRoot: input.projectRoot, rules: [...rules], defaultEffect: 'allow' as const });
  const current = new LayeredPolicyEvaluator(config(input.currentRules));
  const candidate = new LayeredPolicyEvaluator(config(input.candidateRules));
  const changed: PolicyImpactCall[] = [];
  let checked = 0, skipped = 0;
  for (const entry of input.calls) {
    const call = rebuildCall(entry);
    if (!call) { skipped++; continue; }
    checked++;
    const classification = classificationOf(entry);
    const before = current.evaluate(entry.tool, call.args, classification, call.subjects);
    const after = candidate.evaluate(entry.tool, call.args, classification, call.subjects);
    if (before.allowed === after.allowed) continue;
    const rule = decidingRule(after) ?? decidingRule(before);
    changed.push({
      callId: entry.callId, tool: entry.tool, target: entry.target!.trim(),
      before: before.allowed ? 'allow' : 'deny', after: after.allowed ? 'allow' : 'deny',
      ...(rule ? { rule } : {}),
    });
  }
  return { checkedCalls: checked, skippedCalls: skipped, changed };
}

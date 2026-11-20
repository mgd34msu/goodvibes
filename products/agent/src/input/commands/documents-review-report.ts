/**
 * The owner's own reports of the review packet lanes (`/documents readiness`,
 * `packet-steps`, `timeline`): short and in plain words, with an id only where
 * the line that acts on it needs one. A model reads the same lanes as JSON
 * through `agent_harness mode:"document_ops_lane"`; this is not that form.
 */
import type { DocumentOpsLane, ReviewerReadinessCheck } from '../../tools/agent-harness-document-ops-types.ts';
import type { AgentWorkspaceReviewPacketWizardStep } from '../agent-workspace-types.ts';

const CHECK_WORD: Readonly<Record<ReviewerReadinessCheck['status'], string>> = {
  pass: 'clear',
  attention: 'to settle',
  'needs-setup': 'needs setting up',
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatReviewReadiness(lane: DocumentOpsLane | undefined): string {
  const readiness = lane?.reviewerReadiness;
  if (!readiness) return 'Review readiness could not be read in this Agent.';
  const open = readiness.checks.filter((check) => check.status !== 'pass');
  const clear = readiness.checks.filter((check) => check.status === 'pass');
  const lines = [open.length === 0
    ? 'Ready for review: nothing stands in the way.'
    : `Not ready for review: ${plural(open.length, 'thing')} to settle first.`];
  for (const check of open) {
    lines.push(`  ${check.label} (${CHECK_WORD[check.status]}): ${check.detail}`);
    if (check.ownerLine) lines.push(`    Fix: ${check.ownerLine}`);
  }
  if (clear.length > 0) lines.push(`  Clear: ${clear.map((check) => check.label).join(', ')}.`);
  for (const problem of readiness.readProblems ?? []) lines.push(`  Not fully read: ${problem}.`);
  return lines.join('\n');
}

function stepLine(step: AgentWorkspaceReviewPacketWizardStep, index: number, current: string | null): string[] {
  const head = `  ${index + 1}. ${step.label}`;
  if (step.status === 'done') return [`${head}: done. ${step.detail}`];
  if (step.status === 'blocked') return [`${head}: waits for the step before it.`];
  if (step.status === 'pending') return [`${head}: after ${current ?? 'the current step'}. ${step.detail}`];
  return [`${head}: now. ${step.detail}`, `     ${step.ownerLine}`];
}

export function formatReviewPacketSteps(lane: DocumentOpsLane | undefined): string {
  const wizard = lane?.reviewPacketWizard;
  if (!wizard) return 'The review packet steps could not be read in this Agent.';
  const lines = [wizard.status === 'complete'
    ? `Review packet: all ${wizard.totalSteps} steps done.`
    : `Review packet: ${wizard.completedSteps} of ${wizard.totalSteps} steps done${wizard.currentStepLabel ? `; next is ${wizard.currentStepLabel}` : ''}.`];
  if (!wizard.available) lines.push('  Your saved artifacts could not be read, so steps that depend on them are shown as waiting.');
  wizard.steps.forEach((step, index) => lines.push(...stepLine(step, index, wizard.currentStepLabel)));
  const last = wizard.steps.at(-1);
  if (wizard.status === 'complete' && last) lines.push(`  To send it: ${last.ownerLine}`);
  return lines.join('\n');
}

function when(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 'unknown time    ';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatReviewPacketTimeline(lane: DocumentOpsLane | undefined): string {
  const timeline = lane?.reviewPacketTimeline;
  if (!timeline) return 'The review packet timeline could not be read in this Agent.';
  if (!timeline.available && timeline.items.length === 0) return `No timeline: your saved artifacts could not be read. ${timeline.next}`;
  if (timeline.items.length === 0) return 'Nothing has happened to a review packet yet: no draft, comment, export, comparison or handoff.';
  const items = [...timeline.items].sort((left, right) => left.at - right.at);
  const lines = [`Review packet timeline, oldest first (${plural(timeline.count, 'event')}${timeline.count > items.length ? `, the latest ${items.length} shown` : ''}):`];
  for (const item of items) {
    const detail = item.detail && item.detail !== item.label ? `: ${item.detail}` : '';
    lines.push(`  ${when(item.at)}  ${item.label}${detail}${item.status === 'attention' ? ' (needs you)' : ''}`);
  }
  if (!timeline.available) lines.push('  Your saved artifacts could not be read, so events from them are missing.');
  return lines.join('\n');
}

/**
 * live-progress.ts — Shared live step progress line for running daemon Work /
 * contracts when no explicit pause, escalation, or terminal `statusLine` is set.
 *
 * Used by both `control-plane/routes/work.ts` (`work.list` -> TUI, agent,
 * WebUI Work place, `work` capability) and `contract/operator-service.ts`
 * (`summarizeContract` -> WebUI contract details & contract-work adapters) so
 * every surface reports the same live step status automatically.
 */
import type { ContractView } from './types.js';
import { isTerminalContractStatus } from './types.js';

export interface LiveProgressStep {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function shortStepTitle(raw: string): string {
  const first = raw.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? raw.trim();
  return first.length > 64 ? `${first.slice(0, 61)}...` : first;
}

/** Concise one-line live progress from a contract's steps while running. */
export function formatLiveStepProgress(steps: readonly LiveProgressStep[]): string {
  if (steps.length === 0) return 'Planning steps on the daemon';
  const done = steps.filter((step) => {
    const status = text(step.status);
    return status === 'passed' || status === 'completed';
  }).length;
  const running = steps.filter((step) => text(step.status) === 'running');
  const checking = steps.filter((step) => {
    const status = text(step.status);
    return status === 'nudged' || status === 'checking';
  });
  const count = `${done}/${steps.length} steps done`;
  const namesOf = (entries: readonly LiveProgressStep[]): string => entries
    .slice(0, 2)
    .map((step) => shortStepTitle(text(step.title) || text(step.id)))
    .filter(Boolean)
    .join(', ');
  if (running.length > 0) {
    const more = running.length > 2 ? ` (+${running.length - 2} more)` : '';
    return `${count} · running: ${namesOf(running)}${more}`;
  }
  if (checking.length > 0) {
    return `${count} · checking: ${namesOf(checking)}`;
  }
  return done >= steps.length ? `${count} · finalizing on the daemon` : `${count} · running on the daemon`;
}

/**
 * Derive a live `statusLine` for a non-terminal contract that has no explicit
 * pause/error/completion `statusLine` yet. Returns `undefined` for terminal
 * contracts or when `contract.statusLine` is already populated.
 */
export function liveContractStatusLine(contract: Pick<ContractView, 'status' | 'statusLine' | 'units'>): string | undefined {
  if (contract.statusLine || isTerminalContractStatus(contract.status)) return undefined;
  return formatLiveStepProgress(contract.units.map((unit) => ({
    id: unit.id,
    title: unit.title || unit.brief || unit.id,
    status: unit.status,
  })));
}

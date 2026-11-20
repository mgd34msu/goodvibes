/**
 * A report action's short status: one line when all is well, else one line
 * per thing that needs attention with how to fix it under it. The terminal
 * prints it with this one function; the web sheet shows the same fields.
 */
import type { CommandReport } from './types.js';

export function isCommandReport(value: unknown): value is CommandReport {
  return typeof value === 'object' && value !== null && 'verdict' in value && 'headline' in value && 'items' in value;
}

/** `✓ Everything is working.`, or `✕ <sentence>` rows each with `  Fix: <line>` under it. */
export function renderCommandReport(report: CommandReport): string {
  if (report.verdict === 'ok' && report.items.length === 0) return `✓ ${report.headline}`;
  const lines = [report.verdict === 'ok' ? `✓ ${report.headline}` : report.headline];
  for (const item of report.items) {
    lines.push(`✕ ${item.sentence}`);
    if (item.fix) lines.push(`  Fix: ${item.fix.line}${item.fix.label && item.fix.label !== item.fix.line ? `  (${item.fix.label})` : ''}`);
  }
  return lines.join('\n');
}

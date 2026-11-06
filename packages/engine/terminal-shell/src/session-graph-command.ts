import type { CrossSessionTaskRef } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { ShellSessionOrchestrationService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { statusBadge } from './task-presentation.js';
export function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}
export function fmtRef(ref: CrossSessionTaskRef): string {
  const key = `${ref.sessionId.slice(0, 8)}...:${ref.taskId.slice(0, 8)}...`;
  const label = ref.label ? ` [${ref.label}]` : '';
  return `${statusBadge(ref.status)} ${key}${label}  "${ref.title}"`;
}
export function createSessionGraphHandler<Context extends { readonly print: (message: string) => void }>(
  requireSessionOrchestration: (
    context: Context,
  ) => Pick<ShellSessionOrchestrationService, 'snapshot' | 'getDependencies' | 'getDependents' | 'getHandoffs'>,
  emptyGraph: string,
) {
  function handleGraph(args: string[], context: Context): void {
    const filterSession = flagValue(args, '--session');
    const format = flagValue(args, '--format') ?? 'text';

    const orchestration = requireSessionOrchestration(context);
    const snap = orchestration.snapshot();

    const refs = Object.values(snap.refs);
    const filteredRefs = filterSession ? refs.filter((r) => r.sessionId === filterSession) : refs;

    if (format === 'json') {
      context.print(JSON.stringify(snap, null, 2));
      return;
    }

    // ── Text display ─────────────────────────────────────────────────────────────

    if (filteredRefs.length === 0) {
      if (filterSession) {
        context.print(`[session] No tasks registered for session ${filterSession.slice(0, 8)}...`);
      } else {
        context.print(emptyGraph);
      }
      return;
    }

    const lines: string[] = [`[session] Cross-session task graph (${filteredRefs.length} task${filteredRefs.length !== 1 ? 's' : ''}):`];

    // Group by session for readability
    const bySession = new Map<string, CrossSessionTaskRef[]>();
    for (const ref of filteredRefs) {
      const group = bySession.get(ref.sessionId) ?? [];
      group.push(ref);
      bySession.set(ref.sessionId, group);
    }

    for (const [sid, sessionRefs] of bySession) {
      lines.push(`  Session ${sid.slice(0, 16)}...`);
      for (const ref of sessionRefs) {
        lines.push(`    ${fmtRef(ref)}`);

        // Show dependencies
        const deps = orchestration.getDependencies(ref.sessionId, ref.taskId);
        for (const dep of deps) {
          lines.push(
            `      depends-on: ${statusBadge(dep.status)} ${dep.sessionId.slice(0, 8)}...:${dep.taskId.slice(0, 8)}...  "${dep.title}"`,
          );
        }

        // Show dependents
        const dependents = orchestration.getDependents(ref.sessionId, ref.taskId);
        for (const d of dependents) {
          lines.push(`      depended-by: ${statusBadge(d.status)} ${d.sessionId.slice(0, 8)}...:${d.taskId.slice(0, 8)}...  "${d.title}"`);
        }
      }
    }

    // Handoffs summary
    const handoffs = orchestration.getHandoffs();
    const filteredHandoffs = filterSession
      ? handoffs.filter((h) => h.fromSessionId === filterSession || h.toSessionId === filterSession)
      : handoffs;

    if (filteredHandoffs.length > 0) {
      lines.push(`  Handoffs (${filteredHandoffs.length}):`);
      for (const h of filteredHandoffs) {
        const ack = h.acknowledged ? 'ack' : 'pending';
        lines.push(
          `    ${h.handoffId.slice(0, 8)}...  ` +
            `${h.fromSessionId.slice(0, 8)}... → ${h.toSessionId.slice(0, 8)}...  ` +
            `task:${h.taskRef.taskId.slice(0, 8)}...  [${ack}]` +
            (h.reason ? `  reason: ${h.reason}` : ''),
        );
      }
    }

    context.print(lines.join('\n'));
  }
  return handleGraph;
}

import type { CrossSessionTaskRef } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { ShellSessionOrchestrationService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { statusBadge } from './task-presentation.js';
export function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1]!;
  // The next token is another flag, so this one has no value.
  return value.startsWith('--') ? undefined : value;
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
    const requestedSession = flagValue(args, '--session');
    const format = flagValue(args, '--format') ?? 'text';

    const orchestration = requireSessionOrchestration(context);
    const snap = orchestration.snapshot();

    const refs = Object.values(snap.refs);
    // The text view shows shortened ids, so a prefix of a registered session id
    // selects it; an exact id always wins.
    let filterSession = requestedSession;
    if (requestedSession) {
      const ids = [...new Set(refs.map((r) => r.sessionId))];
      const matches = ids.includes(requestedSession) ? [requestedSession] : ids.filter((id) => id.startsWith(requestedSession));
      if (matches.length > 1) {
        context.print(`[session] Ambiguous session: ${requestedSession}. Use more of the id: ${matches.join(', ')}`);
        return;
      }
      filterSession = matches[0] ?? requestedSession;
    }
    const filteredRefs = filterSession ? refs.filter((r) => r.sessionId === filterSession) : refs;

    if (format === 'json') {
      if (!filterSession) {
        context.print(JSON.stringify(snap, null, 2));
        return;
      }
      const scoped = {
        ...snap,
        refs: Object.fromEntries(Object.entries(snap.refs).filter(([, ref]) => ref.sessionId === filterSession)),
        edges: snap.edges.filter((e) => e.fromRef.sessionId === filterSession || e.toRef.sessionId === filterSession),
        handoffs: snap.handoffs.filter((h) => h.fromSessionId === filterSession || h.toSessionId === filterSession),
      };
      context.print(JSON.stringify(scoped, null, 2));
      return;
    }

    // ── Text display ─────────────────────────────────────────────────────────────

    if (filteredRefs.length === 0) {
      if (filterSession) {
        context.print(`[session] No tasks registered for session ${filterSession}`);
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
      lines.push(`  Session ${sid}`);
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

import type { CrossSessionTaskRef, CrossSessionTaskRegistry, TaskHandoffRecord } from '@goodvibes-jev/engine/platform/platform/sessions';
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
/** One handoff line of the text view: who it waits on and what can be done. */
function fmtHandoff(h: TaskHandoffRecord, currentSession: string | undefined): string {
  let state = h.acknowledged ? 'ack' : 'pending';
  if (!h.acknowledged && currentSession === h.toSessionId) state = 'pending, awaiting this session: /session accept ' + h.handoffId;
  else if (!h.acknowledged && currentSession === h.fromSessionId) state = 'pending, take it back with /session withdraw ' + h.handoffId;
  return `    ${h.handoffId.slice(0, 8)}...  ` +
    `${h.fromSessionId.slice(0, 8)}... → ${h.toSessionId.slice(0, 8)}...  ` +
    `task:${h.taskRef.taskId.slice(0, 8)}...  [${state}]` +
    (h.reason ? `  reason: ${h.reason}` : '');
}

/**
 * `/session graph`. `currentSession` names the session the command runs in,
 * so handoffs waiting for it, or made by it, say what can be done with them.
 */
export function createSessionGraphHandler<Context extends { readonly print: (message: string) => void }>(
  requireSessionOrchestration: (
    context: Context,
  ) => Pick<ShellSessionOrchestrationService, 'snapshot' | 'getDependencies' | 'getDependents' | 'getHandoffs'>,
  emptyGraph: string,
  currentSession?: (context: Context) => string | undefined,
) {
  function handleGraph(args: string[], context: Context): void {
    const requestedSession = flagValue(args, '--session');
    const format = flagValue(args, '--format') ?? 'text';

    const orchestration = requireSessionOrchestration(context);
    const snap = orchestration.snapshot();
    const current = currentSession?.(context);

    const refs = Object.values(snap.refs);
    // The text view shows shortened ids, so a prefix of a registered session id
    // selects it; an exact id always wins.
    let filterSession = requestedSession;
    if (requestedSession) {
      const ids = [...new Set([...refs.map((r) => r.sessionId), ...snap.handoffs.map((h) => h.toSessionId)])];
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

    // A handoff addressed to a session lists there even when that session owns no task yet.
    const filteredHandoffs = filterSession
      ? snap.handoffs.filter((h) => h.fromSessionId === filterSession || h.toSessionId === filterSession)
      : snap.handoffs;

    if (filteredRefs.length === 0 && filteredHandoffs.length === 0) {
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

    if (filteredHandoffs.length > 0) {
      lines.push(`  Handoffs (${filteredHandoffs.length}):`);
      for (const h of filteredHandoffs) lines.push(fmtHandoff(h, current));
    }

    context.print(lines.join('\n'));
  }
  return handleGraph;
}

/** What `/session accept` and `/session withdraw` need from the task graph. */
export type SessionHandoffPort = Pick<CrossSessionTaskRegistry, 'getHandoffs' | 'acknowledgeHandoff' | 'withdrawHandoff'>;

/** Find a handoff by full id or by the shortened id the graph view prints. */
function resolveHandoff(handoffs: readonly TaskHandoffRecord[], given: string): TaskHandoffRecord | string {
  const prefix = given.replace(/\.+$/, '');
  const exact = handoffs.find((h) => h.handoffId === prefix);
  if (exact) return exact;
  const matches = handoffs.filter((h) => h.handoffId.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) return `Ambiguous handoff: ${given}. Use more of the id: ${matches.map((h) => h.handoffId).join(', ')}`;
  return `Unknown handoff: ${given}. Nothing was changed. See /session graph for the handoffs.`;
}

/**
 * `/session accept <handoffId>` (the destination session takes the task, which
 * goes back to the status it had in its source session) and
 * `/session withdraw <handoffId>` (the source session takes it back).
 */
export function createSessionHandoffHandlers<Context extends { readonly print: (message: string) => void }>(
  requireSessionOrchestration: (context: Context) => SessionHandoffPort,
  currentSession: (context: Context) => string,
) {
  function handleAccept(args: string[], context: Context): void {
    const given = args[0];
    if (!given) { context.print('[session] Usage: /session accept <handoffId>'); return; }
    const orchestration = requireSessionOrchestration(context);
    const found = resolveHandoff(orchestration.getHandoffs(), given);
    if (typeof found === 'string') { context.print(`[session] ${found}`); return; }
    const session = currentSession(context);
    if (found.toSessionId !== session) {
      context.print(`[session] Handoff ${found.handoffId} is addressed to session ${found.toSessionId}; only that session can accept it. Nothing was changed.`);
      return;
    }
    if (found.acknowledged) { context.print(`[session] Handoff ${found.handoffId} was already accepted.`); return; }
    if (!orchestration.acknowledgeHandoff(found.handoffId, session)) {
      context.print(`[session] Handoff ${found.handoffId} is no longer waiting (its source withdrew it, or it expired). Nothing was changed.`);
      return;
    }
    context.print(`[session] Accepted handoff ${found.handoffId}: task ${found.taskRef.taskId} from session ${found.fromSessionId} is no longer blocked.`);
  }

  function handleWithdraw(args: string[], context: Context): void {
    const given = args[0];
    if (!given) { context.print('[session] Usage: /session withdraw <handoffId>'); return; }
    const orchestration = requireSessionOrchestration(context);
    const found = resolveHandoff(orchestration.getHandoffs(), given);
    if (typeof found === 'string') { context.print(`[session] ${found}`); return; }
    const result = orchestration.withdrawHandoff(found.handoffId, currentSession(context));
    if (!result.ok) { context.print(`[session] ${result.error ?? 'The handoff could not be withdrawn. Nothing was changed.'}`); return; }
    context.print(`[session] Withdrew handoff ${found.handoffId}: task ${found.taskRef.taskId} is ${result.status ?? 'unblocked'} again.`);
  }

  return { handleAccept, handleWithdraw };
}

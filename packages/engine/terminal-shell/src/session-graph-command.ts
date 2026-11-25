import type { CrossSessionTaskRef, TaskHandoffRecord } from '@goodvibes/engine/platform/platform/sessions';
import type { ShellSessionOrchestrationService } from '@goodvibes/engine/platform/platform/runtime/shell';
export function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1]!;
  // The next token is another flag, so this one has no value.
  return value.startsWith('--') ? undefined : value;
}

/** A task as a person reads it: its label or title, its own id after it when that says something more, and its state. */
function taskWords(ref: Pick<CrossSessionTaskRef, 'taskId' | 'title' | 'label' | 'status'>): string {
  const name = ref.label || ref.title || ref.taskId;
  return `${name}${name === ref.taskId ? '' : ` (${ref.taskId})`}, ${ref.status}`;
}

/**
 * The cross-session task graph as text (session.graph), in the words of the Sessions place's Hand-offs list: each
 * session by its title (`nameOf`: "this session", a saved session's title, else its whole id), each task by its label
 * and id, what it waits on and what waits on it, and the hand-offs waiting with what can be done about them. No id is
 * cut short. JSON (`format: json`) is the graph as data, every id whole. `currentSession` names the session the
 * view is read in, so a hand-off waiting for it, or made by it, says what can be done with it.
 */
export function createSessionGraphHandler<Context extends { readonly print: (message: string) => void }>(
  requireSessionOrchestration: (
    context: Context,
  ) => Pick<ShellSessionOrchestrationService, 'snapshot' | 'getDependencies' | 'getDependents' | 'getHandoffs'>,
  emptyGraph: string,
  currentSession?: (context: Context) => string | undefined,
  nameOf?: (context: Context, sessionId: string) => string,
) {
  function handleGraph(input: { readonly session?: string | undefined; readonly format?: string | undefined }, context: Context): void {
    const requestedSession = input.session || undefined;
    const format = input.format || 'text';

    const orchestration = requireSessionOrchestration(context);
    const snap = orchestration.snapshot();
    const current = currentSession?.(context);
    const name = (id: string): string => id === current ? 'this session' : nameOf?.(context, id) ?? `session ${id}`;

    const refs = Object.values(snap.refs);
    // A session is named by its id or the start of one; an exact id always wins.
    let filterSession = requestedSession;
    if (requestedSession) {
      const ids = [...new Set([...refs.map((r) => r.sessionId), ...snap.handoffs.map((h) => h.toSessionId)])];
      const matches = ids.includes(requestedSession) ? [requestedSession] : ids.filter((id) => id.startsWith(requestedSession));
      if (matches.length > 1) {
        context.print(`More than one session's id starts with ${requestedSession}: ${matches.map((id) => `${name(id)} (${id})`).join(', ')}. Give more of the id.`);
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

    // A handoff addressed to a session lists there even when that session owns no task yet; one already accepted is history.
    const waiting = (filterSession
      ? snap.handoffs.filter((h) => h.fromSessionId === filterSession || h.toSessionId === filterSession)
      : snap.handoffs).filter((h) => !h.acknowledged);

    if (filteredRefs.length === 0 && waiting.length === 0) {
      context.print(filterSession ? `No task of ${name(filterSession)} is in the cross-session task graph.` : emptyGraph);
      return;
    }

    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const lines: string[] = [`The tasks handed between sessions in this project: ${plural(filteredRefs.length, 'task')}${waiting.length > 0 ? `, ${plural(waiting.length, 'hand-off')} waiting` : ''}.`];

    // Grouped by session, this one first.
    const bySession = new Map<string, CrossSessionTaskRef[]>();
    for (const ref of [...filteredRefs].sort((a, b) => Number(b.sessionId === current) - Number(a.sessionId === current))) {
      const group = bySession.get(ref.sessionId) ?? [];
      group.push(ref);
      bySession.set(ref.sessionId, group);
    }
    for (const [sid, sessionRefs] of bySession) {
      const named = name(sid);
      lines.push('', `${named.charAt(0).toUpperCase()}${named.slice(1)}:`);
      for (const ref of sessionRefs) {
        lines.push(`  ${taskWords(ref)}`);
        for (const dep of orchestration.getDependencies(ref.sessionId, ref.taskId)) {
          lines.push(`    waits on ${taskWords(dep)}${dep.sessionId === ref.sessionId ? '' : `, in ${name(dep.sessionId)}`}`);
        }
        for (const d of orchestration.getDependents(ref.sessionId, ref.taskId)) {
          lines.push(`    waited on by ${taskWords(d)}${d.sessionId === ref.sessionId ? '' : `, in ${name(d.sessionId)}`}`);
        }
      }
    }

    if (waiting.length > 0) {
      lines.push('', 'Hand-offs waiting:');
      for (const h of waiting) lines.push(`  ${handoffWords(h)}`);
    }
    context.print(lines.join('\n'));

    /** One waiting hand-off: what, from whom to whom, and what can be done with it here. */
    function handoffWords(h: TaskHandoffRecord): string {
      const task = snap.refs[`${h.taskRef.sessionId}:${h.taskRef.taskId}`];
      const what = task ? task.label || task.title || h.taskRef.taskId : h.taskRef.taskId;
      const next = current === h.toSessionId ? ' It waits for this session: accept it on Sessions, Hand-offs.'
        : current === h.fromSessionId ? ' This session can take it back on Sessions, Hand-offs.'
        : ' It waits for that session to accept it.';
      return `${what} (${h.taskRef.taskId}), from ${name(h.fromSessionId)} to ${name(h.toSessionId)}.${h.reason ? ` Why: ${h.reason.trim().replace(/[.!?]+$/, '')}.` : ''}${next}`;
    }
  }
  return handleGraph;
}

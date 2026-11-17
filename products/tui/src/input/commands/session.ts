import { createSessionGraphHandler, flagValue } from '@goodvibes-jev/engine/terminal-shell/session-graph-command';
/**
 * /session command handler, Multi-session Orchestration.
 *
 * Implements session and workflow commands:
 *
 *   /session link-task <taskId> [--session <sessionId>] [--depends-on <ref>] [--label <label>]
 *    , Register a task as a global cross-session ref, optionally linking it to a
 *       dependency.
 *
 *   /session handoff <taskId> --to <sessionId> [--session <sessionId>] [--reason <reason>]
 *    , Initiate a task handoff from the current session to another.
 *
 *   /session graph [--session <sessionId>] [--format text|json]
 *    , Display the cross-session task dependency graph.
 *
 *   /session cancel <taskId|--scope session> [--session <sessionId>] [--scope task|subtree|session]
 *    , Cancel tasks with configurable scope semantics.
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import type { CancellationScope, CrossSessionTaskRef } from '@goodvibes-jev/engine/platform/platform/sessions';
import { VALID_SCOPES } from '@goodvibes-jev/engine/platform/platform/sessions';
import { handleSessionWorkflowCommand } from './session-workflow.ts';
import { requireSessionOrchestration, requireSessionManager } from './runtime-services.ts';

// ── Argument parsing helpers ──────────────────────────────────────────────────

/**
 * Extract a named flag value from args (e.g. `--to <value>`).
 * Returns undefined if the flag is not present.
 */

/**
 * Parse a cross-session task ref from a string of the form
 * `<sessionId>:<taskId>` or just `<taskId>` (uses currentSessionId as owner).
 */
function parseRef(raw: string, currentSessionId: string): { sessionId: string; taskId: string } {
  const parts = raw.split(':', 2);
  if (parts.length === 2) {
    return { sessionId: parts[0]!, taskId: parts[1]! };
  }
  return { sessionId: currentSessionId, taskId: raw };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Status badge for display. */

/** Format a ref as a compact one-line string. */

// ── /session link-task ────────────────────────────────────────────────────────

function handleLinkTask(args: string[], context: CommandContext): void {
  const taskId = args[0];
  if (!taskId) {
    context.print(
      '[session] Usage: /session link-task <taskId> [--session <sessionId>] ' + '[--depends-on <sessionId:taskId>] [--label <label>]',
    );
    return;
  }

  // Defense-in-depth: parser splits on whitespace but guard against future changes
  if (!taskId.trim()) {
    context.print('Error: taskId cannot be empty or whitespace.');
    return;
  }

  if (taskId.includes(':')) {
    context.print('Error: taskId cannot contain ":"; it conflicts with the composite key format.');
    return;
  }

  const sessionId = flagValue(args, '--session') ?? context.session.runtime.sessionId;
  const dependsOnRaw = flagValue(args, '--depends-on');
  const label = flagValue(args, '--label');

  const orchestration = requireSessionOrchestration(context);

  const ref: CrossSessionTaskRef = {
    sessionId,
    taskId,
    title: label ?? taskId,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    label,
  };

  const dependsOn = dependsOnRaw ? parseRef(dependsOnRaw, sessionId) : undefined;

  const result = orchestration.linkTask(ref, dependsOn);

  if (!result.ok) {
    context.print(`[session] link-task failed: ${result.error}`);
    return;
  }

  context.print(
    `[session] Task linked: ${sessionId.slice(0, 8)}...:${taskId}` +
      (label ? ` [${label}]` : '') +
      (dependsOn ? ` → depends on ${dependsOnRaw}` : ''),
  );
}

// ── /session handoff ──────────────────────────────────────────────────────────

/** Handoffs still waiting for their destination session, one line each; empty when none. */
function pendingHandoffLines(context: CommandContext): string[] {
  const pending = requireSessionOrchestration(context).getHandoffs().filter((handoff) => !handoff.acknowledged);
  if (pending.length === 0) return [];
  return [
    `[session] Handoffs waiting (${pending.length}): accept with /session handoff accept <handoffId>, decline with /session handoff reject <handoffId>`,
    ...pending.map((handoff) =>
      `  ${handoff.handoffId}  task ${handoff.taskRef.taskId}  ${handoff.fromSessionId.slice(0, 8)}... -> ${handoff.toSessionId.slice(0, 8)}...`
      + (handoff.reason ? `  reason: ${handoff.reason}` : '')),
  ];
}

/**
 * `/session handoff accept|reject <handoffId>`: the owner ends a handoff from
 * the terminal. Accept completes it for its destination session (the task is
 * released from "blocked"); reject withdraws it (the task returns to the status
 * it had before). Typed by the owner, who speaks for every session of theirs.
 */
function handleHandoffAnswer(verb: 'accept' | 'reject', args: string[], context: CommandContext): void {
  const handoffId = args[0];
  if (!handoffId) {
    const pending = pendingHandoffLines(context);
    context.print([`[session] Usage: /session handoff ${verb} <handoffId>`, ...(pending.length > 0 ? pending : ['[session] No handoffs are waiting.'])].join('\n'));
    return;
  }
  const orchestration = requireSessionOrchestration(context);
  const handoff = orchestration.getHandoffs().find((record) => record.handoffId === handoffId);
  if (!handoff) {
    context.print(`[session] Unknown handoff: ${handoffId}. Nothing was changed. /session handoff list shows the waiting ones.`);
    return;
  }
  if (handoff.acknowledged) {
    context.print(`[session] Handoff ${handoffId} was already accepted by session ${handoff.toSessionId}. Nothing was changed.`);
    return;
  }
  if (verb === 'accept') {
    if (!orchestration.acknowledgeHandoff(handoffId)) {
      context.print(`[session] Handoff ${handoffId} is no longer waiting (withdrawn or expired). Nothing was changed.`);
      return;
    }
    context.print(`[session] Handoff ${handoffId} accepted for session ${handoff.toSessionId}: task ${handoff.taskRef.taskId} is no longer blocked.`);
    return;
  }
  const result = orchestration.withdrawHandoff(handoffId);
  if (!result.ok) {
    context.print(`[session] ${result.error ?? `Handoff ${handoffId} could not be rejected.`}`);
    return;
  }
  context.print(`[session] Handoff ${handoffId} rejected: task ${handoff.taskRef.taskId} stays with session ${handoff.fromSessionId}${result.status ? ` (status ${result.status})` : ''}.`);
}

function handleHandoff(args: string[], context: CommandContext): void {
  if (args[0] === 'accept' || args[0] === 'reject') {
    handleHandoffAnswer(args[0], args.slice(1), context);
    return;
  }
  if (args[0] === 'list') {
    const pending = pendingHandoffLines(context);
    context.print(pending.length > 0 ? pending.join('\n') : '[session] No handoffs are waiting.');
    return;
  }
  const taskId = args[0];
  const toSessionId = flagValue(args, '--to');
  const fromSessionId = flagValue(args, '--session') ?? context.session.runtime.sessionId;
  const reason = flagValue(args, '--reason');

  if (!taskId || !toSessionId) {
    context.print('[session] Usage: /session handoff <taskId> --to <sessionId> ' + '[--session <fromSessionId>] [--reason <reason>]');
    return;
  }

  const orchestration = requireSessionOrchestration(context);

  const result = orchestration.initiateHandoff({ sessionId: fromSessionId, taskId }, fromSessionId, toSessionId, reason);

  if (!result.ok) {
    context.print(`[session] handoff failed: ${result.error}`);
    return;
  }

  context.print(
    `[session] Handoff initiated: ${taskId} (${fromSessionId.slice(0, 8)}...) → (${toSessionId.slice(0, 8)}...)` +
      (reason ? `  reason: ${reason}` : '') +
      `\n[session] handoffId: ${result.handoffId}` +
      `\n[session] The task is blocked until the destination session accepts it: /session handoff accept ${result.handoffId} (or reject to take it back).`,
  );
}

// ── /session graph ────────────────────────────────────────────────────────────

// ── /session cancel ───────────────────────────────────────────────────────────

function handleCancel(args: string[], context: CommandContext): void {
  const scopeRaw = flagValue(args, '--scope');
  if (scopeRaw && !VALID_SCOPES.includes(scopeRaw as CancellationScope)) {
    context.print(`Invalid --scope: "${scopeRaw}". Valid: ${VALID_SCOPES.join(', ')}`);
    return;
  }
  const scope: CancellationScope = (scopeRaw as CancellationScope) ?? 'task';
  const sessionId = flagValue(args, '--session') ?? context.session.runtime.sessionId;
  const reason = flagValue(args, '--reason');

  // For session scope, taskId is not required
  const taskId = scope === 'session' ? undefined : args[0];

  if (scope !== 'session' && !taskId) {
    context.print(
      '[session] Usage: /session cancel <taskId> [--scope task|subtree|session] ' +
        '[--session <sessionId>] [--reason <reason>]\n' +
        '  --scope task     Cancel only this task (default)\n' +
        '  --scope subtree  Cancel this task and all tasks that transitively depend on it\n' +
        '  --scope session  Cancel all tasks in the session',
    );
    return;
  }

  const orchestration = requireSessionOrchestration(context);

  const result = orchestration.cancel({
    sessionId,
    taskId,
    scope,
    reason,
    requestedAt: Date.now(),
  });

  if (!result.ok) {
    context.print(`[session] cancel failed: ${result.error}`);
    return;
  }

  const lines: string[] = [
    `[session] Cancelled ${result.cancelled.length} task${result.cancelled.length !== 1 ? 's' : ''} ` + `(scope=${scope}):`,
  ];

  for (const t of result.cancelled) {
    lines.push(`  [x] ${t.sessionId.slice(0, 8)}...:${t.taskId.slice(0, 8)}...  "${t.title}"`);
  }

  if (result.skipped.length > 0) {
    lines.push(`  Skipped ${result.skipped.length} (already terminal):`);
    for (const s of result.skipped) {
      lines.push(`  [-] ${s.sessionId.slice(0, 8)}...:${s.taskId.slice(0, 8)}...  "${s.title}"  (${s.reason})`);
    }
  }

  context.print(lines.join('\n'));
}

// ── Top-level command definition ───────────────────────────────────────────────

/**
 * SESSION_SUBCOMMAND_ARG_HINTS, the single source of truth for each
 * `/session <subcommand>` argument hint, co-located with the switch below so
 * the two can't silently drift apart; the command carries it as `subcommands`,
 * where the composer reads it. Aliases (`link`, `ho`, `g`) share their
 * canonical subcommand's hint text.
 */
export const SESSION_SUBCOMMAND_ARG_HINTS: Record<string, string> = {
  list: '',
  rename: '<name>',
  resume: '<id|name>',
  fork: '[name]',
  save: '[name]',
  info: '[id]',
  export: '<id|.> [markdown|text] [--out <path>] [--print]',
  search: '<query>',
  delete: '<id>',
  events: '[kind] [start-row] [--last N]',
  groups: '[kind] [start-row] [--last N]',
  hotspots: '[kind]',
  'link-task': '<taskId> [--session <sid>] [--depends-on <sid:taskId>] [--label <label>]',
  link: '<taskId> [--session <sid>] [--depends-on <sid:taskId>] [--label <label>]',
  handoff: '<taskId> --to <sid> [--session <sid>] [--reason <reason>] | accept|reject <handoffId> | list',
  ho: '<taskId> --to <sid> [--session <sid>] [--reason <reason>] | accept|reject <handoffId> | list',
  graph: '[--session <sid>] [--format text|json]',
  g: '[--session <sid>] [--format text|json]',
  cancel: '<taskId> [--scope task|subtree|session] [--session <sid>] [--reason <reason>]',
};

/**
 * sessionCommand, The `/session` slash command.
 *
 * The ONE front-door for all session operations. Owns two domains:
 *
 * Lifecycle (continuity, export, resume, pruning):
 *   list | rename | resume | fork | save | info | events | groups | hotspots | export | search | delete
 *
 * Orchestration (cross-session task DAG, 40 tests, cycle detection):
 *   link-task | handoff | graph | cancel
 *
 * Orchestration-command decision (TASK-032):
 *   Both domains live under /session rather than splitting orchestration into
 *   a separate /session-orch command. Rationale: they share the same entity
 *   (a session) and the same operator mental model ("I am working with sessions").
 *   A second front-door would create ambiguity about which command to reach for.
 *   Explicit switch routing (not fallthrough) makes both domains first-class;
 *   the former /session-mgmt alias (session-mgmt/smgmt) is removed so there
 *   is exactly one registration and no silent shadowing.
 */
export const sessionCommand: SlashCommand = {
  name: 'session',
  aliases: ['sess'],
  description: 'Session lifecycle and orchestration: list, resume, fork, save, export, link-task, handoff, graph, cancel',
  usage: '<subcommand> [args]',
  argsHint: 'list|rename|resume|fork|save|info|export|search|delete|events|groups|hotspots|link-task|handoff|graph|cancel',
  // A new name is the rest of the line exactly as typed.
  rawRest: (args) => (args[0] === 'rename' && args.length === 1 ? 1 : undefined),
  subcommands: SESSION_SUBCOMMAND_ARG_HINTS,
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    switch (sub) {
      // ── Lifecycle subcommands ────────────────────────────────────────────────
      // Each delegates explicitly to handleSessionWorkflowCommand so every
      // subcommand has a deterministic, named path, no silent fallthrough.
      case 'list':
      case 'rename':
      case 'resume':
      case 'fork':
      case 'save':
      case 'info':
      case 'export':
      case 'search':
      case 'delete':
      case 'events':
      case 'groups':
      case 'hotspots':
        await handleSessionWorkflowCommand(args, context);
        break;

      // ── Orchestration subcommands ─────────────────────────────────────────────
      case 'link-task':
      case 'link':
        handleLinkTask(rest, context);
        break;

      case 'handoff':
      case 'ho':
        handleHandoff(rest, context);
        break;

      case 'graph':
      case 'g': {
        handleGraph(rest, context);
        // Waiting handoffs are listed under the graph so a blocked task shows what releases it.
        const pending = rest.includes('json') ? [] : pendingHandoffLines(context);
        if (pending.length > 0) context.print(pending.join('\n'));
        break;
      }

      case 'cancel':
        handleCancel(rest, context);
        break;

      // ── No-arg: show current session info ────────────────────────────────────
      case undefined:
        await handleSessionWorkflowCommand([], context);
        break;

      default: {
        const usage = [
          'Usage: /session <subcommand>',
          '',
          'Lifecycle:',
          '  list                                    — List saved sessions',
          '  rename <name>                           — Rename the current session',
          '  resume <id|name>                        — Resume a saved session',
          '  fork [name]                             — Fork the current session',
          '  save [name]                             — Save the current session',
          '  info [id]                               — Show session info',
          '  export <id|.> [markdown|text] [--out <path>] [--print]',
          '                                          — Write the redacted transcript to a file (or print it)',
          '  search <query>                          — Search session content',
          '  delete <id>                             — Delete a saved session',
          '  events [kind] [start-row] [--last N]    — Show transcript events (newest page by default)',
          '  groups [kind] [start-row] [--last N]    — Show transcript groups (newest page by default)',
          '  hotspots [kind]                         — Show transcript hotspots',
          '',
          'Orchestration:',
          '  link-task <taskId> [--session <sid>] [--depends-on <sid:taskId>] [--label <label>]',
          '                                          — Register a task in the cross-session graph',
          '  handoff <taskId> --to <sid> [--session <sid>] [--reason <reason>]',
          '                                          — Hand a task off to another session',
          '  handoff accept|reject <handoffId>       — Accept or decline a waiting handoff',
          '  handoff list                            — List handoffs waiting to be accepted',
          '  graph [--session <sid>] [--format text|json]',
          '                                          — Display the cross-session task dependency graph',
          '  cancel <taskId> [--scope task|subtree|session] [--session <sid>] [--reason <reason>]',
          '                                          — Cancel tasks with scoped semantics',
        ].join('\n');
        context.print(usage);
        break;
      }
    }
  },
};

/**
 * /resume, the discoverable front door to session resume.
 *
 * `/session resume <id>` has always existed but is buried behind a
 * subcommand nobody remembers mid-context-switch. `/resume` with no
 * arguments opens a picker over saved sessions (newest first, current
 * session excluded); with an argument it resumes directly via the exact
 * same workflow path (transcript restore, model reselection, return-context
 * reveal included).
 */
export const resumeCommand: SlashCommand = {
  name: 'resume',
  aliases: [],
  description: 'Resume a previous session, pick from a list or pass an id/name',
  usage: '[session-id-or-name]',
  argsHint: '[id|name]',
  handler: async (args: string[], ctx: CommandContext): Promise<void> => {
    if (args.length > 0 && args.join(' ').trim().length > 0) {
      await handleSessionWorkflowCommand(['resume', ...args], ctx);
      return;
    }
    const sm = requireSessionManager(ctx);
    // Every saved session except the open one. Subagent transcripts are not
    // listed by the session manager (they live under sessions/agents/).
    const sessions = sm.list().filter((s) => s.name !== ctx.session.runtime.sessionId);
    if (sessions.length === 0) {
      ctx.print('No previous sessions to resume yet. /session save [name] stores the current one explicitly.');
      return;
    }
    if (!ctx.openSelection) {
      // Headless/test surface without the picker: honest fallback to the list.
      await handleSessionWorkflowCommand(['list'], ctx);
      ctx.print('Resume one with: /resume <id-or-name>');
      return;
    }
    const items = sessions.map((s) => ({
      id: s.name,
      label: s.title || s.name,
      detail: `${new Date(s.timestamp).toLocaleString()} · ${s.messageCount} msg${s.messageCount === 1 ? '' : 's'}${s.model ? ` · ${s.model}` : ''} · ${s.name}`,
    }));
    ctx.openSelection('Resume session', items, { allowSearch: true, primaryVerbLabel: 'Resume' }, (result) => {
      if (!result) return;
      void handleSessionWorkflowCommand(['resume', result.item.id], ctx);
    });
  },
};

const handleGraph = createSessionGraphHandler<CommandContext>(
  requireSessionOrchestration,
  '[session] Task graph is empty. Use /session link-task to register tasks.',
);

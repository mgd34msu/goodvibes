import { randomUUID } from 'node:crypto';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { SharedSessionParticipant } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { AgentDelegationRegistry, type AgentDelegationRecord } from '../../agent/delegation-registry.ts';
import { commandRefusal } from './confirmation.ts';

interface DelegationCommandInput {
  readonly task: string;
  readonly reviewRequested: boolean;
  readonly reason: string;
  readonly successCriteria: string;
  readonly workspaceHint: string;
  readonly priority: string;
}

const DELEGATION_USAGE = 'Usage: /delegate [--review] [--reason <why>] [--success <evidence>] [--workspace <hint>] [--priority <priority>] [--] <build/fix/review task>\n       /delegate status [session-id]';

const VALUE_FLAGS: Readonly<Record<string, 'reason' | 'successCriteria' | 'workspaceHint' | 'priority'>> = {
  '--reason': 'reason',
  '--success': 'successCriteria',
  '--success-criteria': 'successCriteria',
  '--workspace': 'workspaceHint',
  '--worktree': 'workspaceHint',
  '--priority': 'priority',
};

/** The parsed command, or the reason it was refused. Nothing is dropped silently: an unknown option or a value that is missing is an error, and a bare `--` ends the options so a task may mention `--something`. */
function parseDelegationArgs(args: readonly string[], defaultReview: boolean): DelegationCommandInput | { readonly error: string } {
  const taskValues: string[] = [];
  const values = { reason: '', successCriteria: '', workspaceHint: '', priority: '' };
  let optionsEnded = false;
  let reviewRequested = defaultReview;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (optionsEnded || !token.startsWith('--')) {
      taskValues.push(token);
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    if (token === '--review' || token === '--wrfc') {
      reviewRequested = true;
      continue;
    }
    const target = VALUE_FLAGS[token];
    if (target === undefined) return { error: `Unknown option ${token}. Nothing was delegated. Put -- before a task that mentions it.` };
    const value = args[index + 1]?.trim();
    if (!value || value.startsWith('--')) return { error: `${token} needs a value. Nothing was delegated.` };
    values[target] = value;
    index += 1;
  }
  return { task: taskValues.join(' ').trim(), reviewRequested, ...values };
}

function buildDelegationBody(input: DelegationCommandInput): string {
  return [
    'GoodVibes Agent explicit build delegation.',
    '',
    'Original user ask',
    input.task,
    '',
    'Delegation reason',
    input.reason || '(not supplied)',
    '',
    'Success criteria or expected evidence',
    input.successCriteria || '(not supplied)',
    '',
    'Workspace or worktree hint',
    input.workspaceHint || '(not supplied)',
    '',
    'Priority or deadline',
    input.priority || '(not supplied)',
    '',
    'Agent policy',
    '- GoodVibes Agent is not the coding TUI.',
    '- Preserve the full original ask.',
    '- GoodVibes TUI owns file edits, git/worktree flows, execution isolation UX, and any delegated review owner chain.',
    input.reviewRequested
      ? '- Delegated review was explicitly requested by the Agent user for this build/fix/review handoff.'
      : '- Delegated review was not explicitly requested; do not add review solely because this came from Agent.',
  ].join('\n');
}

function delegationRegistry(ctx: CommandContext): AgentDelegationRegistry | null {
  const shellPaths = ctx.workspace?.shellPaths;
  return shellPaths ? AgentDelegationRegistry.fromShellPaths(shellPaths) : null;
}

function excerpt(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** `/delegate status [id]`: the recorded hand-offs, or one hand-off's session, input state and latest answer. */
function printDelegationStatus(ctx: CommandContext, query: string | undefined): void {
  const store = delegationRegistry(ctx);
  if (!store) {
    ctx.print('Delegation status is unavailable: this runtime has no Agent home to read the delegation list from.');
    return;
  }
  const all = store.list();
  if (!query) {
    if (all.length === 0) {
      ctx.print('No delegations recorded yet. Hand work off with /delegate <task>.');
      return;
    }
    ctx.print([
      `Delegations (${all.length}, newest first)`,
      ...all.slice(0, 10).map((entry) => `  ${entry.sessionId}  ${entry.createdAt.slice(0, 16).replace('T', ' ')}  ${excerpt(entry.task, 72)}`),
      ...(all.length > 10 ? [`  ... and ${all.length - 10} older`] : []),
      '  /delegate status <session-id> shows one hand-off\'s progress and answer.',
    ].join('\n'));
    return;
  }
  const entry = store.find(query);
  if (!entry) {
    throw commandRefusal(`No recorded delegation has a session id matching ${query}. Run /delegate status to list them; to delegate a task that starts with the word status, put -- before it.`);
  }
  const sessions = ctx.clients?.operator?.sessions;
  if (!sessions) {
    ctx.print(renderDelegationRecord(entry, ['  state unknown: no operator client is attached, so the session cannot be read.']));
    return;
  }
  try {
    const session = sessions.get(entry.sessionId);
    if (!session) {
      ctx.print(renderDelegationRecord(entry, ['  state the session no longer exists on this host (it was deleted).']));
      return;
    }
    const inputs = sessions.inputs(entry.sessionId, 50);
    const input = (entry.inputId ? inputs.find((candidate) => candidate.id === entry.inputId) : undefined) ?? inputs[inputs.length - 1];
    const answer = [...sessions.messages(entry.sessionId, 100)].reverse().find((message) => message.role === 'assistant');
    ctx.print(renderDelegationRecord(entry, [
      `  session ${session.status}${session.title ? `  ${session.title}` : ''}`,
      `  input ${input ? `${input.state}${input.error ? ` (${input.error})` : ''}` : 'not found on the session'}`,
      answer
        ? `  latest answer ${new Date(answer.createdAt).toISOString().slice(0, 16).replace('T', ' ')}  ${excerpt(answer.body)}`
        : '  latest answer none yet',
    ]));
  } catch (error) {
    ctx.print(renderDelegationRecord(entry, [`  state could not be read: ${summarizeError(error)}. Retry /delegate status ${entry.sessionId}.`]));
  }
}

function renderDelegationRecord(entry: AgentDelegationRecord, lines: readonly string[]): string {
  return [
    `Delegation ${entry.sessionId}`,
    `  task ${excerpt(entry.task)}`,
    `  delegated ${entry.createdAt}${entry.reviewRequested ? '  (delegated review requested)' : ''}`,
    ...lines,
  ].join('\n');
}

/** Removes a session the hand-off created but could not deliver its task to, so a retry does not leave an empty one behind. */
async function discardUndeliveredSession(ctx: CommandContext, sessionId: string): Promise<string> {
  const sessions = ctx.clients?.operator?.sessions;
  if (!sessions) return `  left behind empty session ${sessionId}`;
  try {
    await sessions.close(sessionId);
    const removed = await sessions.delete(sessionId);
    return removed === 'deleted' || removed === 'not-found'
      ? `  removed the empty session ${sessionId} it had created`
      : `  left behind empty session ${sessionId} (the host reports it ${removed})`;
  } catch (error) {
    return `  left behind empty session ${sessionId}: removing it failed (${summarizeError(error)})`;
  }
}

export function registerDelegationRuntimeCommands(registry: CommandRegistry): void {
  const makeHandler = () => async (args: string[], ctx: CommandContext): Promise<void> => {
    // `status` alone or with one id is the status read; a longer line starting with the word is a task.
    if (args[0] === 'status' && args.length <= 2) {
      printDelegationStatus(ctx, args[1]);
      return;
    }
    const input = parseDelegationArgs(args, false);
    if ('error' in input) {
      throw commandRefusal(`${input.error}\n${DELEGATION_USAGE}`);
    }
    if (!input.task) {
      throw commandRefusal(DELEGATION_USAGE);
    }
    const operator = ctx.clients?.operator;
    if (!operator) {
      throw commandRefusal(
        'Delegation unavailable; the task was not handed off: no operator client is attached.',
        'Use the shared-session route from a configured Agent runtime, or open GoodVibes TUI in the target workspace.',
        'COMMAND_FAILED',
      );
    }
    let createdSessionId: string | undefined;
    try {
      const participant = {
        surfaceKind: 'service',
        surfaceId: 'goodvibes-agent',
        externalId: ctx.session.runtime.sessionId,
        displayName: 'GoodVibes Agent',
        lastSeenAt: Date.now(),
      } satisfies SharedSessionParticipant;
      const session = await operator.sessions.ensureSession({
        title: `Agent delegation: ${input.task.slice(0, 72)}`,
        participant,
        metadata: {
          originSurface: 'goodvibes-agent',
          sourceSessionId: ctx.session.runtime.sessionId,
          task: input.task,
          reviewRequested: input.reviewRequested,
          wrfcRequested: input.reviewRequested,
          delegationReason: input.reason,
          successCriteria: input.successCriteria,
          workspaceHint: input.workspaceHint,
          priority: input.priority,
        },
      });
      createdSessionId = session.id;
      const submission = await operator.sessions.submitMessage({
        sessionId: session.id,
        // A retried hand-off is recorded once by the broker.
        providerMessageId: `agent-delegation:${randomUUID()}`,
        body: buildDelegationBody(input),
        surfaceKind: participant.surfaceKind,
        surfaceId: participant.surfaceId,
        externalId: participant.externalId,
        displayName: participant.displayName,
        title: `Agent delegation: ${input.task.slice(0, 72)}`,
        metadata: {
          originSurface: 'goodvibes-agent',
          sourceSessionId: ctx.session.runtime.sessionId,
          kind: 'task',
          task: input.task,
          reviewRequested: input.reviewRequested,
          wrfcRequested: input.reviewRequested,
          delegationReason: input.reason,
          successCriteria: input.successCriteria,
          workspaceHint: input.workspaceHint,
          priority: input.priority,
        },
        routing: {
          executionIntent: {
            riskClass: 'elevated',
            requiresApproval: true,
            networkPolicy: 'inherit',
            filesystemPolicy: 'workspace-write',
          },
        },
      });
      createdSessionId = undefined;
      const record: AgentDelegationRecord = {
        sessionId: session.id,
        task: input.task,
        createdAt: new Date().toISOString(),
        ...(submission?.input?.id ? { inputId: submission.input.id } : {}),
        reviewRequested: input.reviewRequested,
      };
      let recordNote = `  next /delegate status ${session.id} shows its progress and answer.`;
      const store = delegationRegistry(ctx);
      if (!store) {
        recordNote = `  not recorded: this runtime has no Agent home, so /delegate status cannot find it later; keep the session id ${session.id}.`;
      } else {
        try {
          store.record(record);
        } catch (error) {
          recordNote = `  not recorded (${summarizeError(error)}); keep the session id ${session.id}.`;
        }
      }
      ctx.print([
        'Delegation submitted to GoodVibes TUI/shared-session routes.',
        `  session ${session.id}`,
        `  mode ${input.reviewRequested ? 'delegated review requested' : 'direct build delegation'}`,
        `  task ${input.task}`,
        ...(input.reason ? [`  reason ${input.reason}`] : []),
        ...(input.successCriteria ? [`  success ${input.successCriteria}`] : []),
        recordNote,
      ].join('\n'));
    } catch (error) {
      const cleanup = createdSessionId ? await discardUndeliveredSession(ctx, createdSessionId) : '';
      throw commandRefusal([
        'Delegation failed; the task was not handed off.',
        `  error ${summarizeError(error)}`,
        ...(cleanup ? [cleanup] : []),
      ].join('\n'), 'Retry /delegate with the same task, or open GoodVibes TUI in the target workspace and paste it there.', 'COMMAND_FAILED');
    }
  };

  registry.register({
    name: 'delegate',
    effect: 'delegated-work',
    aliases: ['build'],
    description: 'Explicitly delegate build/fix/review work to GoodVibes TUI through shared-session routes',
    firstScreen: false,
    usage: '[--review] [--reason <why>] [--success <evidence>] [--workspace <hint>] [--priority <priority>] <task> | status [session-id]',
    argsHint: '[--review] [--reason <why>] [--success <evidence>] [--workspace <hint>] [--priority <priority>] <task> | status [session-id]',
    handler: makeHandler(),
  });
}

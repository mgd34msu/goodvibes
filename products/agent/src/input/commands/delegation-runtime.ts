import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { SharedSessionParticipant } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

interface DelegationCommandInput {
  readonly task: string;
  readonly reviewRequested: boolean;
  readonly reason: string;
  readonly successCriteria: string;
  readonly workspaceHint: string;
  readonly priority: string;
}

const DELEGATION_USAGE = 'Usage: /delegate [--review] [--reason <why>] [--success <evidence>] [--workspace <hint>] [--priority <priority>] [--] <build/fix/review task>';

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
  if (!optionsEnded && taskValues.length === 1 && taskValues[0] === 'status') {
    return { error: '`status` is not a delegate subcommand. Nothing was delegated. Put -- before a task that is literally the word status.' };
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

export function registerDelegationRuntimeCommands(registry: CommandRegistry): void {
  const makeHandler = () => async (args: string[], ctx: CommandContext): Promise<void> => {
    const input = parseDelegationArgs(args, false);
    if ('error' in input) {
      ctx.print(`${input.error}\n${DELEGATION_USAGE}`);
      return;
    }
    if (!input.task) {
      ctx.print(DELEGATION_USAGE);
      return;
    }
    const operator = ctx.clients?.operator;
    if (!operator) {
      ctx.print([
        'Delegation unavailable. No operator client is attached.',
        'Use the shared-session route from a configured Agent runtime, or open GoodVibes TUI in the target workspace.',
      ].join('\n'));
      return;
    }
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
      await operator.sessions.submitMessage({
        sessionId: session.id,
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
      ctx.print([
        'Delegation submitted to GoodVibes TUI/shared-session routes.',
        `  session ${session.id}`,
        `  mode ${input.reviewRequested ? 'delegated review requested' : 'direct build delegation'}`,
        `  task ${input.task}`,
        ...(input.reason ? [`  reason ${input.reason}`] : []),
        ...(input.successCriteria ? [`  success ${input.successCriteria}`] : []),
        '  next check GoodVibes TUI shared-session/task status for the result.',
      ].join('\n'));
    } catch (error) {
      ctx.print([
        'Delegation failed.',
        `  error ${summarizeError(error)}`,
        '  fallback open GoodVibes TUI in the target workspace and paste the original task there.',
      ].join('\n'));
    }
  };

  registry.register({
    name: 'delegate',
    aliases: ['build'],
    description: 'Explicitly delegate build/fix/review work to GoodVibes TUI through shared-session routes',
    hidden: true,
    usage: '[--review] [--reason <why>] [--success <evidence>] [--workspace <hint>] [--priority <priority>] <task>',
    argsHint: '[--review] [--reason <why>] [--success <evidence>] [--workspace <hint>] [--priority <priority>] <task>',
    handler: makeHandler(),
  });
}

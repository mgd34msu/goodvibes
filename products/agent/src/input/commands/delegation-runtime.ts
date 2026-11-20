/**
 * The Agent's host for `/agents` (terminal-shell/agents-command.ts): the Your
 * agents panel, and handing build, fix and review work to the terminal app
 * through a shared session on the connected host, with the hand-offs recorded
 * in the Agent's home so their progress and answer can be read later. Hosting
 * coding agents, team modes and work contracts belong to the terminal app and
 * are refused here with the reason.
 */
import { randomUUID } from 'node:crypto';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { registerAgentsCommand, type HandOffInput } from '@goodvibes-jev/engine/terminal-shell/agents-command';
import type { SharedSessionParticipant } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { AgentDelegationRegistry, type AgentDelegationRecord } from '../../agent/delegation-registry.ts';
import { commandRefusal } from './confirmation.ts';
import { requireShellPaths } from './runtime-services.ts';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { createVerbSpawnGateway, type AcpSpawnGateway } from '@goodvibes-jev/engine/terminal-shell/fleet-spawn';
import { isAbsolute, resolve } from 'node:path';

/** The ACP calls over this Agent's connected host, the same daemon `n` in Your agents hosts on. */
function codingGateway(ctx: CommandContext): AcpSpawnGateway {
  const resolution = createVerbSpawnGateway(createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }));
  if (!resolution.available) throw commandRefusal(resolution.reason);
  return resolution.gateway;
}

function buildDelegationBody(input: HandOffInput): string {
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

/** One hand-off's session, input state and latest answer. */
async function delegationStatus(ctx: CommandContext, query: string): Promise<string> {
  const store = delegationRegistry(ctx);
  if (!store) throw commandRefusal('Hand-offs cannot be read: this runtime has no Agent home to read them from.');
  const entry = store.find(query);
  if (!entry) throw commandRefusal(`No recorded hand-off has a session id matching ${query}.`, '/agents handed-off lists them.');
  const sessions = ctx.clients?.operator?.sessions;
  if (!sessions) return renderDelegationRecord(entry, ['  state unknown: no operator client is attached, so the session cannot be read.']);
  try {
    const session = sessions.get(entry.sessionId);
    if (!session) return renderDelegationRecord(entry, ['  state the session no longer exists on this host (it was deleted).']);
    const inputs = sessions.inputs(entry.sessionId, 50);
    const input = (entry.inputId ? inputs.find((candidate) => candidate.id === entry.inputId) : undefined) ?? inputs[inputs.length - 1];
    const answer = [...sessions.messages(entry.sessionId, 100)].reverse().find((message) => message.role === 'assistant');
    return renderDelegationRecord(entry, [
      `  session ${session.status}${session.title ? `  ${session.title}` : ''}`,
      `  input ${input ? `${input.state}${input.error ? ` (${input.error})` : ''}` : 'not found on the session'}`,
      answer
        ? `  latest answer ${new Date(answer.createdAt).toISOString().slice(0, 16).replace('T', ' ')}  ${excerpt(answer.body)}`
        : '  latest answer none yet',
    ]);
  } catch (error) {
    return renderDelegationRecord(entry, [`  state could not be read: ${summarizeError(error)}. Retry /agents handed-off ${entry.sessionId}.`]);
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

/** Hand coding work to the terminal app; the answer line names the session to follow. */
async function sendHandOff(ctx: CommandContext, input: HandOffInput): Promise<string> {
  const operator = ctx.clients?.operator;
  if (!operator) {
    throw commandRefusal(
      'The work was not handed off: no operator client is attached.',
      'Hand it off from an Agent connected to its host, or open the terminal app in the project and ask there.',
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
    const metadata = {
      originSurface: 'goodvibes-agent',
      sourceSessionId: ctx.session.runtime.sessionId,
      task: input.task,
      reviewRequested: input.reviewRequested,
      wrfcRequested: input.reviewRequested,
      delegationReason: input.reason,
      successCriteria: input.successCriteria,
      workspaceHint: input.workspaceHint,
      priority: input.priority,
    };
    const session = await operator.sessions.ensureSession({ title: `Agent delegation: ${input.task.slice(0, 72)}`, participant, metadata });
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
      metadata: { ...metadata, kind: 'task' },
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
    let recordNote = `  follow it: /agents handed-off ${session.id}`;
    const store = delegationRegistry(ctx);
    if (!store) {
      recordNote = `  not recorded: this runtime has no Agent home, so it cannot be listed later; keep the session id ${session.id}.`;
    } else {
      try {
        store.record(record);
      } catch (error) {
        recordNote = `  not recorded (${summarizeError(error)}); keep the session id ${session.id}.`;
      }
    }
    return [
      'Handed to the terminal app through a shared session.',
      `  session ${session.id}`,
      `  ${input.reviewRequested ? 'review asked for' : 'no review asked for'}`,
      `  work ${input.task}`,
      ...(input.reason ? [`  why ${input.reason}`] : []),
      ...(input.successCriteria ? [`  done when ${input.successCriteria}`] : []),
      recordNote,
    ].join('\n');
  } catch (error) {
    const cleanup = createdSessionId ? await discardUndeliveredSession(ctx, createdSessionId) : '';
    throw commandRefusal([
      'The work was not handed off.',
      `  error ${summarizeError(error)}`,
      ...(cleanup ? [cleanup] : []),
    ].join('\n'), 'Hand it off again with the same words, or open the terminal app in the project and ask there.', 'COMMAND_FAILED');
  }
}

const TERMINAL_APP_ONLY = 'This belongs to the terminal app, which runs the agents and keeps their contracts; run it there.';

export function registerDelegationRuntimeCommands(registry: CommandRegistry): void {
  registerAgentsCommand<CommandContext>(registry, {
    openPanel(ctx, target) {
      if (!ctx.openAgents) throw commandRefusal('Your agents needs the interactive shell.');
      ctx.openAgents({ target: target.split(':')[0] ?? '' });
    },
    coding: {
      async list(ctx) {
        try { return await codingGateway(ctx).listAgents(); } catch (error) { throw commandRefusal(summarizeError(error)); }
      },
      async host(ctx, agentId, directory) {
        const here = requireShellPaths(ctx).workingDirectory;
        const cwd = directory ? (isAbsolute(directory) ? directory : resolve(here, directory)) : here;
        let answer;
        try { answer = await codingGateway(ctx).createSession({ agentId, cwd }); } catch (error) { throw commandRefusal(summarizeError(error)); }
        const { hosted, started } = answer;
        if (hosted.error) throw commandRefusal(`Could not host ${hosted.title || agentId}: the ${hosted.error.stage} stage failed for ${hosted.error.binary}; ${hosted.error.message}`);
        return `Hosting ${hosted.title || agentId} in ${cwd} on the connected host${started ? '' : ' (queued)'}; it shows as a row in Your agents, where you open and stop it.`;
      },
    },
    handOff: {
      send: sendHandOff,
      recorded(ctx) {
        const store = delegationRegistry(ctx);
        if (!store) throw commandRefusal('Hand-offs cannot be read: this runtime has no Agent home to read them from.');
        return store.list();
      },
      status: delegationStatus,
    },
    contracts: { unavailable: TERMINAL_APP_ONLY },
    team: { unavailable: TERMINAL_APP_ONLY },
  });
}

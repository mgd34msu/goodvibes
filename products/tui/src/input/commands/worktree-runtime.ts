import { getPersistedWorktreeMeta, reviewWorktreeAttachments, summarizeWorktreeOwnership } from '@/runtime/index.ts';
import type { ManagedWorktreeMeta, WorktreeRegistry } from '@/runtime/index.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { defineCommand, defineList, type ActionDescription, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { openCommandView, requireShellPaths } from './runtime-services.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

/** Compact per-row setup-state tag for /worktree review, absent when setup has never run; failure stands out. */
export function formatSetupTag(setup: ManagedWorktreeMeta['setup']): string {
  if (!setup) return '';
  if (setup.state === 'failed') return ' setup:FAILED';
  if (setup.state === 'succeeded') return ' setup:ok';
  return ' setup:skipped';
}

/** Full setup-state block for /worktree inspect, the failing step + captured output when failed. */
export function formatSetupDetail(setup: ManagedWorktreeMeta['setup']): string[] {
  if (!setup) return ['  setup: never run'];
  if (setup.state !== 'failed') return [`  setup: ${setup.state}`];
  const failingStep = setup.steps.find((step) => !step.ok);
  return [
    `  setup: FAILED; ${setup.error ?? 'unknown error'}`,
    ...(failingStep
      ? [
          `    failing step (${failingStep.kind}): ${failingStep.label}${failingStep.exitCode !== undefined ? ` (exit ${failingStep.exitCode})` : ''}`,
          ...(failingStep.output ? [`    output: ${failingStep.output.slice(0, 2000)}`] : []),
        ]
      : []),
  ];
}

type KeptWorktreeInfo = Awaited<ReturnType<WorktreeRegistry['describeKept']>>[number];

/** The next steps of a worktree kept for the owner's decision, one per line under its row; empty for any other. */
function formatNextSteps(steps: readonly string[] | undefined): string {
  return steps && steps.length > 0 ? steps.map((step) => `\n        ${step}`).join('') : '';
}

/** What this process's start-up pass removed, so the review shows it as well as the start notice did. */
function formatStartupRemovals(runtime: WorktreeRegistry): string[] {
  const report = runtime.lastStartupReport();
  if (!report || report.removed.length === 0) return [];
  return [
    `  removed at start (${new Date(report.finishedAt).toLocaleTimeString()}):`,
    ...report.removed.map((entry) => `    ${entry.path}: ${entry.note}`),
  ];
}

/** Retention view of the product's own worktrees (age, size, why kept), or why it could not be read. */
async function describeKeptWorktrees(
  runtime: WorktreeRegistry,
  options: Parameters<WorktreeRegistry['describeKept']>[0],
): Promise<{ readonly infos: KeptWorktreeInfo[]; readonly failure?: string }> {
  try {
    return { infos: await runtime.describeKept(options) };
  } catch (error) {
    return { infos: [], failure: `  retention details unavailable: ${summarizeError(error)}` };
  }
}

function registryOf(ctx: CommandContext): WorktreeRegistry {
  const runtime = ctx.workspace.worktreeRegistry;
  if (!runtime) throw commandRefusal('Worktree registry is not wired into this runtime.');
  return runtime;
}
function rpcOf(ctx: CommandContext) {
  const rpc = getOperatorRpc(ctx);
  if (!rpc.available) throw commandRefusal(rpc.reason);
  return rpc;
}

const WORKTREES = defineList<CommandContext>({
  name: 'worktrees',
  async read(ctx) {
    const runtime = ctx.workspace.worktreeRegistry;
    if (!runtime) return [];
    return (await runtime.list()).map((row): ListRow => ({ value: row.path, label: row.branch || row.path, detail: row.path, state: row.state }));
  },
  operator: { terminalOnly: 'The worktree list is read from this project.' },
});

const WORKTREE = listInput({ id: 'worktree', label: 'Worktree', help: 'The worktrees of this project', list: WORKTREES, other: 'a worktree path that is not tracked' });
const ATTACHED_KIND = { id: 'kind', label: 'Attached to', help: 'A session or a task', kind: 'choice', choices: [{ value: 'session', label: 'A session' }, { value: 'task', label: 'A task' }], required: true, typed: { position: 1 } } as const;
const ATTACHED_ID = textInput({ id: 'id', label: 'Its id', help: 'The session\'s or task\'s id', why: 'an id from /session list or /tasks', typed: { position: 2 } });

function stateAction(id: 'pause' | 'resume' | 'keep', label: string, next: 'paused' | 'active' | 'kept', sentence: string): ActionDescription<CommandContext> {
  return {
    id, label, word: id, inputs: [WORKTREE], sentence, done: '',
    touches: 'this-machine', lasts: 'kept', risk: 'none',
    operator: { terminalOnly: 'The worktree list is read from this project.' }, example: { worktree: '.goodvibes/worktrees/u-2' },
    async run(values, ctx) {
      registryOf(ctx).setState(values.worktree!, next);
      return `${values.worktree} is ${next}.`;
    },
  };
}

function attachmentReview(ctx: CommandContext, kind: 'session' | 'task', id: string, recover: boolean): string {
  const review = reviewWorktreeAttachments(kind, id, { workingDirectory: requireShellPaths(ctx).workingDirectory });
  const header = recover ? 'Worktree Recovery' : 'Worktree Attachment Review';
  if (review.total === 0) return `${header}: ${kind} ${id}\n  No attached worktrees tracked.`;
  return [
    `${header}: ${kind} ${id}`,
    `  total: ${review.total}`,
    `  active: ${review.active}  paused: ${review.paused}  kept: ${review.kept}`,
    ...review.records.map((record) => `  ${record.state.padEnd(15)} ${record.kind.padEnd(12)} ${record.path}`),
    ...(recover
      ? ['  next:', ...review.records.map((record) => `    /worktree ${record.state === 'paused' ? 'resume' : 'keep'} ${record.path}`), `    /${kind === 'session' ? 'session info' : 'task status'} ${id}`]
      : []),
  ].join('\n');
}

export function registerWorktreeRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'worktree',
    title: 'Worktrees',
    summary: 'See and look after the git worktrees parallel work runs in',
    group: 'Work',
    report: 'review',
    firstScreenRows: [
      'review', 'inspect', 'discard',
      { label: 'Keep, pause or resume a worktree', actions: ['keep', 'pause', 'resume', 'setup', 'cleanup'] },
      { label: 'Worktrees of a session or task', actions: ['attached', 'recover', 'attach'] },
      'open',
    ],
    actions: [
      readAction<CommandContext>({
        id: 'review', label: 'See your worktrees', word: 'review',
        sentence: 'Shows every worktree with its state, branch, age, size and why it is kept.',
        async run(_values, ctx) {
          const runtime = registryOf(ctx);
          const rows = await runtime.list();
          const summary = summarizeWorktreeOwnership(rows);
          const kept = await describeKeptWorktrees(runtime, { rows });
          const keptInfo = new Map(kept.infos.map((info) => [info.path, info]));
          if (rows.length === 0) return ['Worktree Review', '  No worktrees discovered.', ...formatStartupRemovals(runtime)].join('\n');
          return [
            'Worktree Review',
            `  total: ${summary.total}`,
            `  active: ${summary.active}  paused: ${summary.paused}  kept: ${summary.kept}`,
            `  session attached: ${summary.sessionAttached}  task attached: ${summary.taskAttached}`,
            `  agent owned: ${summary.agentOwned}  orchestrator owned: ${summary.orchestratorOwned}  manual: ${summary.manualOwned}`,
            ...rows.map((row) => (
              `  ${row.kind.padEnd(12)} ${row.state.padEnd(15)} ${row.branch.padEnd(22)} session=${(row.sessionId ?? '-').padEnd(12)} task=${(row.taskId ?? '-').padEnd(12)} ${row.path}${formatSetupTag(row.setup)}${keptInfo.has(row.path) ? `\n      ${keptInfo.get(row.path)!.summary}` : ''}${formatNextSteps(keptInfo.get(row.path)?.nextSteps)}`
            )),
            ...(keptInfo.size > 0 ? ['  Remove one you no longer need with /worktree discard <worktree>; the branch and any uncommitted state are preserved on it.'] : []),
            ...formatStartupRemovals(runtime),
            ...(kept.failure ? [kept.failure] : []),
          ].join('\n');
        },
      }),
      doAction<CommandContext>({
        id: 'open', label: 'Open the worktrees in Agents', word: 'open', touches: 'reads',
        sentence: 'Opens Agents on the worktree list.', operator: { terminalOnly: 'It is a terminal screen.' },
        async run(_values, ctx) { openCommandView(ctx, 'worktrees'); },
      }),
      readAction<CommandContext>({
        id: 'inspect', label: 'See one worktree', word: 'inspect', inputs: [WORKTREE],
        sentence: 'Shows {worktree}\'s state, owner, session, task, setup and what to do next.', example: { worktree: '.goodvibes/worktrees/u-2' },
        async run(values, ctx) {
          const runtime = registryOf(ctx);
          const record = getPersistedWorktreeMeta(values.worktree!, { workingDirectory: requireShellPaths(ctx).workingDirectory });
          if (!record) throw commandRefusal(`No tracked worktree at ${values.worktree}.`, '/worktree review lists them.');
          const nextSteps = [
            record.setup?.state === 'failed' ? `/worktree setup ${record.path}` : null,
            record.state === 'paused' ? `/worktree resume ${record.path}` : null,
            record.state === 'kept' ? `/worktree keep ${record.path}` : null,
            record.sessionId ? `/worktree attached session ${record.sessionId}` : null,
            record.taskId ? `/worktree attached task ${record.taskId}` : null,
          ].filter((value): value is string => Boolean(value));
          // Only this worktree is evaluated and measured, not every kept one.
          const kept = await describeKeptWorktrees(runtime, { only: record.path });
          return [
            'Worktree Inspect',
            `  path: ${record.path}`,
            `  kind: ${record.kind}`,
            `  state: ${record.state}`,
            `  owner: ${record.ownerId ?? 'n/a'}`,
            `  session: ${record.sessionId ?? 'n/a'}`,
            `  task: ${record.taskId ?? 'n/a'}`,
            `  updated: ${new Date(record.updatedAt).toLocaleString()}`,
            ...formatSetupDetail(record.setup),
            ...(nextSteps.length > 0 ? ['  next:', ...nextSteps.map((step) => `    ${step}`)] : ['  next: /worktree review']),
            ...kept.infos.map((info) => `  kept: ${info.summary}${formatNextSteps(info.nextSteps)}`),
            ...(kept.failure ? [kept.failure] : []),
          ].join('\n');
        },
      }),
      doAction<CommandContext>({
        id: 'setup', label: 'Run a worktree\'s setup again', word: 'setup', inputs: [WORKTREE],
        sentence: 'The cold-start setup (worktree.setup.commands and carried-over files) runs again in {worktree}.',
        operator: { method: 'worktrees.setup.run', fields: { path: 'worktree' } }, example: { worktree: '.goodvibes/worktrees/u-2' },
        async run(values, ctx) {
          const rpc = rpcOf(ctx);
          ctx.print(`Running the setup again in ${values.worktree}...`);
          try {
            const { setup } = await rpc.platformClient.operator.invoke('worktrees.setup.run', { path: values.worktree! });
            if (setup.state === 'skipped') return 'Setup skipped: worktree.setup.commands and worktree.setup.carryOverGlobs are none, or auto found nothing to run or copy in this repository. Change them in /settings (Orchestration).';
            if (setup.state === 'succeeded') return `Setup succeeded (${setup.steps.length} step(s)).`;
            return formatSetupDetail(setup).join('\n');
          } catch (error) {
            throw commandRefusal(`Setup request failed: ${describeOperatorRpcError(error)}`);
          }
        },
      }),
      {
        id: 'attach', label: 'Tie a worktree to a session or task', word: 'attach',
        inputs: [WORKTREE, { ...ATTACHED_KIND, typed: { flag: '--to' } }, { ...ATTACHED_ID, typed: { position: 2 } }],
        sentence: '{worktree} is tied to {kind} {id} until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: 'The worktree list is read from this project.' }, example: { worktree: '.goodvibes/worktrees/u-2', kind: 'task', id: 't-9' },
        async run(values, ctx) {
          try {
            registryOf(ctx).attach(values.worktree!, values.kind === 'session' ? { sessionId: values.id! } : { taskId: values.id! });
          } catch (error) {
            // The registry refuses a path no worktree exists at; say so instead of a generic failure or a success line.
            throw commandRefusal(`Not tied: ${summarizeError(error)}`);
          }
          return `Tied ${values.worktree} to ${values.kind} ${values.id}.`;
        },
      },
      readAction<CommandContext>({
        id: 'attached', label: 'See a session\'s or task\'s worktrees', word: 'attached', inputs: [ATTACHED_KIND, ATTACHED_ID],
        sentence: 'Shows the worktrees tied to {kind} {id} and their states.', example: { kind: 'session', id: 's-41' },
        async run(values, ctx) { return attachmentReview(ctx, values.kind as 'session' | 'task', values.id!, false); },
      }),
      readAction<CommandContext>({
        id: 'recover', label: 'See how to recover a session\'s or task\'s worktrees', word: 'recover', inputs: [ATTACHED_KIND, ATTACHED_ID],
        sentence: 'Shows the worktrees tied to {kind} {id} and the line that brings each back.', example: { kind: 'task', id: 't-9' },
        async run(values, ctx) { return attachmentReview(ctx, values.kind as 'session' | 'task', values.id!, true); },
      }),
      stateAction('pause', 'Pause a worktree', 'paused', '{worktree} is marked paused until you change it.'),
      stateAction('resume', 'Resume a worktree', 'active', '{worktree} is marked active again until you change it.'),
      stateAction('keep', 'Keep a worktree', 'kept', '{worktree} is marked kept, so the retention sweep leaves it, until you change it.'),
      {
        id: 'discard', label: 'Remove a worktree', word: 'discard', inputs: [WORKTREE],
        sentence: '{worktree} is removed from disk; its branch is kept and anything uncommitted is saved on it first.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { method: 'worktrees.discard', fields: { path: 'worktree' } }, example: { worktree: '.goodvibes/worktrees/u-2' },
        async run(values, ctx) {
          // A real destructive act, not a metadata flip: the worktrees.discard operator verb (preservation
          // commit, git worktree removal, honest receipt), the same as the Agents modal's D key.
          const rpc = rpcOf(ctx);
          let receipt;
          try {
            receipt = await rpc.platformClient.operator.invoke('worktrees.discard', { path: values.worktree! });
          } catch (error) {
            throw commandRefusal(`Remove request failed: ${describeOperatorRpcError(error)}`);
          }
          if (!receipt.ok) throw commandRefusal(`Not removed: ${receipt.detail}`);
          return [
            `Removed ${receipt.path}`,
            `  branch kept: ${receipt.branch || '(unknown)'}`,
            `  preservation commit: ${receipt.preservedCommit || '(none; nothing to preserve)'}`,
            `  ${receipt.detail}`,
          ].join('\n');
        },
      },
      {
        id: 'cleanup', label: 'Stop tracking a worktree that is gone', word: 'cleanup', inputs: [WORKTREE],
        sentence: '{worktree}\'s tracking record is removed; use it once the worktree itself is gone.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { terminalOnly: 'The worktree list is read from this project.' }, example: { worktree: '.goodvibes/worktrees/u-2' },
        async run(values, ctx) {
          await registryOf(ctx).cleanup(values.worktree!);
          return `Stopped tracking ${values.worktree}.`;
        },
      },
    ],
  }));
}

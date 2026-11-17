import { getPersistedWorktreeMeta, reviewWorktreeAttachments, summarizeWorktreeOwnership } from '@/runtime/index.ts';
import type { ManagedWorktreeMeta, WorktreeRegistry } from '@/runtime/index.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { openCommandView, requireShellPaths } from './runtime-services.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

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

export function registerWorktreeRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'worktree',
    aliases: ['worktrees'],
    description: 'Review and manage orchestrator-owned git worktrees',
    usage: '[review|panel|inspect <path>|setup <path>|attach <path> <session|task> <id>|session <id>|task <id>|recover <session|task> <id>|pause <path>|resume <path>|keep <path>|discard <path>|cleanup <path>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      const runtime = ctx.workspace.worktreeRegistry;
      const shellPaths = requireShellPaths(ctx);
      if (!runtime) {
        ctx.print('Worktree registry is not wired into this runtime.');
        return;
      }
      if (sub === 'panel' || sub === 'open') {
        openCommandView(ctx, 'worktrees');
        return;
      }
      if (sub === 'inspect') {
        const path = args[1];
        if (!path) {
          ctx.print('Usage: /worktree inspect <path>');
          return;
        }
        const record = getPersistedWorktreeMeta(path, { workingDirectory: shellPaths.workingDirectory });
        if (!record) {
          ctx.print(`Worktree inspect: no tracked worktree metadata for ${path}.`);
          return;
        }
        const nextSteps = [
          record.setup?.state === 'failed' ? `/worktree setup ${record.path}` : null,
          record.state === 'paused' ? `/worktree resume ${record.path}` : null,
          record.state === 'kept' ? `/worktree keep ${record.path}` : null,
          record.sessionId ? `/worktree session ${record.sessionId}` : null,
          record.taskId ? `/worktree task ${record.taskId}` : null,
        ].filter((value): value is string => Boolean(value));
        // Only this worktree is evaluated and measured, not every kept one.
        const kept = await describeKeptWorktrees(runtime, { only: record.path });
        ctx.print([
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
          ...kept.infos.map((info) => `  kept: ${info.summary}`),
          ...(kept.failure ? [kept.failure] : []),
        ].join('\n'));
        return;
      }
      if (sub === 'setup') {
        const path = args[1];
        if (!path) {
          ctx.print('Usage: /worktree setup <path>');
          return;
        }
        const rpc = getOperatorRpc(ctx);
        if (!rpc.available) {
          ctx.print(`[worktree setup] ${rpc.reason}`);
          return;
        }
        ctx.print(`[worktree setup] Re-running cold-start setup for ${path}...`);
        try {
          const { setup } = await rpc.platformClient.operator.invoke('worktrees.setup.run', { path });
          if (setup.state === 'skipped') {
            ctx.print('[worktree setup] skipped: worktree.setup.commands and worktree.setup.carryOverGlobs are none, or auto found nothing to run or copy in this repository. Change them in /settings (Orchestration).');
          } else if (setup.state === 'succeeded') {
            ctx.print(`[worktree setup] succeeded (${setup.steps.length} step(s)).`);
          } else {
            ctx.print(formatSetupDetail(setup).join('\n'));
          }
        } catch (error) {
          ctx.print(`[worktree setup] round-trip request failed: ${describeOperatorRpcError(error)}`);
        }
        return;
      }
      if (sub === 'attach') {
        const path = args[1];
        const targetKind = args[2];
        const targetId = args[3];
        if (!path || !targetKind || !targetId || (targetKind !== 'session' && targetKind !== 'task')) {
          ctx.print('Usage: /worktree attach <path> <session|task> <id>');
          return;
        }
        try {
          runtime.attach(path, targetKind === 'session' ? { sessionId: targetId } : { taskId: targetId });
        } catch (error) {
          // The registry refuses a path no worktree exists at; say so instead of a generic failure or a success line.
          ctx.print(`Not attached: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        ctx.print(`Attached ${path} to ${targetKind} ${targetId}.`);
        return;
      }
      if (sub === 'session' || sub === 'task' || sub === 'recover') {
        const targetKind = sub === 'recover' ? args[1] : sub;
        const targetId = sub === 'recover' ? args[2] : args[1];
        if (!targetId || (targetKind !== 'session' && targetKind !== 'task')) {
          ctx.print(sub === 'recover'
            ? 'Usage: /worktree recover <session|task> <id>'
            : `Usage: /worktree ${sub} <id>`);
          return;
        }
        const review = reviewWorktreeAttachments(targetKind, targetId, { workingDirectory: shellPaths.workingDirectory });
        const header = sub === 'recover' ? 'Worktree Recovery' : 'Worktree Attachment Review';
        ctx.print(review.total > 0
          ? [
              `${header}: ${targetKind} ${targetId}`,
              `  total: ${review.total}`,
              `  active: ${review.active}  paused: ${review.paused}  kept: ${review.kept}`,
              ...review.records.map((record) => `  ${record.state.padEnd(15)} ${record.kind.padEnd(12)} ${record.path}`),
              ...(sub === 'recover'
                ? [
                    '  next:',
                    ...review.records.map((record) => `    /worktree ${record.state === 'paused' ? 'resume' : 'keep'} ${record.path}`),
                    `    /${targetKind === 'session' ? 'session info' : 'task status'} ${targetId}`,
                  ]
                : []),
            ].join('\n')
          : `${header}: ${targetKind} ${targetId}\n  No attached worktrees tracked.`);
        return;
      }
      if (sub === 'discard') {
        // Discard is a real destructive act, not a metadata flip: route it
        // through the worktrees.discard operator verb (preservation commit,
        // git worktree removal, honest receipt), the SAME behavior as the
        // Agents modal's D key. Typing the verb with an explicit path is the
        // confirmation.
        const path = args[1];
        if (!path) {
          ctx.print('Usage: /worktree discard <path>');
          return;
        }
        const rpc = getOperatorRpc(ctx);
        if (!rpc.available) {
          ctx.print(`[worktree discard] ${rpc.reason}`);
          return;
        }
        try {
          const receipt = await rpc.platformClient.operator.invoke('worktrees.discard', { path });
          if (receipt.ok) {
            ctx.print([
              `[worktree discard] Discarded ${receipt.path}`,
              `  branch kept: ${receipt.branch || '(unknown)'}`,
              `  preservation commit: ${receipt.preservedCommit || '(none; nothing to preserve)'}`,
              `  ${receipt.detail}`,
            ].join('\n'));
          } else {
            ctx.print(`[worktree discard] refused for ${receipt.path}: ${receipt.detail}`);
          }
        } catch (error) {
          ctx.print(`[worktree discard] round-trip request failed: ${describeOperatorRpcError(error)}`);
        }
        return;
      }
      if (sub === 'pause' || sub === 'resume' || sub === 'keep') {
        const path = args[1];
        if (!path) {
          ctx.print(`Usage: /worktree ${sub} <path>`);
          return;
        }
        const nextState = sub === 'resume' ? 'active' : sub === 'pause' ? 'paused' : 'kept';
        runtime.setState(path, nextState);
        ctx.print(`Updated ${path} to state ${nextState}.`);
        return;
      }
      if (sub === 'cleanup') {
        const path = args[1];
        if (!path) {
          ctx.print('Usage: /worktree cleanup <path>');
          return;
        }
        await runtime.cleanup(path);
        ctx.print(`Cleaned up worktree ${path}.`);
        return;
      }
      const rows = await runtime.list();
      const summary = summarizeWorktreeOwnership(rows);
      const kept = await describeKeptWorktrees(runtime, { rows });
      const keptInfo = new Map(kept.infos.map((info) => [info.path, info]));
      ctx.print(rows.length > 0
        ? [
            'Worktree Review',
            `  total: ${summary.total}`,
            `  active: ${summary.active}  paused: ${summary.paused}  kept: ${summary.kept}`,
            `  session attached: ${summary.sessionAttached}  task attached: ${summary.taskAttached}`,
            `  agent owned: ${summary.agentOwned}  orchestrator owned: ${summary.orchestratorOwned}  manual: ${summary.manualOwned}`,
            ...rows.map((row) => (
              `  ${row.kind.padEnd(12)} ${row.state.padEnd(15)} ${row.branch.padEnd(22)} session=${(row.sessionId ?? '-').padEnd(12)} task=${(row.taskId ?? '-').padEnd(12)} ${row.path}${formatSetupTag(row.setup)}${keptInfo.has(row.path) ? `\n      ${keptInfo.get(row.path)!.summary}` : ''}`
            )),
            ...(keptInfo.size > 0 ? ['  Discard one you no longer need with /worktree discard <path>; the branch and any uncommitted state are preserved on it.'] : []),
            ...(kept.failure ? [kept.failure] : []),
          ].join('\n')
        : 'Worktree Review\n  No worktrees discovered.');
    },
  });
}

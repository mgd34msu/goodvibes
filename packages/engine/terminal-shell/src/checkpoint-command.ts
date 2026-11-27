/**
 * `/checkpoint`, described once (command-actions/) for both terminal apps:
 * see the workspace checkpoints, make one, put the files back to one, and go
 * back to an earlier turn (files, conversation or both). Going back reads the
 * plan, shows it on the Changes preview, asks, and applies exactly the plan it
 * showed: the plan's single-use token is refused when the conversation changed
 * after the preview. Each action is a control on the conversation
 * (capabilities/builtin/conversation-controls.ts) run with this app's store,
 * the same the conversation's list and the model's capability_run reach;
 * `checkpointsOf` is this app's store as those capabilities take it. What
 * each app can do differently is its policy; an act an app does not have is
 * refused with the reason.
 */
import type { WorkspaceCheckpoint, WorkspaceCheckpointManager } from '@goodvibes/engine/platform/platform/workspace';
import { getTurnAnchors } from '@goodvibes/engine/platform/platform/rewind';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import {
  CHECKPOINT_LIST, CHECKPOINT_MAKE, CHECKPOINT_RESTORE, CHECKPOINT_REWIND,
  type CheckpointServices, type ConversationCheckpoints, type RewindScope,
} from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { sessionCapabilityAction } from './command-actions/capability-actions.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
import {
  formatCheckpointAge,
  resolveCheckpointRef,
  restoreCheckpointFiles,
  shortCheckpointId,
  type CheckpointCommandContext,
} from './recovery-commands.js';

export type { RewindScope } from '@goodvibes/engine/platform/platform/capabilities';

export interface CheckpointCommandShape extends CheckpointCommandContext, CommandActionContext {
  readonly renderRequest: () => void;
  readonly workspace: { readonly workspaceCheckpointManager?: WorkspaceCheckpointManager | undefined };
  readonly session: { readonly runtime: { readonly sessionId: string } };
}

export interface CheckpointCommandPolicy<Ctx> {
  /** Said when there is no checkpoint yet: how this app comes to have one. */
  readonly emptyHint: string;
  /** Makes a checkpoint now, or the reason this app makes none on request. */
  readonly make: ((ctx: Ctx, label: string) => Promise<WorkspaceCheckpoint | null>) | { readonly refused: string };
  /** Goes back to a turn after showing the plan and asking, or the reason this app cannot. */
  readonly rewind: ((ctx: Ctx, input: { readonly turn: string; readonly scope: RewindScope }) => Promise<string | void>) | { readonly refused: string };
}

function managerOf(ctx: CheckpointCommandShape): WorkspaceCheckpointManager {
  const manager = ctx.workspace.workspaceCheckpointManager;
  if (!manager) throw commandRefusal('Checkpoints are not available in this session.', undefined, 'UNAVAILABLE');
  return manager;
}

async function listOf(manager: WorkspaceCheckpointManager): Promise<WorkspaceCheckpoint[]> {
  try {
    return await manager.list();
  } catch (error) {
    throw commandRefusal(`Could not list the checkpoints: ${summarizeError(error)}`, undefined, 'NOT_DONE');
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** The workspace checkpoints (`checkpoints` in capabilities/builtin/conversation-controls.ts). */
export const CHECKPOINTS = defineList<CheckpointCommandShape>({
  name: 'checkpoints',
  async read(ctx) {
    const manager = ctx.workspace.workspaceCheckpointManager;
    if (!manager) return [];
    return (await manager.list()).map((checkpoint): ListRow => ({
      value: shortCheckpointId(checkpoint.id), label: checkpoint.label,
      detail: `${checkpoint.kind} · ${formatCheckpointAge(checkpoint.createdAt)}`, state: `~${formatBytes(checkpoint.sizeBytes)} new`,
    }));
  },
  operator: { terminalOnly: 'Checkpoints of this workspace are kept by the terminal app.' },
});

/** The open conversation's turns (`checkpoint.turns`). */
export const TURNS = defineList<CheckpointCommandShape>({
  name: 'checkpoint.turns',
  async read(ctx) {
    return [...getTurnAnchors(ctx.session.runtime.sessionId)].reverse().map((turn): ListRow => ({
      value: turn.turnId, label: turn.label, detail: formatCheckpointAge(turn.at), state: `${turn.messageCount} messages`,
    }));
  },
  operator: { terminalOnly: 'The turns are the open conversation\'s, in the terminal app.' },
});

/** This app's checkpoints as the conversation's checkpoint controls take them. */
export function checkpointsOf<Ctx extends CheckpointCommandShape>(policy: CheckpointCommandPolicy<Ctx>, ctx: Ctx): ConversationCheckpoints {
  const make = policy.make;
  const rewind = policy.rewind;
  return {
    async list() {
      const manager = managerOf(ctx);
      const checkpoints = await listOf(manager);
      const trimmed = manager.historyTrimmed();
      const retentionFailure = manager.retentionFailure();
      const notes = [
        ...(trimmed ? [`${trimmed.reason} (${trimmed.count} removed ${formatCheckpointAge(trimmed.at)}; the newest is always kept).`] : []),
        ...(retentionFailure ? [`Automatic retention is failing: ${retentionFailure.error}`] : []),
      ];
      if (checkpoints.length === 0) return [`No checkpoints yet. ${policy.emptyHint}`, ...notes].join('\n');
      // Files-changed counts are not shown per row: each would cost one diff
      // spawn per checkpoint. A restore loads exactly one diff and shows it.
      return [
        `Checkpoints (${checkpoints.length}, newest first):`,
        ...checkpoints.map((checkpoint, index) => `  ${String(index + 1).padStart(2)}. ${shortCheckpointId(checkpoint.id).padEnd(12)} ${checkpoint.kind.padEnd(9)} ${checkpoint.label}  ${formatCheckpointAge(checkpoint.createdAt)}  ~${formatBytes(checkpoint.sizeBytes)} new`),
        ...notes,
        'Put the files back to one with "Put the files back to a checkpoint" in This conversation (the files before it are kept as a checkpoint, and the conversation is unchanged).',
        ...('refused' in rewind ? [] : ['Go back to an earlier turn, files and conversation, with "Go back to an earlier turn" there.']),
      ].join('\n');
    },
    make: 'refused' in make ? make : async (label) => {
      let checkpoint: WorkspaceCheckpoint | null;
      try {
        checkpoint = await make(ctx, label);
      } catch (error) {
        throw commandRefusal(`No checkpoint was made: ${summarizeError(error)}`, undefined, 'NOT_DONE');
      }
      return checkpoint
        ? `Checkpoint ${shortCheckpointId(checkpoint.id)} "${checkpoint.label}" made; it is kept longer than the automatic ones.`
        : 'Nothing has changed since the last checkpoint, so none was made.';
    },
    async restore(ref) {
      const manager = managerOf(ctx);
      const resolved = resolveCheckpointRef(await listOf(manager), ref, '"See your checkpoints" in This conversation');
      if ('error' in resolved) throw commandRefusal(resolved.error, undefined, 'NOT_FOUND');
      const lines: string[] = [];
      // What the restore says, its receipt included, is its answer: the line typed prints it, a place shows it, a model reads it.
      await restoreCheckpointFiles({ ...ctx, print: (text: string) => { lines.push(text); } }, manager, resolved, { yes: false, record: (text) => { lines.push(text); }, sessionId: ctx.session.runtime.sessionId });
      return lines.join('\n');
    },
    rewind: 'refused' in rewind ? rewind : async (turn, scope) => (await rewind(ctx, { turn, scope })) ?? '',
  };
}

const LOCAL = { terminalOnly: 'Checkpoints of this workspace are kept by the terminal app.' } as const;

export function createCheckpointCommand<Ctx extends CheckpointCommandShape>(policy: CheckpointCommandPolicy<Ctx>): DescribedCommand<Ctx> {
  const services = (ctx: Ctx): CheckpointServices => ({ checkpoints: checkpointsOf(policy, ctx) });
  return defineCommand<Ctx>({
    name: 'checkpoint',
    title: 'Checkpoints',
    summary: 'Snapshots of the workspace\'s files: see them, make one, put the files back, or go back to an earlier turn',
    group: 'Conversation',
    report: 'list',
    // Unlisted: typed bare, it opens This conversation, where each checkpoint control is a row; typed with an action word it runs that control.
    firstScreen: false,
    opens: 'conversation',
    actions: [
      {
        ...sessionCapabilityAction<Ctx, CheckpointServices>(CHECKPOINT_LIST, services, LOCAL),
        readsOnlyThisMachine: true,
        async rowValue(ctx) {
          const manager = ctx.workspace.workspaceCheckpointManager;
          if (!manager) return 'not available here';
          const count = (await manager.list()).length;
          return count === 0 ? 'none yet' : `${count} kept`;
        },
      },
      sessionCapabilityAction<Ctx, CheckpointServices>(CHECKPOINT_MAKE, services, LOCAL),
      sessionCapabilityAction<Ctx, CheckpointServices>(CHECKPOINT_RESTORE, services, LOCAL),
      sessionCapabilityAction<Ctx, CheckpointServices>(CHECKPOINT_REWIND, services, { terminalOnly: 'It rewinds the conversation open in the terminal app.' }),
    ],
  });
}

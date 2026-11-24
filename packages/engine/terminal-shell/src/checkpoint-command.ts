/**
 * `/checkpoint`, described once (command-actions/) for both terminal apps:
 * see the workspace checkpoints, make one, put the files back to one, and go
 * back to an earlier turn (files, conversation or both). Going back reads the
 * plan, shows it on the Changes preview, asks, and applies exactly the plan it
 * showed: the plan's single-use token is refused when the conversation changed
 * after the preview. What each app can do differently is its policy, read by
 * the actions' `run`; an act an app does not have is refused with the reason.
 */
import type { WorkspaceCheckpoint, WorkspaceCheckpointManager } from '@goodvibes/engine/platform/platform/workspace';
import { getTurnAnchors } from '@goodvibes/engine/platform/platform/rewind';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, FixedChoice } from './command-actions/types.js';
import { choiceInput, doAction, listInput, readAction, textInput } from './described-command-kit.js';
import {
  formatCheckpointAge,
  resolveCheckpointRef,
  restoreCheckpointFiles,
  shortCheckpointId,
  type CheckpointCommandContext,
} from './recovery-commands.js';

export interface CheckpointCommandShape extends CheckpointCommandContext, CommandActionContext {
  readonly renderRequest: () => void;
  readonly workspace: { readonly workspaceCheckpointManager?: WorkspaceCheckpointManager | undefined };
  readonly session: { readonly runtime: { readonly sessionId: string } };
}

/** What going back to a turn takes back. */
export type RewindScope = 'files' | 'conversation' | 'both';

export interface CheckpointCommandPolicy<Ctx> {
  /** Puts the restore receipt where this app keeps such lines (the conversation, or the transcript). */
  readonly record: (ctx: Ctx, text: string) => void;
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

const CHECKPOINTS = defineList<CheckpointCommandShape>({
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

const TURNS = defineList<CheckpointCommandShape>({
  name: 'checkpoint.turns',
  async read(ctx) {
    return [...getTurnAnchors(ctx.session.runtime.sessionId)].reverse().map((turn): ListRow => ({
      value: turn.turnId, label: turn.label, detail: formatCheckpointAge(turn.at), state: `${turn.messageCount} messages`,
    }));
  },
  operator: { terminalOnly: 'The turns are the open conversation\'s, in the terminal app.' },
});

const SCOPES: readonly FixedChoice[] = [
  { value: 'both', label: 'Files and conversation' },
  { value: 'files', label: 'Files only', help: 'The conversation stays as it is' },
  { value: 'conversation', label: 'Conversation only', help: 'No file changes' },
];

const LOCAL = { terminalOnly: 'Checkpoints of this workspace are kept by the terminal app.' } as const;

export function createCheckpointCommand<Ctx extends CheckpointCommandShape>(policy: CheckpointCommandPolicy<Ctx>): DescribedCommand<Ctx> {
  return defineCommand<Ctx>({
    name: 'checkpoint',
    title: 'Checkpoints',
    summary: 'Snapshots of the workspace\'s files: see them, make one, put the files back, or go back to an earlier turn',
    group: 'Conversation',
    report: 'list',
    actions: [
      readAction<Ctx>({
        id: 'list', label: 'See your checkpoints', readsOnlyThisMachine: true, word: 'list', operator: LOCAL,
        sentence: 'Lists the workspace checkpoints, newest first, with how old each is and how much it added.',
        async rowValue(ctx) {
          const manager = ctx.workspace.workspaceCheckpointManager;
          if (!manager) return 'not available here';
          const count = (await manager.list()).length;
          return count === 0 ? 'none yet' : `${count} kept`;
        },
        async run(_values, ctx) {
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
            'Put the files back to one: /checkpoint restore <n|id> (at once; the files before it are kept as a checkpoint, and the conversation is unchanged).',
            'Go back to an earlier turn, files and conversation: /checkpoint rewind.',
          ].join('\n');
        },
      }),
      doAction<Ctx>({
        id: 'make', label: 'Make a checkpoint now', word: 'make', operator: LOCAL,
        inputs: [textInput({ id: 'label', label: 'Name', help: 'What to call it', why: 'a name you choose', typed: { tail: true }, optional: { default: '', means: 'a name made from the time' } })],
        sentence: 'The workspace\'s files as they are now are kept as a checkpoint, held longer than the automatic ones; nothing changes in the files.',
        example: { label: 'before the refactor' },
        async run(values, ctx) {
          if ('refused' in policy.make) throw commandRefusal(policy.make.refused, '/checkpoint list shows the checkpoints this workspace has.');
          let checkpoint: WorkspaceCheckpoint | null;
          try {
            checkpoint = await policy.make(ctx, values.label ?? '');
          } catch (error) {
            throw commandRefusal(`No checkpoint was made: ${summarizeError(error)}`, undefined, 'NOT_DONE');
          }
          return checkpoint
            ? `Checkpoint ${shortCheckpointId(checkpoint.id)} "${checkpoint.label}" made; it is kept longer than the automatic ones.`
            : 'Nothing has changed since the last checkpoint, so none was made.';
        },
      }),
      {
        id: 'restore', label: 'Put the files back to a checkpoint', word: 'restore',
        inputs: [listInput({ id: 'checkpoint', label: 'Checkpoint', help: 'Your checkpoints, newest first', list: CHECKPOINTS, other: 'a number from the list, newest first, or a checkpoint id' })],
        sentence: 'The workspace\'s files go back to checkpoint {checkpoint}; the current files are kept as a checkpoint first, which /checkpoint restore brings back, and the conversation is unchanged.',
        done: '', touches: 'this-machine', lasts: 'not-a-change', risk: 'none', asksItself: true,
        operator: LOCAL, example: { checkpoint: '1' },
        async run(values, ctx) {
          const manager = managerOf(ctx);
          const resolved = resolveCheckpointRef(await listOf(manager), values.checkpoint!, '/checkpoint list');
          if ('error' in resolved) throw commandRefusal(resolved.error, undefined, 'NOT_FOUND');
          await restoreCheckpointFiles(ctx, manager, resolved, { yes: false, record: (text) => policy.record(ctx, text) });
        },
      },
      {
        id: 'rewind', label: 'Go back to an earlier turn', word: 'rewind',
        inputs: [
          listInput({ id: 'turn', label: 'Turn', help: 'The turns of this conversation, newest first', list: TURNS, other: 'a number from the list, newest first, or a turn id' }),
          choiceInput({ id: 'scope', label: 'What goes back', help: 'The files, the conversation, or both', choices: SCOPES, typed: { position: 2 }, optional: { default: 'both', means: 'files and conversation' } }),
        ],
        sentence: 'What changed after turn {turn} is taken back ({scope}): messages after it are dropped and files go back to how they were then. /undo rewind brings them back only while no new message has been added.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', asksItself: true,
        riskDone: 'the dropped messages are gone once a new message is added; /undo rewind brings them back until then',
        operator: { terminalOnly: 'It rewinds the conversation open in the terminal app.' }, example: { turn: '2', scope: 'files' },
        async run(values, ctx) {
          if ('refused' in policy.rewind) throw commandRefusal(policy.rewind.refused, '/checkpoint restore puts the files back to a checkpoint.');
          return policy.rewind(ctx, { turn: values.turn!, scope: (values.scope || 'both') as RewindScope });
        },
      },
    ],
  });
}

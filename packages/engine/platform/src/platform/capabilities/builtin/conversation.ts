/**
 * The conversation's own capabilities: they act on the live conversation, so
 * they run in the program holding it (home `session`), with the program's own
 * conversation and file undo stack handed in. Nothing here reaches a screen;
 * the program draws what changed.
 */
import type { FileUndoManager } from '../../state/file-undo.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { NOTHING_TO_COMPACT_YET, NothingToCompactError } from '../../core/compaction-types.js';
import { CapabilityRefusal, type CapabilityDefinition, type FixedChoice } from '../types.js';

/** The live conversation, as the program holding it exposes it. */
export interface LiveConversation {
  /** A turn is running now. */
  isGenerating(): boolean;
  /** Messages the conversation holds for the model. */
  messageCount(): number;
  /** Save this conversation as its own session and start a fresh one; the name it was saved as, or null. */
  startFresh(): { readonly savedAs: string | null };
  /** Summarise the older part (the program's own compaction); what happened, in words. */
  compact(): Promise<string>;
  /** Take back the last turn; false when there is none. */
  undoTurn(): boolean;
}

export interface ClearServices { readonly conversation: Pick<LiveConversation, 'isGenerating' | 'startFresh'> }
export interface CompactServices { readonly conversation: Pick<LiveConversation, 'isGenerating' | 'messageCount' | 'compact'> }
export interface UndoServices {
  readonly conversation: Pick<LiveConversation, 'isGenerating' | 'undoTurn'>;
  /** The per-call file undo stack the write and edit tools fill. */
  readonly files?: (Pick<FileUndoManager, 'undo' | 'redo'> & Partial<Pick<FileUndoManager, 'discard'>>) | undefined;
  /** Undo the last /checkpoint rewind (and redo the one undone last); absent in a program that has no rewind. */
  readonly rewind?: { undo(): Promise<string>; redo?: (() => Promise<string>) | undefined } | undefined;
}

/** The refusal every conversation capability gives while a turn runs. */
function refuseWhileTurnRuns(conversation: Pick<LiveConversation, 'isGenerating'>, line: string, nothing = 'did nothing'): void {
  if (conversation.isGenerating()) throw new CapabilityRefusal(`A turn is still running, so ${line} ${nothing}.`, `Stop it with Esc or let it finish, then ${line}.`, 'TURN_RUNNING');
}

export const CONVERSATION_CLEAR: CapabilityDefinition<ClearServices> = {
  capability: { id: 'conversation.clear', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'clear', label: 'Start a fresh conversation', word: '', inputs: [],
  sentence: 'Starts over: the current conversation is saved as its own session and a fresh chat starts; /resume brings the saved one back.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    if (services.conversation.isGenerating()) throw new CapabilityRefusal('A turn is still running, so nothing was cleared.', 'Stop it with Esc or let it finish, then /clear.', 'TURN_RUNNING');
    let saved: { readonly savedAs: string | null };
    try {
      saved = services.conversation.startFresh();
    } catch (error) {
      throw new CapabilityRefusal(`Could not save the current conversation, so nothing was cleared: ${summarizeError(error)}`);
    }
    return { text: '', data: { savedAs: saved.savedAs } };
  },
};

export const CONVERSATION_COMPACT: CapabilityDefinition<CompactServices> = {
  capability: { id: 'conversation.compact', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'compact', label: 'Compact the conversation now', word: '', inputs: [],
  sentence: 'The conversation is made shorter: the older messages are replaced by a summary, so the model has room again; /session compactions lists what each compaction removed.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    if (services.conversation.messageCount() === 0) throw new NothingToCompactError(NOTHING_TO_COMPACT_YET);
    return { text: await services.conversation.compact() };
  },
};

const UNDO_CHOICES: readonly FixedChoice[] = [
  { value: 'turn', label: 'The last turn', help: 'Your last message and its answer' },
  { value: 'file', label: 'The last file change', help: 'Every file the last write or edit changed goes back' },
  { value: 'set-aside', label: 'Set aside a blocked file change', help: 'A later change blocks it; set it aside without changing a file' },
  { value: 'rewind', label: 'The last rewind', help: 'The conversation and files go back to before the last /checkpoint rewind' },
];

export const CONVERSATION_UNDO: CapabilityDefinition<UndoServices> = {
  capability: { id: 'conversation.undo', group: 'conversation', home: 'session', repeat: 'unsafe' },
  actionId: 'undo', label: 'Undo the last step', word: '',
  inputs: [{ id: 'what', label: 'What', help: 'What to take back', kind: 'choice', choices: UNDO_CHOICES, required: { default: 'turn', defaultMeans: 'the last turn' }, typed: { position: 1 } }],
  sentence: 'The last step of the kind chosen is taken back; /redo brings it back.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { what: 'file' },
  async run(values, services) {
    const what = values.what || 'turn';
    if (what === 'file') {
      if (!services.files) throw new CapabilityRefusal('File undo is not available in this session.', undefined, 'UNAVAILABLE');
      let result: ReturnType<NonNullable<UndoServices['files']>['undo']>;
      try { result = services.files.undo(); } catch (error) { throw new CapabilityRefusal(`File undo failed: ${summarizeError(error)}`, undefined, 'NOT_DONE'); }
      return { text: result
        ? `${result.paths.length === 1 ? 'File' : `${result.paths.length} files`} reverted (last ${result.tool} call):\n${result.paths.map((path) => `  ${path}`).join('\n')}\nUse /redo file to re-apply.`
        : 'Nothing to undo. No file operations recorded.', data: { what, paths: result?.paths ?? [] } };
    }
    if (what === 'set-aside') {
      if (!services.files?.discard) throw new CapabilityRefusal('File undo is not available in this session.', undefined, 'UNAVAILABLE');
      const dropped = services.files.discard('undo');
      return { text: dropped
        ? `Dropped the newest undo entry (${dropped.tool} call) without changing any file:\n${dropped.paths.map((path) => `  ${path}`).join('\n')}\nThe next /undo file acts on the one before it.`
        : 'Nothing to drop: no undo entries are recorded.', data: { what, paths: dropped?.paths ?? [] } };
    }
    if (what === 'rewind') {
      if (!services.rewind) throw new CapabilityRefusal('The Agent has no rewind to undo: /checkpoint rewind goes back to a turn only in the terminal app.');
      return { text: await services.rewind.undo(), data: { what } };
    }
    refuseWhileTurnRuns(services.conversation, '/undo');
    if (!services.conversation.undoTurn()) throw new CapabilityRefusal('There is nothing to undo.', 'To take back the last file write or edit: /undo file');
    return { text: 'Last turn undone; /redo brings it back.', data: { what } };
  },
};

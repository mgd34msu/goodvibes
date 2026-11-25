import { captureTranscriptSource, readTranscriptIndex, transcriptReadingCanceled, TRANSCRIPT_UNAVAILABLE } from './transcript-reading.js';
import { describeUnknownTranscriptKind, readTranscriptKind } from './transcript-kinds.js';
import type { ComposerStateInput, ComposerState } from './composer-state.js';
import type { TranscriptEventKind } from '@goodvibes/engine/platform/platform/core';
import type { ConversationManager, TranscriptReadingOptions } from '@goodvibes/engine/platform/platform/core';
import type { TranscriptCommandContext } from './transcript-reading.js';
import type { UiSessionSnapshot } from '@goodvibes/engine/platform/platform/runtime/ui';
import { commandRefusal } from './command-confirmation.js';
type RuntimeTranscriptConversation = Pick<ConversationManager, 'getMessageSnapshot' | 'getTranscriptEventIndex' | 'getMessageCount'> & {
  nextTranscriptEventLine(currentLine: number, kind?: TranscriptEventKind | 'all', options?: TranscriptReadingOptions): Promise<number>;
  prevTranscriptEventLine(currentLine: number, kind?: TranscriptEventKind | 'all', options?: TranscriptReadingOptions): Promise<number>;
};
export interface ConversationRuntimeContext extends TranscriptCommandContext<RuntimeTranscriptConversation> {
  print(text: string): void;
  readonly getScrollTop?: (() => number) | undefined;
  readonly scrollToLine?: ((line: number) => void) | undefined;
}
/**
 * Reading the open conversation for `/session`'s "Look through this
 * conversation" actions: find words, jump to the next or previous entry of a
 * kind, what the composer waits on, and what a resume brought back.
 */
export function createConversationReading<Context extends ConversationRuntimeContext>(
  readSession: (context: Context) => UiSessionSnapshot,
  deriveComposerState: (input: ComposerStateInput) => ComposerState,
) {


function buildComposerReview(ctx: Context): string[] {
  const session = readSession(ctx);
  const composer = deriveComposerState({
    text: '',
    commandMode: false,
    pendingApproval: session.pendingApproval,
    hasAttachments: false,
    turnState: session.turnState,
  });
  return [
    'Composer Review',
    `  mode: ${composer.modeLabel}`,
    `  status: ${composer.statusLabel}`,
    `  risk: ${composer.pendingRisk}`,
    `  flags: ${composer.flags.length > 0 ? composer.flags.join(', ') : 'none'}`,
    `  turn state: ${session.turnState}`,
    `  messages: ${session.messageCount || ctx.session.conversationManager.getMessageCount()}`,
    `  context tokens: ${session.estimatedContextTokens}`,
    `  context warning: ${session.contextWarningActive ? 'yes' : 'no'}`,
  ];
}

async function buildConversationSearch(ctx: Context, query: string, kind: TranscriptEventKind | 'all', source: ReturnType<typeof captureTranscriptSource<RuntimeTranscriptConversation>>): Promise<string[]> {
  const index = await readTranscriptIndex(ctx, source);
  if (!index) return [TRANSCRIPT_UNAVAILABLE];
  const q = query.trim().toLowerCase();
  const events = (kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind))
    .filter((event) => q.length === 0 || event.title.toLowerCase().includes(q) || event.detail.toLowerCase().includes(q));
  return [
    `Conversation Search${kind === 'all' ? '' : `: ${kind}`}`,
    `  query: ${query || '(empty)'}`,
    `  matches: ${events.length}`,
    ...events.slice(0, 16).map((event) => `  #${String(event.messageIndex).padStart(3)}  ${event.kind.padEnd(20)} ${event.title} - ${event.detail}`),
    ...(events.length > 16 ? [`  ... ${events.length - 16} more match(es)`] : []),
  ];
}

async function buildConversationRestoreReview(ctx: Context, source: ReturnType<typeof captureTranscriptSource<RuntimeTranscriptConversation>>): Promise<string[]> {
  const index = await readTranscriptIndex(ctx, source);
  if (!index) return [TRANSCRIPT_UNAVAILABLE];
  const restoreKinds = new Set<TranscriptEventKind>([
    'session_restore',
    'approval_request',
    'approval_resolution',
    'task_transition',
    'remote_status',
    'diagnostic_notice',
  ]);
  const events = index.events.filter((event) => restoreKinds.has(event.kind));
  return [
    'Conversation Restore Review',
    `  restore-relevant events: ${events.length}`,
    ...events.slice(0, 16).map((event) => `  #${String(event.messageIndex).padStart(3)}  ${event.kind.padEnd(20)} ${event.title} - ${event.detail}`),
    ...(events.length > 16 ? [`  ... ${events.length - 16} more restore event(s)`] : []),
    '  next: Sessions, Record, "Where it spent most"; or Sessions for your saved sessions',
  ];
}

  /** Run one reading against a captured transcript source; a reading cut short by a newer one says nothing. */
  async function withSource(ctx: Context, read: (source: ReturnType<typeof captureTranscriptSource<RuntimeTranscriptConversation>>) => Promise<string[]>): Promise<void> {
    const source = captureTranscriptSource(ctx);
    try {
      const lines = await read(source);
      source.assertPublishable();
      ctx.print(lines.join('\n'));
    } catch (error) {
      try { source.assertPublishable(); } catch { return; }
      if (!transcriptReadingCanceled(error)) throw commandRefusal(TRANSCRIPT_UNAVAILABLE);
    }
  }
  function kindOf(word: string): TranscriptEventKind | 'all' {
    const kind = readTranscriptKind(word || undefined);
    if (kind === undefined) throw commandRefusal(describeUnknownTranscriptKind(word));
    return kind;
  }
  return {
    find: (ctx: Context, query: string, kind: string) => withSource(ctx, (source) => buildConversationSearch(ctx, query, kindOf(kind), source)),
    restored: (ctx: Context) => withSource(ctx, (source) => buildConversationRestoreReview(ctx, source)),
    composer: (ctx: Context) => { ctx.print(buildComposerReview(ctx).join('\n')); },
    async jump(ctx: Context, direction: 'next' | 'prev', word: string): Promise<void> {
      const kind = kindOf(word);
      const source = captureTranscriptSource(ctx);
      const currentLine = ctx.getScrollTop?.() ?? 0;
      const targetLine = direction === 'next'
        ? await source.conversation.nextTranscriptEventLine(currentLine, kind, { assertCurrent: source.assertCurrent, lifetime: source.lifetime })
        : await source.conversation.prevTranscriptEventLine(currentLine, kind, { assertCurrent: source.assertCurrent, lifetime: source.lifetime });
      source.assertPublishable();
      if (targetLine < 0) throw commandRefusal(`No ${kind === 'all' ? '' : `${kind} `}entries ${direction === 'next' ? 'after' : 'before'} this point.`);
      ctx.scrollToLine?.(targetLine);
      ctx.print(`Jumped to ${kind === 'all' ? `the ${direction === 'next' ? 'next' : 'previous'} entry` : `a ${kind} entry`} at line ${targetLine + 1}.`);
    },
  };
}

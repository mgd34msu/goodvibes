import { providerConversation, withHostMessage } from './conversation-provider-projection.js';
import { HostInstructionChannel, type HostInstructions } from './host-instructions.js';
import { declaredNoticePresentation, storedRuntimeEvent } from '../runtime/runtime-event-notices.js';
import type { SystemMessagePresentation } from '../runtime/system-message-presentation.js';
import type { SystemMessageKind, SystemMessagePriorityLevel } from '../runtime/system-message-policy.js';
import type { RuntimeEventProvenance } from '../../events/occurrence.js';
import type { ProviderMessage, ContentPart } from '../providers/interface.js';
import type { ToolCall, ToolHostEvidence, ToolResult } from '../types/tools.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CompactionContext } from './context-compaction.js';
import type { CompactionReceipt } from './compaction-types.js';
import type { SessionMemoryStore } from './session-memory.js';
import type { SessionLineageTracker } from './session-lineage.js';
import { buildTranscriptEventIndex, TranscriptSourceChangedError, type TranscriptReadingOptions } from './transcript-events/index.js';
import { compactConversation } from './conversation-compaction.js';
import {
  cloneBranchMap,
  cloneMessages,
  deriveConversationTitle,
  restoreKeptMessages,
  restoreBranchMap,
} from './conversation-utils.js';
import { logger } from '../utils/logger.js';
import { revisionSource, type RevisionSource } from '../utils/revision.js';
import { archiveVerificationCompaction, detachVerificationMessages, forkVerificationArchive, isVerificationRuntimeMessage, mergeVerificationArchive, resetVerificationArchives,
  restoreVerificationBranch, restoreVerificationMessages, retainVerificationMessagePositions, switchVerificationArchive, updateVerificationMessage } from './verification/archive.js';

export type TranscriptEventIndex = Awaited<ReturnType<typeof buildTranscriptEventIndex>>;

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
};

type AssistantMessage = {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[] | undefined;
  reasoningContent?: string | undefined;
  reasoningSummary?: string | undefined;
  usage?: TokenUsage | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  /** A completed acknowledgement request; billed independently, without the main turn's tool definitions. */
  followUp?: true | undefined;
};

export type NoticeLevel = 'info' | 'success' | 'warning' | 'error';
export type NoticeKind = SystemMessageKind;
/** What the writer of a notice knows about it, stored on the message so no reader has to work it out again. */
export interface NoticeMeta {
  readonly level: NoticeLevel;
  readonly kind?: NoticeKind | undefined;
  readonly priority?: SystemMessagePriorityLevel | undefined;
}

/** The level a line takes when its writer declared nothing: shown as information, never read by a model. */
export const INFO_NOTICE: NoticeMeta = Object.freeze({ level: 'info' });

/** The transcript colour of a declared notice. */
export function noticePresentation(notice: NoticeMeta): SystemMessagePresentation {
  return Object.freeze({ severity: notice.level === 'error' ? 'error' : notice.level === 'warning' ? 'warning' : 'info' });
}

const SEVERITIES: ReadonlySet<string> = new Set(['error', 'warning', 'info']);

/** A presentation saved in a session file, kept when it names a severity this build shows. */
function storedPresentation(value: unknown): SystemMessagePresentation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const severity = (value as { severity?: unknown }).severity;
  return typeof severity === 'string' && SEVERITIES.has(severity) ? Object.freeze({ ...(value as SystemMessagePresentation) }) : undefined;
}

export type ConversationMessageSnapshot =
  | { role: 'user'; content: string | ContentPart[]; cancelled?: boolean }
  | AssistantMessage
  | { role: 'system'; content: string; runtimeEvent?: RuntimeEventProvenance | undefined; presentation?: SystemMessagePresentation | undefined;
    /** Present when the writer declared the notice (addNotice); absent on older lines. */
    notice?: NoticeMeta | undefined }
  | {
    role: 'tool';
    callId: string;
    content: string;
    toolName?: string;
    /** Typed execution state. Absent on legacy/imported results whose outcome is unknown. */
    outcome?: 'ok' | 'error' | 'cancelled';
    /** Host-only facts the tool reported beside its text (a read's observations); saved with the message, never shown to the model. */
    hostEvidence?: ToolHostEvidence | undefined;
  };

type Message = ConversationMessageSnapshot;
export type ConversationTitleSource = 'system' | 'user';

export interface BlockMeta {
  type: 'tool' | 'code' | 'diff' | 'thinking';
  rawContent: string;
  filePath?: string | undefined;
  diffOriginal?: string | undefined;
  diffUpdated?: string | undefined;
  /** Why the diff cannot be applied as one replacement (several hunks or files). */
  unsupported?: string | undefined;
}

function sameTokenUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens
  );
}

function sameToolCalls(a: ToolCall[] | undefined, b: ToolCall[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((call, index) => {
    const other = b[index];
    return other !== undefined && call.id === other.id && call.name === other.name
      && JSON.stringify(call.arguments) === JSON.stringify(other.arguments);
  });
}

/**
 * True when `candidate` is the SAME assistant message the store already holds
 * at its tail, a re-delivery, not a new turn.
 *
 * The defect this closes: a hosted conversation opens a fresh event stream per
 * turn and never sends `Last-Event-ID`, so the gateway's catch-up replay
 * re-sends the tail of the previous turn's events, including its
 * `TURN_COMPLETED`, into the next turn's renderer. That renderer has never
 * seen the event, so it appends the previous turn's final assistant message a
 * second time, byte-identical and carrying the identical usage numbers. The
 * observed recovery journal held exactly that: one turn's final message twice,
 * same content, same usage.
 *
 * Why matching on content is safe here rather than merely plausible: this only
 * compares against the IMMEDIATELY PRECEDING message. Two identical assistant
 * messages with nothing between them do not occur in an honest turn, a real
 * repeat is separated by the user message that prompted it, or by the tool
 * messages that answer the tool calls, and either one moves the tail. Requiring
 * the usage counters to match as well means a genuine second call (which bills
 * its own tokens) is not mistaken for a replay.
 *
 * This is the store boundary on purpose. Every durable writer, the recovery
 * snapshot and the session store, serializes this
 * message array, so one guard here covers all of them, and none of them needs
 * its own idea of what a duplicate is.
 *
 * Note this suppresses the SYMPTOM at the boundary where correctness is
 * cheapest to guarantee. The upstream cause (the client not resuming its stream
 * position) is worth fixing on its own, because the same replayed frame also
 * marks the new turn's renderer finished.
 */
function isRedeliveredAssistantMessage(
  previous: Message | undefined,
  candidate: AssistantMessage,
): boolean {
  // Follow-ups are appended once per completed provider request, not replayed
  // TURN_COMPLETED events. Distinct billed requests may have identical replies.
  if (candidate.followUp) return false;
  if (previous === undefined || previous.role !== 'assistant') return false;
  return (
    previous.content === candidate.content &&
    previous.model === candidate.model &&
    previous.provider === candidate.provider &&
    previous.followUp === candidate.followUp &&
    previous.reasoningContent === candidate.reasoningContent &&
    previous.reasoningSummary === candidate.reasoningSummary &&
    sameTokenUsage(previous.usage, candidate.usage) &&
    sameToolCalls(previous.toolCalls, candidate.toolCalls)
  );
}

export class ConversationManager {
  private messages: Message[] = [];
  private _title = '';
  private _titleSource: ConversationTitleSource = 'system';
  private sessionMemoryStore: Pick<SessionMemoryStore, 'list'> | null = null;
  private sessionLineageTracker: Pick<SessionLineageTracker, 'addCompactionEntry'> = {
    addCompactionEntry: () => {},
  };
  private branches = new Map<string, Message[]>();
  private currentBranch = 'main';
  private streamingMessageIndex = -1;
  private undoStack: Message[][] = [];
  private _messagesRevision = 0;
  /** Revisions that only added a notice; see `workRevision`. */
  private _noticeRevisions = 0;
  readonly #revisionSource = revisionSource('conversation', () => this._messagesRevision);
  private _cachedLLMMessages: ProviderMessage[] | null = null;
  private _cachedLLMRevision = -1;
  private transcriptIndex: { readonly revision: number; readonly index: TranscriptEventIndex } | undefined;
  /**
   * What the host tells the model for the next request(s), sent after the
   * history as one trailing message (host-instructions.ts). Not history: not
   * saved, not shown, and it does not move the message revision.
   */
  readonly hostInstructions: HostInstructions = new HostInstructionChannel();
  /** Run as each provider request is assembled, before the host channel is read (see `onRequest`). */
  readonly #requestHooks = new Set<() => void>();

  constructor() {}

  /**
   * Run `hook` as each provider request is assembled, before the host channel
   * is read, so something the host learned since the last request (the owner's
   * answer to a question this session asked) rides this one. A hook must be
   * cheap and must not throw; a throw is logged and the request goes on.
   * Returns the function that removes it.
   */
  onRequest(hook: () => void): () => void {
    this.#requestHooks.add(hook);
    return () => { this.#requestHooks.delete(hook); };
  }

  /** Every change to the message history (append, stream update, undo, branch switch, compaction, reset) as a revision source. */
  get revisionSource(): RevisionSource { return this.#revisionSource; }

  /**
   * The revision of what was said and done: every change except a notice
   * appended for the person. A notice is not an observation of work, so a
   * check of the work (completion evidence, a compaction that failed) does
   * not have to start again when one arrives.
   */
  get workRevision(): number { return this._messagesRevision - this._noticeRevisions; }

  private findToolName(callId: string): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!;
      if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
      const match = message.toolCalls.find((call) => call.id === callId);
      if (match?.name) return match.name;
    }
    return undefined;
  }

  public setSessionMemoryStore(store: Pick<SessionMemoryStore, 'list'>): void {
    this.sessionMemoryStore = store;
  }

  public getSessionMemoryStore(): Pick<SessionMemoryStore, 'list'> | null {
    return this.sessionMemoryStore;
  }

  public setSessionLineageTracker(tracker: Pick<SessionLineageTracker, 'addCompactionEntry'>): void {
    this.sessionLineageTracker = tracker;
  }

  public getSessionLineageTracker(): Pick<SessionLineageTracker, 'addCompactionEntry'> {
    return this.sessionLineageTracker;
  }

  /**
   * Returns the conversation messages formatted for the LLM provider.
   *
   * @returns readonly reference, do not mutate; the array is shared across
   *   cache-hit callers until the next conversation mutation.
   */
  public getMessagesForLLM(): ProviderMessage[] {
    if (this._cachedLLMMessages !== null && this._cachedLLMRevision === this._messagesRevision) {
      return this._cachedLLMMessages;
    }
    const result = providerConversation(this.messages);
    this._cachedLLMMessages = result;
    this._cachedLLMRevision = this._messagesRevision;
    return result;
  }

  /**
   * The messages of one provider request: the history, then the host channel's
   * text when any is set. Call once per request and call
   * `hostInstructions.delivered()` after the provider accepted it.
   */
  public getMessagesForRequest(): ProviderMessage[] {
    for (const hook of this.#requestHooks) {
      try {
        hook();
      } catch (error) {
        logger.warn('ConversationManager: a request hook failed; the request goes on without it', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return withHostMessage(this.getMessagesForLLM(), this.hostInstructions.render());
  }

  public addUserMessage(content: string | ContentPart[]): void {
    if (this._title === '' && typeof content === 'string' && content.trim().length > 0) {
      this.setSystemTitle(deriveConversationTitle(content));
    }
    this.messages.push({ role: 'user', content });
    // Clear undo stack when new user input is added (can't redo past new input)
    this.undoStack = [];
    this._messagesRevision++;
    const position = this.messages.length - 1;
    retainVerificationMessagePositions(this, original => original < position ? original : undefined);
  }

  public addAssistantMessage(
    content: string,
    opts?: {
      toolCalls?: ToolCall[] | undefined;
      reasoningContent?: string | undefined;
      reasoningSummary?: string | undefined;
      usage?: TokenUsage | undefined;
      model?: string | undefined;
      provider?: string | undefined;
      followUp?: true | undefined;
    },
  ): void {
    // An answer held on screen while it was checked is replaced by the message itself.
    this.releaseHeldReply();
    const candidate: AssistantMessage = {
      role: 'assistant',
      content,
      // The history keeps its own copy, so the caller's array cannot change it without moving the revision.
      toolCalls: opts?.toolCalls ? structuredClone(opts.toolCalls) : undefined,
      reasoningContent: opts?.reasoningContent,
      reasoningSummary: opts?.reasoningSummary,
      usage: opts?.usage,
      model: opts?.model,
      provider: opts?.provider,
      ...(opts?.followUp ? { followUp: true as const } : {}),
    };
    if (isRedeliveredAssistantMessage(this.messages[this.messages.length - 1], candidate)) {
      // Dropped on purpose, see isRedeliveredAssistantMessage. Recorded rather
      // than swallowed: a message that does not land must be explainable later.
      logger.debug('[conversation] dropped a re-delivered assistant message', {
        contentLength: content.length,
        ...(opts?.usage ? { outputTokens: opts.usage.outputTokens } : {}),
      });
      return;
    }
    this.messages.push(candidate);
    this._messagesRevision++;
  }

  /**
   * undo - Remove the last complete turn (the last user message and all subsequent
   * non-user messages). Pushes the removed messages onto the undo stack.
   * Returns true if a turn was removed, false if there was nothing to undo.
   */
  public undo(): boolean {
    let lastUserIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      // Host-made user-role messages (tool-result images) belong to the turn, not start it.
      if (msg?.role === 'user' && !isVerificationRuntimeMessage(this, i)) {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return false;
    const turn = this.messages.slice(lastUserIdx);
    // Archive first: if the journal write fails, conversation and archive are both unchanged.
    detachVerificationMessages(this, lastUserIdx, turn);
    this.messages.splice(lastUserIdx);
    this.undoStack.push(turn);
    this._messagesRevision++;
    return true;
  }

  /**
   * redo - Restore the most recently undone turn.
   * Returns true if a turn was restored, false if the undo stack is empty.
   */
  public redo(): boolean {
    if (this.undoStack.length === 0) return false;
    const turn = this.undoStack[this.undoStack.length - 1]!;
    const start = this.messages.length;
    restoreVerificationMessages(this, start, turn);
    this.undoStack.pop();
    this.messages.push(...turn);
    this._messagesRevision++;
    return true;
  }

  public addToolResults(results: ToolResult[]): void {
    for (const result of results) {
      // `output` must never be silently dropped on failure, many tools (e.g. exec)
      // put the full diagnostic payload (exit code, stdout, stderr) in `output` even
      // when `success` is false, and leave `error` unset for that failure shape.
      const content = result.output !== undefined
        ? (result.success ? result.output : `Error: ${result.error ? result.error + '\n' : ''}${result.output}`)
        : result.success
          ? 'Tool completed successfully.'
          : `Error: ${result.error ?? 'Unknown error'}`;
      const toolName = this.findToolName(result.callId);
      this.messages.push({
        role: 'tool',
        callId: result.callId,
        content,
        outcome: result.cancelled === true ? 'cancelled' : result.success ? 'ok' : 'error',
        ...(toolName ? { toolName } : {}),
        ...(result.hostEvidence ? { hostEvidence: structuredClone(result.hostEvidence) } : {}),
      });
    }
    this._messagesRevision++;
  }

  /**
   * A line for the person restating a runtime event the producer declared
   * (agent finished, turn cancelled, contract state). Its level comes from the
   * declared event. Display only, like every notice: no model reads it. Any
   * other line is written with `addNotice` and the level its writer knows.
   */
  public addEventNotice(content: string, runtimeEvent: RuntimeEventProvenance): void {
    const presentation = declaredNoticePresentation(content, runtimeEvent) ?? noticePresentation(INFO_NOTICE);
    this.messages.push({ role: 'system', content, presentation,
      ...(runtimeEvent ? { runtimeEvent: storedRuntimeEvent(runtimeEvent) } : {}),
    });
    this._messagesRevision++;
    this._noticeRevisions++;
  }

  /**
   * A line for the person, with what the writer knows about it: its level,
   * and optionally its kind and priority. Display only: it is saved with the
   * history and never sent to the model (that is `hostInstructions`). The level
   * is stored on the message, so showing, restoring or branching it asks no
   * model what it means.
   */
  public addNotice(content: string, meta: NoticeMeta): void {
    const notice: NoticeMeta = Object.freeze({ level: meta.level,
      ...(meta.kind ? { kind: meta.kind } : {}), ...(meta.priority ? { priority: meta.priority } : {}) });
    this.messages.push({ role: 'system', content, notice, presentation: noticePresentation(notice) });
    this._messagesRevision++;
    this._noticeRevisions++;
  }

  public getLastUserMessage(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg?.role === 'user' && !isVerificationRuntimeMessage(this, i)) {
        if (typeof msg.content === 'string') return msg.content;
        // A message with attachments: its text is the text parts, in order.
        const text = msg.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
        return text || null;
      }
    }
    return null;
  }

  public getMessageCount(): number {
    return this.messages.length;
  }

  public removeMessagesAfter(count: number, options: { readonly preserveCompletedTools?: boolean } = {}): void {
    if (count < this.messages.length) {
      let keptPositions: Map<number, number> | undefined;
      if (options.preserveCompletedTools) {
        // Tool batches are appended only after their results settle. Preserve
        // their exact call/result pairs: interrupting a later private answer
        // does not undo executed work. Unsent assistant drafts never become
        // saved answers, including drafts between completed tool batches.
        let through = count;
        for (let index = count; index < this.messages.length; index++) if (this.messages[index]?.role === 'tool') through = index + 1;
        const positions = new Map<number, number>();
        this.messages = this.messages.filter((message, index) => {
          const keep = index < count || message.role === 'user' || message.role === 'system'
            || index < through && (message.role === 'tool' || message.role === 'assistant' && !!message.toolCalls?.length);
          if (keep) positions.set(index, positions.size);
          return keep;
        });
        keptPositions = positions;
      } else this.messages.length = count;
      this.streamingMessageIndex = -1;
      this._messagesRevision++;
      const positions = keptPositions;
      retainVerificationMessagePositions(this, original => positions ? positions.get(original) : original < count ? original : undefined);
    }
  }

  public markLastUserMessageCancelled(beforeCount = this.messages.length): void {
    for (let i = Math.min(beforeCount, this.messages.length) - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg?.role === 'user') {
        const before = { ...msg };
        (msg as { cancelled?: boolean }).cancelled = true;
        this._messagesRevision++;
        updateVerificationMessage(this, i, before, msg);
        return;
      }
    }
  }

  /** True while a reply is still arriving: the last assistant message is cut off until the stream ends. */
  public hasPartialReply(): boolean {
    return this.streamingMessageIndex >= 0;
  }

  public startStreamingBlock(): void {
    this.releaseHeldReply();
    this.messages.push({ role: 'assistant', content: '' });
    this.streamingMessageIndex = this.messages.length - 1;
    this._messagesRevision++;
  }

  public updateStreamingBlock(content: string): void {
    if (this.streamingMessageIndex < 0) return;
    const message = this.messages[this.streamingMessageIndex];
    if (message?.role === 'assistant') {
      message.content = content;
      this._messagesRevision++;
    }
  }

  public finalizeStreamingBlock(): void {
    let removed: number | undefined;
    if (this.streamingMessageIndex >= 0 && this.messages[this.streamingMessageIndex]?.role === 'assistant') {
      removed = this.streamingMessageIndex;
      this.messages.splice(this.streamingMessageIndex, 1);
    }
    this.streamingMessageIndex = -1;
    this._messagesRevision++;
    if (removed !== undefined) {
      const position = removed;
      retainVerificationMessagePositions(this, original => original === position ? undefined : original > position ? original - 1 : original);
    }
  }

  /**
   * The stream ended with an answer that is not a message yet (its completion
   * check is running): the block leaves the history like a finalized one, so
   * no request and no evidence reads it, while a display may keep showing it
   * until `releaseHeldReply`. A manager with no display just finalizes it.
   */
  public holdStreamingBlock(): void {
    this.finalizeStreamingBlock();
  }

  /** A held answer is no longer shown: it became a message, was withdrawn, or the turn ended. */
  public releaseHeldReply(): void {}

  public getMessageSnapshot(): ConversationMessageSnapshot[] {
    return cloneMessages(this.messages);
  }

  /** A copy of the last `count` messages only, for a reading that needs the recent exchange and not the history. */
  public getRecentMessageSnapshot(count: number): ConversationMessageSnapshot[] {
    return cloneMessages(this.messages.slice(-Math.max(0, count)));
  }

  /** The text of one message, read in place (no copy); undefined when the index is out of range or the content is not plain text. */
  public messageTextAt(index: number): string | undefined {
    const content = this.messages[index]?.content;
    return typeof content === 'string' ? content : undefined;
  }

  /**
   * The history itself, read in place: no copy. For a reader that walks the
   * history on every frame (the transcript display). The caller must not
   * change it and must not keep it past the step it is used in: any change
   * moves `revisionSource`, and a caller that holds results compares that.
   */
  public readMessagesInPlace(): readonly ConversationMessageSnapshot[] {
    return this.messages;
  }

  /** True when a system message satisfies the test; scans in place so a per-check liveness probe does not deep-copy the history. */
  public hasSystemMessage(test: (message: Readonly<Extract<ConversationMessageSnapshot, { role: 'system' }>>) => boolean): boolean {
    return this.messages.some((message) => message.role === 'system' && test(message));
  }

  /**
   * The history completion evidence is read from, and the revision it stands
   * at. Every change to the history (append, stream update, undo, branch,
   * compaction, load) moves the revision, and the message objects are this
   * manager's own (handed out only as copies), so "still the same history" is
   * an identity and an integer compare: no per-message walk, no copy and no
   * serialisation per check, whatever the transcript's length.
   */
  public captureMessageEvidence(): { snapshot: ConversationMessageSnapshot[]; native: boolean; assertCurrent: () => void; assertFinalized: (response: string) => void } {
    const messages = this.messages, revision = this.workRevision, snapshot = this.getMessageSnapshot, length = messages.length;
    const assertPrefix = () => {
      if (this.messages !== messages || this.getMessageSnapshot !== snapshot || messages.length < length) throw new TranscriptSourceChangedError();
    };
    // A notice for the person is not evidence: one appended after the capture changes nothing checked.
    const addedWork = () => messages.slice(length).filter(message => message.role !== 'system');
    const assertCurrent = () => {
      assertPrefix();
      if (this.workRevision !== revision || addedWork().length !== 0) throw new TranscriptSourceChangedError();
    };
    const assertFinalized = (response: string) => {
      assertPrefix();
      const added = addedWork();
      if (added.length === 0 && this.workRevision === revision) return;
      const final = added[0];
      if (added.length !== 1 || this.workRevision !== revision + 1 || final?.role !== 'assistant'
        || final.content !== response || final.toolCalls?.length) throw new TranscriptSourceChangedError();
    };
    assertCurrent();
    const result = snapshot.call(this); assertCurrent();
    return { snapshot: result, native: snapshot === nativeMessageSnapshot, assertCurrent, assertFinalized };
  }

  /**
   * The transcript event index: one record per message, built in one pass with
   * no copy and no model request, and reused until the history's revision moves.
   */
  public async getTranscriptEventIndex(options: TranscriptReadingOptions = {}): Promise<TranscriptEventIndex> {
    options.signal?.throwIfAborted();
    const revision = this._messagesRevision;
    let cached = this.transcriptIndex;
    if (cached?.revision !== revision) {
      cached = { revision, index: Object.freeze(await buildTranscriptEventIndex(this.messages)) };
      if (this._messagesRevision !== revision) throw new TranscriptSourceChangedError();
      this.transcriptIndex = cached;
    }
    options.assertCurrent?.();
    return cached.index;
  }

  public replaceMessagesForLLM(newMessages: ProviderMessage[]): void {
    const systemMessages = this.messages.filter((message) => message.role === 'system');
    const kept = restoreKeptMessages(newMessages, this.getMessagesForLLM(), this.messages);
    archiveVerificationCompaction(this, this.getMessageSnapshot(), cloneMessages([...systemMessages, ...kept]));
    this.messages = [...systemMessages, ...kept];
    this.streamingMessageIndex = -1;
    // A turn undone before the rewrite no longer follows the history it was removed from.
    this.undoStack = [];
    this._messagesRevision++;
  }

  public async compact(
    registry: ProviderRegistry,
    modelId: string,
    trigger: 'auto' | 'manual' = 'manual',
    provider?: string,
    context?: CompactionContext,
  ): Promise<CompactionReceipt | undefined> {
    return compactConversation(this, registry, modelId, trigger, provider, context);
  }

  public get title(): string {
    return this._title;
  }

  public set title(value: string) {
    this._title = String(value ?? '');
    this._titleSource = this._title.trim().length > 0 ? 'user' : 'system';
  }

  public getTitleSource(): ConversationTitleSource {
    return this._titleSource;
  }

  public setSystemTitle(value: string): void {
    if (this._titleSource === 'user') return;
    this._title = String(value ?? '');
    this._titleSource = 'system';
  }

  public resetAll(): void {
    resetVerificationArchives(this);
    this.hostInstructions.reset();
    this.messages = [];
    this._title = '';
    this._titleSource = 'system';
    this.branches.clear();
    this.currentBranch = 'main';
    this.streamingMessageIndex = -1;
    this.undoStack = [];
    this._messagesRevision++;
  }

  public forkBranch(name?: string, force = false): string {
    const branchName = name?.trim() || `branch-${Date.now()}`;
    if (!force && this.branches.has(branchName)) {
      // The existing branch is kept, not overwritten; callers that report a
      // fork must check hasBranch first so they do not claim one was made.
      logger.warn('[conversation] fork skipped; a branch with this name already exists', { branch: branchName });
      return branchName;
    }
    const messages = cloneMessages(this.messages);
    forkVerificationArchive(this, branchName);
    this.branches.set(branchName, messages);
    return branchName;
  }

  public listBranches(): Array<{ name: string; messageCount: number; isCurrent: boolean }> {
    const result: Array<{ name: string; messageCount: number; isCurrent: boolean }> = [];
    const currentInMap = this.branches.has(this.currentBranch);
    if (!currentInMap) {
      result.push({ name: this.currentBranch, messageCount: this.messages.length, isCurrent: true });
    }
    for (const [name, messages] of this.branches) {
      result.push({ name, messageCount: messages.length, isCurrent: name === this.currentBranch });
    }
    return result;
  }

  public switchBranch(name: string): boolean {
    const stored = this.branches.get(name);
    if (!stored) return false;
    this.branches.set(this.currentBranch, cloneMessages(this.messages));
    const messages = cloneMessages(stored);
    switchVerificationArchive(this, name);
    this.messages = messages;
    for (const message of this.messages) if (message.role === 'system') this.presentStoredSystemMessage(message);
    this.currentBranch = name;
    this.streamingMessageIndex = -1;
    // The undo stack holds turns removed from the branch just left; redoing
    // them onto another branch would put the owner's old request there.
    this.undoStack = [];
    this._messagesRevision++;
    return true;
  }

  /** Whether a branch with this name has been saved (see forkBranch). */
  public hasBranch(name: string): boolean {
    return this.branches.has(name);
  }

  /**
   * Whether `mergeBranch(name)` can append the branch's own messages.
   *  - `ok`: the current history is a prefix of the branch (or the branch adds nothing).
   *  - `not-found`: no branch with that name.
   *  - `diverged`: both the current history and the branch grew past their shared
   *    prefix, so appending the branch tail would splice two different histories.
   */
  public checkBranchMerge(name: string): 'ok' | 'not-found' | 'diverged' {
    const stored = this.branches.get(name);
    if (!stored) return 'not-found';
    const common = this.sharedPrefixLength(stored);
    return common === this.messages.length || common === stored.length ? 'ok' : 'diverged';
  }

  /** Messages from the start that the current history and `other` hold identically. */
  private sharedPrefixLength(other: readonly Message[]): number {
    // The presentation is rebuilt on every branch switch, so it is not content.
    const content = (message: Message) => JSON.stringify(message, (key, value: unknown) => key === 'presentation' ? undefined : value);
    const limit = Math.min(this.messages.length, other.length);
    let index = 0;
    while (index < limit && content(this.messages[index]!) === content(other[index]!)) index++;
    return index;
  }

  public mergeBranch(name: string): boolean {
    const stored = this.branches.get(name);
    if (!stored) return false;
    const status = this.checkBranchMerge(name);
    if (status !== 'ok') {
      logger.warn('[conversation] branch merge refused; the branch and the current history diverged', { branch: name });
      return false;
    }
    const commonLength = this.sharedPrefixLength(stored);
    const toAppend = stored.slice(commonLength);
    if (toAppend.length === 0) return true;
    mergeVerificationArchive(this, name, commonLength, this.messages.length);
    this.messages.push(...cloneMessages(toAppend));
    // An undone turn belongs to the history it was removed from.
    this.undoStack = [];
    this._messagesRevision++;
    return true;
  }

  /**
   * A restored line keeps its declared level, the level of its declared
   * runtime event, or the presentation saved with it; a line saved with none
   * of these shows as information. Restoring or branching asks no model about
   * any line.
   */
  private presentStoredSystemMessage(message: Extract<Message, { role: 'system' }>): void {
    message.presentation = message.notice ? noticePresentation(message.notice)
      : declaredNoticePresentation(message.content, message.runtimeEvent) ?? storedPresentation(message.presentation) ?? noticePresentation(INFO_NOTICE);
  }

  public getCurrentBranch(): string {
    return this.currentBranch;
  }

  /** Side branches and the open branch's name, for saving with a session; cheap when /branch was never used. */
  public branchState(): { branches: Record<string, Message[]>; currentBranch: string } {
    return { branches: cloneBranchMap(this.branches), currentBranch: this.currentBranch };
  }

  public toJSON(): object {
    return {
      messages: cloneMessages(this.messages),
      timestamp: Date.now(),
      title: this._title,
      titleSource: this._titleSource,
      branches: cloneBranchMap(this.branches),
      currentBranch: this.currentBranch,
    };
  }

  public fromJSON(data: {
    messages: Message[];
    branches?: Record<string, Message[]> | undefined;
    currentBranch?: string | undefined;
    title?: string | undefined;
    titleSource?: ConversationTitleSource | undefined;
  }): void {
    this.messages = cloneMessages(data.messages ?? []);
    for (const message of this.messages) if (message.role === 'system') this.presentStoredSystemMessage(message);
    this.hostInstructions.reset();
    this._title = typeof data.title === 'string' ? data.title : '';
    this._titleSource = data.titleSource === 'user' || data.titleSource === 'system'
      ? data.titleSource
      : (this._title ? 'user' : 'system');
    this.branches = restoreBranchMap(data.branches);
    this.currentBranch = data.currentBranch ?? 'main';
    restoreVerificationBranch(this, this.currentBranch);
    this.undoStack = [];
    this.streamingMessageIndex = -1;
    this._messagesRevision++;
  }
}

const nativeMessageSnapshot = ConversationManager.prototype.getMessageSnapshot;
const nativeMessageEvidence = ConversationManager.prototype.captureMessageEvidence;
/** Capture through the native implementation, even if an instance is extended. */
export function captureConversationEvidence(conversation: ConversationManager) {
  return nativeMessageEvidence.call(conversation);
}

export { parseDiffForApply } from './conversation-diff.js';

import type { ChatResponse } from '../providers/interface.js';
import { isContextOverflowSignal } from '../providers/stop-reason-maps.js';
import type { ProviderMessage } from '../providers/interface.js';
import { logger } from '../utils/logger.js';
import { setAgentProgress, type ProgressAudience } from './progress-audience.js';

/**
 * Re-exported so the runner reaches progress classification through the same
 * module it already reaches `summarizeToolArgs` through, one import, and the
 * label and its audience stay next to each other.
 */
export { setAgentProgress, type ProgressAudience };

/**
 * Compact an agent conversation when the model/provider itself reported
 * context exhaustion on a successful response (see isContextOverflowSignal).
 * The provider's report is authoritative over local estimates, so this runs
 * immediately, the same structural compaction as the runner's
 * prompt-too-long emergency path, before any further chat call.
 * Returns true when compaction ran.
 */
export function maybeCompactAfterModelContextWarning(opts: {
  response: Pick<ChatResponse, 'stopReason' | 'providerStopReason'>;
  conversation: {
    getMessagesForLLM(): ProviderMessage[];
    replaceMessagesForLLM(messages: ProviderMessage[]): void;
  };
  record: { id: string; task?: string | undefined; progress?: string | undefined; progressAudience?: ProgressAudience | undefined };
  turn: number;
  contextWindowAwarenessEnabled: boolean;
  emitProgress: (progress: string) => void;
}): boolean {
  const { response, conversation, record, turn } = opts;
  if (!opts.contextWindowAwarenessEnabled) return false;
  if (!isContextOverflowSignal(response.stopReason, response.providerStopReason)) return false;
  logger.warn(
    `[AgentOrchestrator] model reported context window exhaustion on turn ${turn} - compacting immediately`,
    { agentId: record.id, providerStopReason: response.providerStopReason },
  );
  setAgentProgress(record, `Turn ${turn} · Model reported full context, compacting…`, 'operator');
  opts.emitProgress(record.progress ?? '');
  const messages = conversation.getMessagesForLLM();
  conversation.replaceMessagesForLLM(
    compactAgentConversation(messages, Math.max(5, Math.floor(messages.length / 3)), record.task),
  );
  return true;
}

/**
 * Sub-agent compaction: keep the newest `keepRecent` messages plus the task.
 * The task reaches the model only as the run's first user message (the system
 * prompt leaves it out), so a plain tail cut would drop the goal and its
 * criteria. Nothing is summarised, and the notice says so.
 */
export function compactAgentConversation(messages: ProviderMessage[], keepRecent: number, task: string | undefined): ProviderMessage[] {
  if (messages.length <= keepRecent) return messages;
  let start = messages.length - keepRecent;
  // A tool result is only valid after the assistant message that made the call, so the cut moves back to include that message.
  while (start > 0 && messages[start]!.role === 'tool') start -= 1;
  const taskIndex = task === undefined ? -1 : messages.findIndex((message) => message.role === 'user' && message.content === task);
  const pinned = taskIndex >= 0 && taskIndex < start ? [messages[taskIndex]!] : [];
  const dropped = start - pinned.length;
  if (dropped === 0) return messages;
  const notice = `[Context compacted: ${dropped} earlier message${dropped === 1 ? ' was' : 's were'} dropped, not summarised, to fit the context window.`
    + `${pinned.length > 0 ? ' The task above is the original, unchanged.' : ''} Their tool results are gone: re-read any file you still need.]`;
  return pinned.length > 0
    ? [pinned[0]!, { role: 'assistant', content: notice }, ...messages.slice(start)]
    : [{ role: 'user', content: notice }, { role: 'assistant', content: '[Continuing from the most recent messages.]' }, ...messages.slice(start)];
}

/** The argument names that actually say what a tool is doing. */
const INFORMATIVE_ARG_KEYS: readonly string[] = ['path', 'file', 'cmd', 'pattern', 'url', 'query'];

/** Truncate to a label-sized fragment. */
function trimArgValue(value: string): string {
  return value.length > 30 ? `${value.slice(0, 27)}\u2026` : value;
}

/**
 * Pull an informative argument out of one level of nesting.
 *
 * `exec` takes `commands: [{ cmd }]` and `fetch` takes `urls: [{ url }]` \u2014 the
 * thing worth showing is one object deep, not at the top level. Reading only
 * the top level is what produced `exec \u2014 standard`: the flat scan missed `cmd`,
 * and the "first string value found" fallback grabbed `verbosity`, whose
 * default is the literal string `standard`. So the label named a tool and then
 * a value that had nothing to do with what it was about to run.
 */
function informativeArgFromNesting(value: unknown): string | null {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    for (const key of INFORMATIVE_ARG_KEYS) {
      const inner = record[key];
      if (typeof inner === 'string' && inner.length > 0) return inner;
    }
  }
  return null;
}

/**
 * Summarize tool call arguments into a brief display string for progress labels.
 *
 * Returns an INFORMATIVE argument or nothing at all. The old "otherwise use the
 * first string value found" fallback is gone: an arbitrary flat field is not a
 * summary of what a tool is doing, it just looks like one. A bare tool name is
 * the honest answer when nothing here recognises the shape of the call.
 */
export function summarizeToolArgs(args: Record<string, unknown>): string {
  for (const key of INFORMATIVE_ARG_KEYS) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) return ` \u2014 ${trimArgValue(val)}`;
  }
  // One level down: the array-of-objects shape `exec`, `fetch`, `read`, `write`
  // and `find` all use.
  for (const val of Object.values(args)) {
    const nested = informativeArgFromNesting(val);
    if (nested !== null) return ` \u2014 ${trimArgValue(nested)}`;
  }
  return '';
}

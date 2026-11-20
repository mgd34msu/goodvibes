/** System notices retain their full text in saved conversation history.
 * Declared runtime occurrences publish immediately and deduplicate with the bus.
 * Every other notice publishes at the level its writer stored on it (information
 * when it stored none); no model reads a notice, and nothing screens its text.
 * Publication is synchronous: the entry is recorded in the same call that
 * received the notice, so there is no later point at which it could be stale.
 * Restored notices enter history without counting as unread again.
 */
import { runtimeEventOfNotice, type RuntimeEventProvenance } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import type { NotificationFeed } from '@goodvibes/engine/platform/platform/runtime/notification-feed';
import type { NoticeMeta } from '@goodvibes/engine/platform/platform/core';
/** Receives every system notice added to (or restored into) the conversation. */
export type NoticeSink = (
  content: string,
  options: NoticeOptions & {
    readonly restored: boolean;
  },
) => void | Promise<void>;
/** The pieces of a notice as the history shows them. */
export interface NoticeParts {
  /** Lower-case bracket tag ('wrfc', 'agents', 'compaction', …) or 'system' when untagged. */
  readonly domain: string;
  /** The first non-empty line, in full. */
  readonly title: string;
  /** Every further line, in full, or undefined. */
  readonly body: string | undefined;
}
const TAG_RE = /^\s*\[([^\]\n]+)\]/;
export function noticeParts(text: string): NoticeParts {
  const trimmed = text.replace(/^\s*\n+/, '').replace(/\s+$/, '');
  const tag = TAG_RE.exec(trimmed)?.[1];
  const domain = tag ? tag.trim().toLowerCase().replace(/\s+/g, '-') : 'system';
  const newline = trimmed.indexOf('\n');
  const title = newline < 0 ? trimmed : trimmed.slice(0, newline);
  const rest = newline < 0 ? '' : trimmed.slice(newline + 1).replace(/^\n+/, '');
  return { domain, title, body: rest.length > 0 ? rest : undefined };
}
export interface NoticeOptions {
  /** An aborted signal means the conversation that sent the notice is gone: nothing is recorded. */
  readonly signal?: AbortSignal | undefined;
  /** Restored from a saved session: kept in history. */
  readonly restored?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly runtimeEvent?: RuntimeEventProvenance | undefined;
  /** The writer's declaration (ConversationManager.addNotice): recorded at its level, no reading. */
  readonly notice?: NoticeMeta | undefined;
}
const FEED_LEVEL: Readonly<Record<NoticeMeta['level'], 'info' | 'warning' | 'critical'>> = { info: 'info', success: 'info', warning: 'warning', error: 'critical' };
/** Keep one system notice in the history; the status bar counts it while unread. */
export interface NoticePublicationPolicy {
  readonly resolveEvent?:
    | ((
        text: string,
        provenance: RuntimeEventProvenance | undefined,
      ) =>
        | {
            readonly type: string;
            readonly level: 'debug' | 'info' | 'warning' | 'critical';
            readonly title: string;
            readonly detail: string | undefined;
            readonly key?: string | undefined;
          }
        | undefined)
    | undefined;
}
export function createNoticePublisher(policy: NoticePublicationPolicy) {
  return function publishNotice(feed: NotificationFeed, text: string, options: NoticeOptions = {}): void {
    if (text.trim().length === 0 || options.signal?.aborted) return;
    const restored = options.restored === true;
    const runtimeEvent = options.runtimeEvent;
    const timestamp = (options.now ?? Date.now)();
    const parts = noticeParts(text);
    const event = policy.resolveEvent
      ? policy.resolveEvent(text, runtimeEvent)
      : runtimeEvent
        ? runtimeEventOfNotice(text, runtimeEvent)
        : undefined;
    if (event && (policy.resolveEvent || event.type === runtimeEvent?.type)) {
      feed.recordNotice({
        domain: parts.domain,
        level: event.level,
        title: event.title,
        body: event.detail,
        timestamp,
        restored,
        eventKey: event.key,
      });
      return;
    }
    feed.recordNotice({ ...parts, level: FEED_LEVEL[options.notice?.level ?? 'info'], timestamp, restored });
  };
}

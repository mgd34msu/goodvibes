import { drainOwned } from '@goodvibes-jev/judgment/decisions';
/** System notices retain their full text in saved conversation history.
 * Declared runtime occurrences publish immediately and deduplicate with the bus.
 * Unstructured notices appear neutrally while their semantic severity is read.
 * Restored notices enter history without another toast.
 */
import { readNoticeSeverity, type NoticeSeverityReading } from './notice-severity.js';
import { prepareSystemMessagePresentation } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { JudgmentAuthorityRetiredError, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { runtimeEventOfNotice, type RuntimeEventProvenance } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import type { NotificationFeed } from '@goodvibes-jev/engine/sdk/platform/runtime/notification-feed';
/** Receives every system notice added to (or restored into) the conversation. */
export type NoticeSink = (
  content: string,
  options: NoticeOptions & {
    readonly restored: boolean;
  },
) => void | Promise<void>;
/** The pieces of a notice as the history and the toast show them. */
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
export interface NoticeOptions extends Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> {
  /** Restored from a saved session: kept in history, not toasted. */
  readonly restored?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly runtimeEvent?: RuntimeEventProvenance | undefined;
}
/** Keep one system notice in the history; the feed's toast bridge toasts it unless restored. */
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
  readonly severity: 'notice' | 'presentation';
  readonly screenBeforeLocalPublication: boolean;
  readonly retainOnDecorationError: boolean;
}
async function presentationSeverity(text: string, options: NoticeOptions): Promise<NoticeSeverityReading> {
  const owner = captureJudgmentPort('terminal-shell.notice-presentation', options);
  const presentation = await prepareSystemMessagePresentation(text, owner.signal);
  owner.assertCurrent();
  return {
    severity: presentation.severity === 'error' ? 'critical' : presentation.severity,
    assertCurrent: owner.assertCurrent,
    recordPublication: owner.assertCurrent,
  };
}
export function createNoticePublisher(policy: NoticePublicationPolicy) {
  return function publishNotice(feed: NotificationFeed, text: string, options: NoticeOptions = {}): void | Promise<void> {
    if (text.trim().length === 0) return;
    if (policy.screenBeforeLocalPublication) {
      try {
        snapshotJudgmentInput({ text });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const restored = options.restored === true;
    const assertCallerCurrent = options.assertCurrent;
    const callerSignal = options.signal;
    const runtimeEvent = options.runtimeEvent;
    const now = options.now ?? Date.now;
    const parts = noticeParts(text);
    const publication = feed.captureNoticePublication();
    const signal = callerSignal ? AbortSignal.any([publication.signal, callerSignal]) : publication.signal;
    const current = () => {
      if (signal.aborted) throw new JudgmentAuthorityRetiredError();
      publication.assertCurrent();
      const result: unknown = assertCallerCurrent?.();
      if (result !== undefined) {
        drainOwned(result);
        throw new JudgmentAuthorityRetiredError();
      }
      publication.assertCurrent();
      if (signal.aborted) throw new JudgmentAuthorityRetiredError();
    };
    current();
    const timestamp = now();
    current();
    const event = policy.resolveEvent
      ? policy.resolveEvent(text, runtimeEvent)
      : runtimeEvent
        ? runtimeEventOfNotice(text, runtimeEvent)
        : undefined;
    if (event && (policy.resolveEvent || event.type === runtimeEvent?.type)) {
      current();
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
    const pending = feed.recordNotice({ ...parts, timestamp, restored, severityPending: true });
    const revokePending = () => {
      if (feed.list().includes(pending)) feed.dismiss(pending.key);
    };
    signal.addEventListener('abort', revokePending, { once: true });
    if (signal.aborted) revokePending();
    return (async () => {
      try {
        current();
        const reading = await (policy.severity === 'presentation' ? presentationSeverity : readNoticeSeverity)(text, {
          signal,
          assertCurrent: current,
        });
        reading.assertCurrent();
        if (reading.severity === undefined) return;
        reading.recordPublication();
        current();
        reading.assertCurrent();
        feed.settleNoticeSeverity(pending, reading.severity);
      } catch (error) {
        if (!policy.retainOnDecorationError) throw error;
      } finally {
        signal.removeEventListener('abort', revokePending);
      }
    })();
  };
}

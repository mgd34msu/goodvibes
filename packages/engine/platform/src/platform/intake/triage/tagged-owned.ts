/**
 * Put triage labels on messages at the provider: an IMAP keyword, a Slack
 * reaction, a Discord reaction or forum tag. The built-in labels are three
 * fixed effects on a row this account owns; they need the owner's per-account
 * setting and no model decision. A custom label name costs one reading of what
 * it means (tagger/meaning.ts). The row is looked up by id once, and its
 * revision is compared right before the provider write and right after it.
 */
import type { OwnedInboxSource } from '../registration.js';
import { captureTagNames } from './tagger/meaning.js';
import type { TriageTagger } from './tagger/index.js';

export interface OwnedInboxTaggingOptions {
  readonly source: OwnedInboxSource;
  readonly tagger: TriageTagger;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly onInvalidate: (listener: () => void) => () => void;
  /** The owner's per-account setting; labels are written only while it is on. */
  readonly enabled?: () => boolean;
  /** The setting key a refusal names. */
  readonly settingKey?: string;
}
export interface OwnedInboxTagOperation {
  readonly signal?: AbortSignal;
}
/** What happened to one message. */
export interface OwnedInboxTagResult {
  readonly itemId: string;
  readonly state: 'applied' | 'refused' | 'failed';
  /** Labels written at the provider (all of them when `applied`, none otherwise). */
  readonly applied: readonly string[];
  /** Why it was refused or failed, and what to do. */
  readonly reason?: string;
  /** Set when the message changed while its label was being written. */
  readonly changedDuringWrite?: boolean;
}
export interface OwnedInboxTagging {
  applyTags(itemId: string, tags: readonly string[], operation?: OwnedInboxTagOperation): Promise<OwnedInboxTagResult>;
  close(): Promise<void>;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message && error.message.length <= 300 ? error.message : fallback;
}

export function createOwnedInboxTagging(input: OwnedInboxTaggingOptions): OwnedInboxTagging {
  const options = Object.freeze({ ...input });
  const lifetime = new AbortController();
  const active = new Set<Promise<OwnedInboxTagResult>>();
  let closing: Promise<void> | undefined;
  const setting = options.settingKey ?? 'the inbox tagging setting for this account';
  return {
    applyTags(itemId, inputTags, operation = {}) {
      const stopped: OwnedInboxTagResult = { itemId, state: 'failed', applied: [], reason: 'Labelling was stopped: the account, its settings or the inbox changed' };
      const invalidation = new AbortController();
      let unsubscribe: () => void;
      // A retired account refuses the subscription; that is an answer, not a throw.
      try { unsubscribe = options.onInvalidate(() => invalidation.abort()); } catch { return Promise.resolve(stopped); }
      const signal = AbortSignal.any([lifetime.signal, options.signal, invalidation.signal, ...(operation.signal ? [operation.signal] : [])]);
      const refused = (reason: string): OwnedInboxTagResult => ({ itemId, state: 'refused', applied: [], reason });
      const work = Promise.resolve().then(async (): Promise<OwnedInboxTagResult> => {
        let tags: readonly string[];
        try { tags = captureTagNames(inputTags); } catch (error) { return refused(message(error, 'The labels are not ones this inbox can write; use GoodVibes/Spam, GoodVibes/Priority or GoodVibes/Normal')); }
        if (options.enabled && !options.enabled()) return refused(`Writing labels to the provider is off for this account; turn on ${setting} to allow it`);
        const mirror = options.source.mirror;
        if (!mirror) return refused('This inbox has no stored messages to label');
        const revisionOf = (): string | undefined => mirror.triageRevisions([itemId]).get(itemId);
        const revision = revisionOf();
        if (revision === undefined) return refused(`Message ${itemId} is not in this account's inbox; list the inbox and use an id from it`);
        const guard = { signal, assertCurrent() { signal.throwIfAborted(); options.assertCurrent(); } };
        try {
          const prepared = await options.tagger.prepareTags(itemId, tags, guard);
          if (revisionOf() !== revision) return refused(`Message ${itemId} changed before its label was written; nothing was written, try again`);
          await prepared.applyTags(guard);
        } catch (error) {
          if (signal.aborted) return stopped;
          return { itemId, state: 'failed', applied: [], reason: message(error, 'The provider did not accept the label; nothing is known to be written') };
        }
        const changed = revisionOf() !== revision;
        return { itemId, state: 'applied', applied: tags, ...(changed ? { changedDuringWrite: true } : {}) };
      }).finally(unsubscribe);
      active.add(work); void work.then(() => active.delete(work), () => active.delete(work)); return work;
    },
    close() {
      if (closing) return closing;
      let done!: () => void; closing = new Promise<void>(resolve => { done = resolve; });
      lifetime.abort(); void Promise.allSettled([...active]).then(() => done()); return closing;
    },
  };
}

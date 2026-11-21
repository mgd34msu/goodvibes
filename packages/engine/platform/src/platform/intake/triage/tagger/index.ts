import { randomUUID } from 'node:crypto';
import type { JudgmentPort } from '@goodvibes/judgment';
import type { IntakeCredentialStore } from '../../context.js';
import { applySlackReactions } from './slack.js';
import { applyDiscordTagEffects, observeDiscordForumTags } from './discord.js';
import { makeRetryingImapStoreFlag, imapStoreFlagWithMailClient, type ImapStoreFlag, type ImapStoreResult } from './imap.js';
import { TAGS, current, cutOff, interruption, notTried, supersededLabels, type TaggerGuard, type TaggerHttp, type TriageEffectResult,
  type TriageProviderTag, type TriageTagWrite } from './shared.js';
import { captureTriageData } from '../evidence.js';
import { captureTagNames, readCustomTagMeaning, TriageTagMeaningHeld } from './meaning.js';
import { isGmailEmailItemId } from '../../email-item-id.js';
export type { TriageProviderTag, TaggerGuard, TriageEffectResult, TriageTagWrite } from './shared.js';
export type { ImapStoreArgs, ImapStoreFlag, ImapStoreResult, ImapRetryOptions } from './imap.js';
export interface TriageTaggerOptions {
  readonly provider: 'slack' | 'discord' | 'email';
  readonly accountScopeId: string;
  readonly credentials: IntakeCredentialStore;
  readonly credentialKey: string;
  /** Synchronous exact credential/config generation guard, including aliases and ABA. */
  readonly captureCredential: () => { readonly value: string; assertCurrent(): void };
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly imap?: { readonly host: string; readonly port: number; readonly user: string; readonly mailbox: string };
  readonly forumTagIds?: Readonly<Record<string, string>>;
  /** Constructor-owned recorded port; required only for noncanonical reaction meaning. */
  readonly port?: JudgmentPort;
  readonly http?: TaggerHttp;
  readonly imapStoreFlag?: ImapStoreFlag;
}
export interface TriageTagEffect {
  readonly tag: string;
  readonly mode: 'imap-keyword' | 'slack-reaction' | 'discord-forum-or-reaction' | 'discord-forum-tag' | 'discord-reaction' | 'discord-unmapped-noop';
  readonly keyword?: string;
  readonly reaction?: string;
  /** Opaque binding to an exact configured forum ID; actual snowflake remains local. */
  readonly forumTagRef?: string;
}
export interface PreparedTriageTags {
  readonly effects: readonly TriageTagEffect[];
  readonly judgmentDecisionIds: readonly string[];
  /** Other built-in labels whose marks the write takes off (they exclude the written ones). */
  readonly supersedes: readonly TriageProviderTag[];
  assertCurrent(): void; applyTags(guard: TaggerGuard): Promise<TriageTagWrite>;
}
export interface TriageTagger {
  readonly provider: TriageTaggerOptions['provider'];
  readonly accountScopeId: string;
  prepareTags(itemId: string, tags: readonly string[], guard: TaggerGuard): Promise<PreparedTriageTags>;
  /** Every mark's outcome; a provider refusal is an effect's `failed`, a stop or an invalid target throws. */
  applyTags(itemId: string, tags: readonly string[], guard: TaggerGuard): Promise<TriageTagWrite>;
  close(): Promise<void>;
}
/** Constructor-only capability: the owned caller supplies authentic admission guards. */
export function createTriageTagger(input: TriageTaggerOptions): TriageTagger {
  if (!['slack', 'discord', 'email'].includes(input.provider) || typeof input.accountScopeId !== 'string' || !input.accountScopeId) throw new TypeError('Triage tagger requires one supported provider and account scope');
  const forumTagIds = captureTriageData(input.forumTagIds ?? {}) as Readonly<Record<string, string>>;
  if (!forumTagIds || typeof forumTagIds !== 'object' || Array.isArray(forumTagIds)
    || Object.keys(forumTagIds).length > 256 || Object.entries(forumTagIds).some(([name, id]) => !name || name.length > 256 || typeof id !== 'string' || !/^[0-9]+$/.test(id))) throw new TypeError('Invalid triage forum mapping');
  const options = Object.freeze({ ...input, forumTagIds, ...(input.imap ? { imap: Object.freeze({ ...input.imap }) } : {}) });
  const resolve = options.credentials.resolveConfigSecret.bind(options.credentials);
  const capture = options.captureCredential;
  const lifetime = new AbortController();
  const active = new Set<Promise<unknown>>();
  // An unsettled identical custom name cannot be resampled into a lucky answer.
  // Only bounded digests remain; scope ends with this account tagger's lifetime.
  const heldMeanings = new Set<string>();
  // One reading per custom name for this account tagger's lifetime: callers of
  // the same name share the reading in flight, and a settled meaning is reused.
  // The reading runs under the tagger's own lifetime, so one caller stopping
  // does not stop it for the others.
  const meaningReadings = new Map<string, Promise<CustomTagMeaning>>();
  const readingGuard: TaggerGuard = { signal: AbortSignal.any([lifetime.signal, options.signal]), assertCurrent: options.assertCurrent };
  const meaningOf = (tag: string): Promise<CustomTagMeaning> => {
    const known = meaningReadings.get(tag);
    if (known) return known;
    if (heldMeanings.size + meaningReadings.size >= 1024) throw new TriageTagMeaningHeld('full');
    const reading = readCustomTagMeaning(tag, options.port, readingGuard);
    meaningReadings.set(tag, reading);
    const settled = reading.then(() => undefined, (error: unknown) => {
      if (meaningReadings.get(tag) === reading) meaningReadings.delete(tag);
      if (error instanceof TriageTagMeaningHeld) heldMeanings.add(tag);
    });
    active.add(settled); void settled.then(() => active.delete(settled));
    return reading;
  };
  let closing: Promise<void> | undefined;
  const store = makeRetryingImapStoreFlag(options.imapStoreFlag ?? imapStoreFlagWithMailClient());
  const owner: TriageTagger = {
    provider: options.provider, accountScopeId: options.accountScopeId,
    async applyTags(itemId, rawTags, operation) { const prepared = await owner.prepareTags(itemId, rawTags, operation); return prepared.applyTags(operation); },
    prepareTags(itemId, rawTags, operation) {
      const tags = captureTagNames(rawTags);
      const proof = operation.assertCurrent.bind(operation);
      // No deadline here: preparation may read a custom name's meaning. The
      // provider write gets its own 20 seconds, starting when it starts.
      const signal = AbortSignal.any([lifetime.signal, options.signal, operation.signal]);
      const guard = { signal, assertCurrent() { current({ signal, assertCurrent: options.assertCurrent }); proof(); } };
      const preparation = Promise.resolve().then(async (): Promise<PreparedTriageTags> => {
        current(guard);
        // Targets are protocol data. Reject malformed/foreign targets before
        // credential resolution or any custom-name reading, not after admission.
        if (options.provider === 'slack' && !/^slack:([A-Z0-9]+):([0-9]+\.[0-9]+)$/.test(itemId)) throw new Error('Slack triage target unavailable');
        if (options.provider === 'discord' && !/^discord:([0-9]+):([0-9]+)$/.test(itemId)) throw new Error('Discord triage target unavailable');
        if (options.provider === 'email') {
          if (isGmailEmailItemId(itemId)) throw new Error('This message was read through the Gmail API; labels are written to IMAP mailboxes only, so set this account up for IMAP to label it');
          const parts = itemId.split(':');
          if (parts.length !== 4 || parts[0] !== 'email' || parts[1] !== options.accountScopeId || !options.imap
            || !/^\d+$/.test(parts[2]!) || !/^\d+$/.test(parts[3]!)
            || !Number.isSafeInteger(Number(parts[2])) || Number(parts[2]) < 1
            || !Number.isSafeInteger(Number(parts[3])) || Number(parts[3]) < 1) throw new Error('Email triage target unavailable');
        }
        const credential = capture();
        const checkCredential = credential.assertCurrent.bind(credential);
        const token = credential.value;
        const guarded = { signal, assertCurrent() { current(guard); checkCredential(); } };
        if (!token || await resolve(options.credentialKey) !== token) throw new Error('Triage credential unavailable');
        current(guarded);
        let discordForumOnly = false, discordReactionOnly = false;
        // Exact configured forum IDs are code, not label meaning. Only inspect
        // before semantic preparation when a custom name might take this path.
        if (options.provider === 'discord' && tags.some(tag => !Object.hasOwn(TAGS, tag))
          && tags.some(tag => Object.hasOwn(options.forumTagIds, tag))) {
          const [, channel, message] = itemId.split(':');
          const existing = await observeDiscordForumTags({ channel: channel!, message: message! }, token, guarded, options.http);
          current(guarded);
          discordForumOnly = existing !== null; discordReactionOnly = existing === null;
        }
        const meanings = new Map<string, TriageProviderTag>();
        const decisions: string[] = [];
        if (options.provider !== 'email' && !discordForumOnly) for (const tag of tags) {
          if (Object.hasOwn(TAGS, tag)) { meanings.set(tag, tag as TriageProviderTag); continue; }
          if (heldMeanings.has(tag)) throw new TriageTagMeaningHeld();
          const result = await settledOrStopped(meaningOf(tag), guarded);
          current(guarded); meanings.set(tag, result.canonical); decisions.push(result.decisionId);
        }
        const keyword = (tag: string) => tag.replace(/[^A-Za-z0-9_]+/g, '_');
        const effects: readonly TriageTagEffect[] = Object.freeze(tags.map(tag => Object.freeze(options.provider === 'email'
          ? { tag, mode: 'imap-keyword' as const, keyword: keyword(tag) }
          : options.provider === 'slack' ? { tag, mode: 'slack-reaction' as const, reaction: TAGS[meanings.get(tag)!].slack }
          : discordForumOnly ? { tag, mode: Object.hasOwn(options.forumTagIds, tag) ? 'discord-forum-tag' as const : 'discord-unmapped-noop' as const,
            ...(Object.hasOwn(options.forumTagIds, tag) ? { forumTagRef: randomUUID().replaceAll('-', ':') } : {}) }
          : { tag, mode: discordReactionOnly ? 'discord-reaction' as const : 'discord-forum-or-reaction' as const, reaction: TAGS[meanings.get(tag)!].discord,
            ...(!discordReactionOnly && Object.hasOwn(options.forumTagIds, tag) ? { forumTagRef: randomUUID().replaceAll('-', ':') } : {}) })));
        const judgmentDecisionIds = Object.freeze(decisions);
        // Spam, Priority and Normal exclude each other: writing one takes the
        // others' marks off. Custom names count by the meaning read for them.
        const supersedes = Object.freeze(supersededLabels(tags.flatMap(tag => {
          const meaning = meanings.get(tag) ?? (Object.hasOwn(TAGS, tag) ? tag as TriageProviderTag : undefined);
          return meaning ? [meaning] : [];
        })));
        let used = false;
        return Object.freeze({ effects, judgmentDecisionIds, supersedes, assertCurrent: guarded.assertCurrent, applyTags(admission: TaggerGuard): Promise<TriageTagWrite> {
          if (used) return Promise.reject(new Error('Triage preparation already consumed'));
          used = true;
          const admissionCurrent = admission.assertCurrent.bind(admission);
          const finalGuard = { signal: AbortSignal.any([signal, admission.signal, AbortSignal.timeout(20_000)]), assertCurrent() { current(guarded); admissionCurrent(); } };
          const work = Promise.resolve().then(async (): Promise<TriageTagWrite> => {
        current(finalGuard);
        // No currentness check after a provider write: a mark that was written
        // is reported as written, whatever changed while it was being written.
        if (options.provider === 'slack') {
          const match = /^slack:([A-Z0-9]+):([0-9]+\.[0-9]+)$/.exec(itemId);
          if (!match) throw new Error('Slack triage target unavailable');
          return applySlackReactions({ channel: match[1]!, timestamp: match[2]! }, effects.map(effect => ({ tag: effect.tag, reaction: effect.reaction! })),
            supersedes.map(tag => ({ tag, reaction: TAGS[tag].slack })), token, finalGuard, options.http);
        }
        if (options.provider === 'discord') {
          const match = /^discord:([0-9]+):([0-9]+)$/.exec(itemId);
          if (!match) throw new Error('Discord triage target unavailable');
          return applyDiscordTagEffects({ channel: match[1]!, message: match[2]! }, effects.map(effect => ({ name: effect.tag, ...(effect.reaction === undefined ? {} : { reaction: effect.reaction }) })),
            supersedes.map(tag => ({ name: tag, reaction: TAGS[tag].discord })), token, finalGuard, discordReactionOnly ? {} : options.forumTagIds, options.http, discordForumOnly);
        }
        const parts = itemId.split(':');
        if (parts.length !== 4 || parts[0] !== 'email' || parts[1] !== options.accountScopeId || !/^\d+$/.test(parts[2]!) || !/^\d+$/.test(parts[3]!) || !options.imap) throw new Error('Email triage target unavailable');
        const uidValidity = Number(parts[2]), uid = Number(parts[3]);
        if (!Number.isSafeInteger(uid) || uid < 1) throw new Error('Email triage UID unavailable');
        // Every keyword in one STORE on one connection.
        const flags = effects.map(effect => effect.keyword!);
        const replaced = new Map(supersedes.map(tag => [TAGS[tag].imap, tag]));
        let written: ImapStoreResult;
        try {
          written = await store({ ...options.imap, password: token, uid: String(uid), uidValidity, flag: flags[0]!, flags, supersedes: [...replaced.keys()], ...finalGuard });
        } catch (error) {
          // One STORE carries every keyword change: cut off, each of them is unknown.
          if (finalGuard.signal.aborted) {
            return cutOff([], [...effects.map(effect => ({ tag: effect.tag, action: 'add' as const })),
              ...supersedes.map(tag => ({ tag, action: 'remove' as const }))], [], interruption(finalGuard, error));
          }
          const reason = error instanceof Error && error.message ? error.message : 'The mail server did not take the label';
          return { effects: [...effects.map(effect => ({ tag: effect.tag, action: 'add' as const, outcome: 'failed' as const, reason })),
            ...notTried(supersedes.map(tag => ({ tag, action: 'remove' as const })))] };
        }
        const removed = new Set(written.removed), kept = new Set(written.kept);
        const results: TriageEffectResult[] = effects.map((effect): TriageEffectResult => ({ tag: effect.tag, action: 'add', outcome: 'applied' }));
        for (const [keyword, tag] of replaced) {
          results.push(removed.has(keyword) ? { tag, action: 'remove', outcome: 'applied' }
            : kept.has(keyword) ? { tag, action: 'remove', outcome: 'failed', reason: 'The mail server did not confirm the old label was taken off; label the message again to retry' }
            : { tag, action: 'remove', outcome: 'already' });
        }
        return { effects: results };
      });
      active.add(work); void work.then(() => active.delete(work), () => active.delete(work)); return work;
        } });
      });
      active.add(preparation); void preparation.then(() => active.delete(preparation), () => active.delete(preparation)); return preparation;
    },
    close() {
      if (closing) return closing;
      let done!: () => void;
      closing = new Promise<void>(resolveClose => { done = resolveClose; });
      lifetime.abort();
      void Promise.allSettled([...active]).then(() => { heldMeanings.clear(); meaningReadings.clear(); done(); });
      return closing;
    },
  };
  return owner;
}

type CustomTagMeaning = Awaited<ReturnType<typeof readCustomTagMeaning>>;

/** The shared reading's answer, or this caller's own stop, whichever comes first. */
function settledOrStopped<T>(work: Promise<T>, guard: TaggerGuard): Promise<T> {
  current(guard);
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => { try { guard.signal.throwIfAborted(); } catch (error) { reject(error); } };
    guard.signal.addEventListener('abort', stop, { once: true });
    work.then(
      value => { guard.signal.removeEventListener('abort', stop); resolve(value); },
      (error: unknown) => { guard.signal.removeEventListener('abort', stop); reject(error); },
    );
  });
}

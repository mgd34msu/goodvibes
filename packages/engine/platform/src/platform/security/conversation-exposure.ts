/**
 * conversation-exposure.ts, what a conversation has read stays read.
 *
 * Once text anyone can write (a fetched page, a tool server's result, a file from an untrusted place, a channel
 * message, another party's words, a document) is in a conversation's context, the rule "ask before making something that
 * runs later, sending, spending or loosening" holds for EVERY later turn of that conversation, not only the turn that
 * read it (permissions/manager.ts `callFacts`): the text, or anything made from it, can be in what the model sees for as
 * long as the conversation lasts. So exposure is kept per CONVERSATION, not per turn:
 *
 *  - a conversation is the untrusted-content scope its turns run in (a web chat `companion-chat:<id>`, a hosted
 *    session `session:<id>`, an agent's own run `agent:<id>`, a piece of Work `work:<id>` whatever its attempt), or a
 *    key a host names for something that runs later (`schedule:<id>`, `trigger:<id>`);
 *  - every read recorded while a conversation is in scope marks it, and every conversation it runs inside (a helper
 *    agent's read exposes the conversation that started it: its summary is handed back there);
 *  - a conversation started inside an exposed one starts exposed (a helper agent, Work handed over, a fork), and so does
 *    what an exposed conversation made that runs later (a schedule, a trigger: `stampExposure` where it is made, its runs
 *    start inside its key);
 *  - a compaction or a resume keeps the conversation's key, so its exposure; it ends only with a new conversation, or
 *    a clear that removes what it read (`clearExposure`);
 *  - kept in a file of the daemon's home (`setExposureFile`), so it survives a restart; a program's own conversations
 *    are kept in memory for as long as the program runs.
 *
 * An exposed turn never gets the owner's administrative authority on its own calls (daemon/capability-wiring.ts), and
 * what it writes into what steers a model is written "by your model after reading text from outside" and waits for the
 * owner's acceptance (control-plane/routes/capabilities.ts `authorOfRun`). The owner sees it on the card they are asked
 * with ("This conversation has read text from outside: <where>").
 *
 * Pure bookkeeping, no decision: the gate decides with it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../config/atomic-write.js';

/** One kind of outside text a conversation read, and where it came from. */
export interface ConversationExposure {
  readonly surface: string;
  readonly origin: string;
  readonly at: string;
}

/**
 * A conversation's exposure lives exactly as long as the record it belongs to (a web chat, a session, a schedule, a
 * trigger, a piece of work, an agent's run, one call): it is forgotten when that record is deleted (`clearExposure`,
 * where each is deleted), never because time went by or other conversations were made, so no caller's activity pushes
 * another conversation's protection out. The keys whose record lives only in this process (an agent's run
 * `agent:<id>`, cleared when the agent manager lets the record go; one call's key, cleared when the call ends) are not
 * written to the file: their record ends with the process, and so do they.
 */
const PROCESS_ONLY_KEY = /^(?:agent:|conversation:call-)/;
/** Distinct sources kept per conversation (the first ones read: enough to say where, and that it read any). */
const MAX_SOURCES = 16;

/** The conversation an untrusted-content scope is, or undefined for a scope that is no conversation (a request's). */
export function conversationKeyOf(scope: string | undefined): string | undefined {
  if (!scope) return undefined;
  if (/^(?:companion-chat|session|agent|schedule|trigger|conversation):./.test(scope)) return scope;
  // A piece of Work's attempt (`work:<work id>:<attempt>`, contract/durable-admission.ts) is that Work, whatever attempt.
  const work = /^work:(.+):[^:]+$/.exec(scope);
  return work ? `work:${work[1]}` : undefined;
}

class ExposureStore {
  #file: string | undefined;
  readonly #byKey = new Map<string, ConversationExposure[]>();

  /** Keep exposures in `file` (the daemon's home), read what an earlier run kept. */
  configure(file: string): void {
    this.#file = file;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { readonly conversations?: Record<string, unknown> };
      for (const [key, list] of Object.entries(parsed.conversations ?? {})) {
        // An earlier run's agent or one-call key: its record ended with that process.
        if (!Array.isArray(list) || PROCESS_ONLY_KEY.test(key)) continue;
        const kept = list.filter((entry): entry is ConversationExposure => entry !== null && typeof entry === 'object'
          && typeof (entry as ConversationExposure).surface === 'string' && typeof (entry as ConversationExposure).origin === 'string'
          && typeof (entry as ConversationExposure).at === 'string').slice(0, MAX_SOURCES);
        if (kept.length > 0) this.#byKey.set(key, kept);
      }
    } catch { /* no file yet, or unreadable: nothing kept from before (a conversation read again is marked again) */ }
  }

  of(key: string): readonly ConversationExposure[] {
    return this.#byKey.get(key) ?? [];
  }

  /** Mark `keys` as having read this source; true when anything changed. */
  add(keys: readonly string[], exposure: ConversationExposure): boolean {
    let changed = false;
    for (const key of keys) {
      const list = this.#byKey.get(key) ?? [];
      if (list.some((entry) => entry.surface === exposure.surface && entry.origin === exposure.origin)) continue;
      if (list.length >= MAX_SOURCES) {
        // Already exposed and full: it stays exposed; another source adds nothing a person needs.
        continue;
      }
      this.#byKey.delete(key);
      this.#byKey.set(key, [...list, exposure]);
      changed = true;
    }
    if (changed) this.#save();
    return changed;
  }

  /** `key` starts with what `from` read (a conversation started inside them, something made there that runs later). */
  inherit(key: string, from: readonly ConversationExposure[]): void {
    let changed = false;
    for (const exposure of from) changed = this.add([key], exposure) || changed;
    if (changed) this.#save();
  }

  clear(key: string): void {
    if (this.#byKey.delete(key)) this.#save();
  }

  #save(): void {
    if (this.#file === undefined) return;
    try {
      const kept = [...this.#byKey].filter(([key]) => !PROCESS_ONLY_KEY.test(key));
      atomicWriteFileSync(this.#file, `${JSON.stringify({ version: 1, conversations: Object.fromEntries(kept) })}\n`, { mkdirp: true });
    } catch { /* kept in memory for this run; the next read of outside text writes it again */ }
  }
}

const store = new ExposureStore();

/** The chain of conversations the running work is inside, outermost first. */
const chain = new AsyncLocalStorage<readonly string[]>();

/** Keep exposures in this file (the daemon's home); set once where a daemon is composed. */
export function setExposureFile(file: string): void {
  store.configure(file);
}

/** What the conversations the running work is inside have read: the union, each source once. */
export function exposureNow(): readonly ConversationExposure[] {
  const keys = chain.getStore() ?? [];
  const seen = new Set<string>();
  const out: ConversationExposure[] = [];
  for (const key of keys) {
    for (const exposure of store.of(key)) {
      const id = `${exposure.surface}\u0000${exposure.origin}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(exposure);
    }
  }
  return out;
}

/** Whether the conversation the running work is in has read text from outside (in this turn or any earlier one). */
export function conversationExposedNow(): boolean {
  return exposureNow().length > 0;
}

/** The words a card says about it: "This conversation has read text from outside: <where>." Undefined when none. */
export function exposureWordsNow(): string | undefined {
  const read = exposureNow();
  if (read.length === 0) return undefined;
  const where = read.slice(0, 3).map((entry) => entry.origin).join(', ');
  return `This conversation has read text from outside: ${where}${read.length > 3 ? ` (and ${String(read.length - 3)} more)` : ''}.`;
}

/**
 * Runs `fn` inside the conversation `key` (none: as it is). A conversation started inside another starts with what that
 * one read; one already in the chain is not entered again.
 */
export function withConversation<T>(key: string | undefined, fn: () => T): T {
  if (key === undefined) return fn();
  const outer = chain.getStore() ?? [];
  if (outer.includes(key)) return fn();
  if (outer.length > 0) store.inherit(key, exposureNow());
  return chain.run([...outer, key], fn);
}

/** A read of outside text in the running work: every conversation it is inside is marked (the helper's parent too). */
export function noteExposure(surface: string, origin: string): void {
  const keys = chain.getStore() ?? [];
  if (keys.length === 0) return;
  store.add(keys, { surface, origin, at: new Date().toISOString() });
}

/** Something made now that runs later under `key` (a schedule, a trigger, Work) starts with what this conversation read. */
export function stampExposure(key: string): void {
  const read = exposureNow();
  if (read.length > 0) store.inherit(key, read);
}

/** What `key` has read (its record: a session's card, a schedule's runs). */
export function exposureOf(key: string): readonly ConversationExposure[] {
  return store.of(key);
}

/** At most this many sources are carried on one call from a program, each at most this long. */
const MAX_CARRIED = MAX_SOURCES;
const MAX_CARRIED_TEXT = 300;

/**
 * What a terminal program's conversation read, as its call to the daemon carries it (runtime/client/call-context.ts
 * `CALL_READ_OUTSIDE_HEADER`): `<surface>=<origin>` pairs, each URI-encoded, joined by `,`. The program's own turn read
 * them (its model, in the program); the daemon cannot see that read, so the program says so with every call it makes.
 */
export function encodeCarriedExposure(read: readonly ConversationExposure[]): string | undefined {
  if (read.length === 0) return undefined;
  return read.slice(0, MAX_CARRIED).map((entry) =>
    `${encodeURIComponent(entry.surface.slice(0, MAX_CARRIED_TEXT))}=${encodeURIComponent(entry.origin.slice(0, MAX_CARRIED_TEXT))}`).join(',');
}

/** The sources a program's call says its conversation read (malformed parts dropped, bounded). */
export function decodeCarriedExposure(raw: string | undefined): readonly ConversationExposure[] {
  if (!raw) return [];
  const out: ConversationExposure[] = [];
  const at = new Date().toISOString();
  for (const part of raw.split(',').slice(0, MAX_CARRIED)) {
    const [surface, origin] = part.split('=');
    if (surface === undefined || origin === undefined) continue;
    try {
      const s = decodeURIComponent(surface).replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, MAX_CARRIED_TEXT);
      const o = decodeURIComponent(origin).replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, MAX_CARRIED_TEXT);
      if (s && o) out.push({ surface: s, origin: o, at });
    } catch { /* not encoded: dropped */ }
  }
  return out;
}

/**
 * Runs `fn` inside the conversation `key` after marking it with what a program's call says it read (`read`), so the
 * daemon decides that call, and every later one of the same conversation, as it decides a daemon turn after a read from
 * outside. It only tightens: a call that carries nothing marks nothing, and nothing a call carries ends an exposure.
 */
export function withCarriedExposure<T>(key: string, read: readonly ConversationExposure[], fn: () => T): T {
  if (read.length > 0) for (const entry of read) store.add([key], entry);
  return withConversation(key, fn);
}

/** Told every key cleared: each is cleared where its record is deleted, so a listener hears the record's end. */
const clearedListeners = new Set<(key: string) => void>();

/**
 * Hears every conversation key cleared (`clearExposure`, called where a chat, a session, a schedule, a trigger or a
 * piece of work is deleted): what else was kept for that record goes with it (the daemon's checkpoint binding of a
 * session, daemon/workspace-checkpointing.ts). Returns the stop.
 */
export function onConversationCleared(listener: (key: string) => void): () => void {
  clearedListeners.add(listener);
  return () => { clearedListeners.delete(listener); };
}

/** A clear that removes what the conversation read: it is no longer exposed (a new start of the same conversation). */
export function clearExposure(key: string): void {
  store.clear(key);
  for (const listener of clearedListeners) {
    try { listener(key); } catch { /* a listener's failure clears nothing else */ }
  }
}

/**
 * program-notices.ts, the notices this terminal program sends on its own events
 * (a turn that ended, an approval waiting, a budget reached, an agent or a piece
 * of work that ended, the model's notify tool), sent through the daemon's one
 * list of webhook addresses (`notifications.send`). The daemon words them under
 * "metadata only" as it is set, retries them, and keeps the ones that fail in
 * its one failed list, which every program and the web UI read. The program
 * keeps no notifier and no failed list of its own.
 *
 * Notices made before the program is wired to its daemon, or while the daemon
 * does not answer, wait (the newest kept) and go when the daemon connection is
 * back. Nothing waits on a clock.
 */
import type { NotificationDelivery } from '@goodvibes/engine/platform/platform/runtime/operations';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/** The most notices kept waiting while the daemon does not answer; the oldest go first. */
const MAX_WAITING = 50;

/** What the daemon answered for one notice (no address: it carries its key). */
export interface ProgramNoticeResult {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly textSent?: boolean | undefined;
  readonly results: readonly { readonly ok: boolean; readonly error?: string | undefined; readonly status?: number | undefined; readonly url: string }[];
}

type Invoke = (method: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;

interface Waiting {
  readonly input: Readonly<Record<string, unknown>>;
}

function resultOf(answer: unknown): ProgramNoticeResult {
  const body = answer !== null && typeof answer === 'object' ? answer as Record<string, unknown> : {};
  const number = (key: string): number => (typeof body[key] === 'number' ? body[key] as number : 0);
  const results = Array.isArray(body['results']) ? body['results'] : [];
  return {
    attempted: number('attempted'), delivered: number('delivered'), failed: number('failed'),
    ...(typeof body['textSent'] === 'boolean' ? { textSent: body['textSent'] } : {}),
    // The address is the daemon's to know; each outcome is named by its number in the daemon's list.
    results: results.map((entry, index) => {
      const row = entry !== null && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      return {
        ok: row['ok'] === true, url: `address ${index + 1}`,
        ...(typeof row['error'] === 'string' ? { error: row['error'] } : {}),
        ...(typeof row['status'] === 'number' ? { status: row['status'] } : {}),
      };
    }),
  };
}

/** This program's notices, sent through its daemon. */
export class ProgramNotices {
  private invoke: Invoke | undefined;
  private program: 'tui' | 'agent' | undefined;
  private waiting: Waiting[] = [];
  private sending = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  /** Wire to the program's daemon; what waited goes now, and again whenever the daemon connection is back. Returns the stop. */
  bind(options: { readonly invoke: Invoke; readonly onDaemonBack: (listener: () => void) => () => void; readonly program: 'tui' | 'agent' }): () => void {
    this.invoke = options.invoke;
    this.program = options.program;
    const stopBack = options.onDaemonBack(() => { void this.flush(); });
    void this.flush();
    return () => { stopBack(); this.invoke = undefined; };
  }

  /** A notice of one of this program's events; the daemon queues and retries it, and keeps it in its failed list when it fails. */
  sendNotification(delivery: NotificationDelivery, event = 'notification'): Promise<ProgramNoticeResult> {
    return this.track(this.post({ kind: delivery.kind, facts: delivery.facts, event }));
  }

  /**
   * Every notice handed over so far has reached the daemon (or, the daemon not answering, still waits here): a
   * headless run awaits this before it ends, so the notices of its last moments go out.
   */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
    await this.flush();
  }

  private track<T>(sending: Promise<T>): Promise<T> {
    this.inFlight.add(sending);
    const done = (): void => { this.inFlight.delete(sending); };
    sending.then(done, done);
    return sending;
  }

  /** The model's own words (its notify tool): sent once, and as a notice without them while "metadata only" is on. */
  async send(text: string, _lifetime?: unknown): Promise<ProgramNoticeResult> {
    if (!this.invoke) throw new Error('The daemon is not reachable, so the notice was not sent.');
    return resultOf(await this.track(this.invoke('notifications.send', { kind: 'text', text, ...(this.program ? { program: this.program } : {}) })));
  }

  private async post(input: Readonly<Record<string, unknown>>): Promise<ProgramNoticeResult> {
    const withProgram = this.program ? { ...input, program: this.program } : input;
    if (this.invoke && this.waiting.length === 0) {
      try { return resultOf(await this.invoke('notifications.send', withProgram)); }
      catch (error) { logger.debug('a notice waits for the daemon', { error: summarizeError(error) }); }
    }
    this.waiting.push({ input: withProgram });
    if (this.waiting.length > MAX_WAITING) this.waiting = this.waiting.slice(-MAX_WAITING);
    return { attempted: 0, delivered: 0, failed: 0, results: [] };
  }

  private async flush(): Promise<void> {
    if (this.sending || !this.invoke) return;
    this.sending = true;
    try {
      while (this.waiting.length > 0 && this.invoke) {
        const next = this.waiting[0]!;
        try { await this.invoke('notifications.send', this.program ? { ...next.input, program: this.program } : next.input); }
        catch (error) { logger.debug('notices still wait for the daemon', { waiting: this.waiting.length, error: summarizeError(error) }); return; }
        this.waiting.shift();
      }
    } finally {
      this.sending = false;
    }
  }
}

/** The one sender of this program's notices (wired to the daemon by wirePlaces, places/index.ts, and by a headless run, native/headless-turn.ts). */
export const programNotices = new ProgramNotices();

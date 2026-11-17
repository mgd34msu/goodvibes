import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { captureJudgmentPort, type JudgmentPortCapture, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { profileDistinctive } from './batteries/redaction.js';
import { isClassicOperation } from '../runtime/decision-policy.js';

/** A source assertion must finish before any observation can proceed. */
export function assertRedactionCurrent(check: (() => void) | undefined): void {
  let late: Error | undefined;
  try { assertSynchronousJudgmentGuard(check, () => (late = new Error('Redaction source ownership must be synchronous'))); }
  catch (error) { throw error === late ? error : new Error('Redaction source is no longer current'); }
}

export interface ProfileRedactionRole {
  readonly field: string;
  readonly sourceKind: 'field' | 'prose';
}
type Entry = {
  readonly owner: JudgmentPortCapture;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  identifying?: boolean;
};

/** Only safe declared roles enter the port; local profile values stay with their owner. */
export class ProfileDistinctiveReader {
  private readonly entries = new Map<string, Entry>();

  read(role: ProfileRedactionRole, source: { readonly assertCurrent: () => void }): boolean | undefined {
    let owner: JudgmentPortCapture;
    try {
      assertJudgmentInput(role); assertRedactionCurrent(() => source.assertCurrent());
      if (isClassicOperation()) return undefined;
      owner = captureJudgmentPort(profileDistinctive.name); owner.assertCurrent();
    }
    catch { return undefined; }
    const key = JSON.stringify(role);
    const existing = this.entries.get(key);
    if (existing?.owner.identity === owner.identity) {
      try { existing.owner.assertCurrent(); assertRedactionCurrent(() => source.assertCurrent()); }
      catch { existing.controller.abort(); this.entries.delete(key); return undefined; }
      return existing.identifying;
    }
    if (existing) { existing.controller.abort(); this.entries.delete(key); }
    if (this.entries.size >= 256) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) { this.entries.get(oldest.value)?.controller.abort(); this.entries.delete(oldest.value); }
    }
    const controller = new AbortController();
    try { owner = captureJudgmentPort(profileDistinctive.name, { signal: controller.signal, assertCurrent: source.assertCurrent }); }
    catch { return undefined; }
    const captured = owner;
    const entry: Entry = { owner, controller, promise: Promise.resolve().then(() => profileDistinctive.run(captured.port,
      { field: role.field, sourceKind: role.sourceKind }, {
        signal: captured.signal, site: profileDistinctive.name, beforeAttempt: captured.assertCurrent,
      })).then((result) => {
      captured.assertCurrent();
      if (this.entries.get(key) !== entry) return;
      const reading = result.readings.identifying;
      if (reading.outcome === 'act' && reading.verdict !== 'uncertain') entry.identifying = reading.verdict === 'yes';
      else this.entries.delete(key);
    }).catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); }) };
    this.entries.set(key, entry);
    return undefined;
  }

  async readAsync(role: ProfileRedactionRole, source: { readonly assertCurrent: () => void }, options: JudgmentReadingOptions = {}): Promise<boolean | undefined> {
    const signal = options.signal, ownerCurrent = options.assertCurrent;
    const assertCurrent = () => {
      if (signal?.aborted || options.signal !== signal || options.assertCurrent !== ownerCurrent) throw new Error('Profile redaction caller is no longer current');
      assertRedactionCurrent(() => source.assertCurrent()); assertRedactionCurrent(ownerCurrent);
    };
    try { assertCurrent(); } catch { return undefined; }
    const value = this.read(role, source);
    if (value !== undefined) return value;
    const entry = this.entries.get(JSON.stringify(role));
    if (entry === undefined) return undefined;
    // A caller may stop waiting without retiring a shared source-owned reading.
    const cancelled = Promise.withResolvers<void>();
    const onAbort = () => cancelled.resolve();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) return undefined;
      await (signal === undefined ? entry.promise : Promise.race([entry.promise, cancelled.promise]));
    } finally { signal?.removeEventListener('abort', onAbort); }
    try { entry.owner.assertCurrent(); assertCurrent(); }
    catch { return undefined; }
    return this.entries.get(JSON.stringify(role)) === entry ? entry.identifying : undefined;
  }
}

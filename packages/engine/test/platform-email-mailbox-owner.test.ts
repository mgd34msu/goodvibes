import { expect, test } from 'bun:test';
import { readEmailConfig } from '../platform/src/platform/email/email-config.js';
import { snapshotFixture } from './_helpers/mail-inbox-snapshot.js';

function fixture() {
  const f = snapshotFixture(); const owner = f.owner!;
  const config = readEmailConfig(key => f.config[key]);
  const read = (validity = 7) => {
    const ticket = owner.beginRead(config); ticket.observeMailbox('INBOX', validity); return ticket;
  };
  return { ...f, owner, config, read };
}

test('observation eviction is bounded and stale callbacks cannot issue a replacement receipt', () => {
  const f = fixture(); const oldest = f.read().completeMailboxObservation()!;
  oldest.signal.addEventListener('abort', () => { f.owner.invalidate(); }, { once: true });
  for (let n = 1; n < 256; n++) expect(f.read().completeMailboxObservation()).toBeDefined();
  expect(f.read().completeMailboxObservation()).toBeUndefined(); expect(oldest.signal.aborted).toBe(true);
});

test('dispose refuses a reentrant source read from an abort listener', () => {
  const f = fixture(); const old = f.read().completeMailboxObservation()!;
  let nested: ReturnType<typeof old.assertCurrent> | undefined;
  old.signal.addEventListener('abort', () => {
    const next = f.read(); expect(next.completeMailboxObservation()).toBeUndefined();
    nested = undefined;
  }, { once: true });
  f.owner.dispose(); expect(old.signal.aborted).toBe(true); expect(nested).toBeUndefined();
});

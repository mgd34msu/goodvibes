import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { registerTriagedInbox, type InboxTriageAuthority } from '../platform/src/platform/intake/triage/owned.js';
import { SqliteTriageStore } from '../platform/src/platform/intake/triage/store.js';
import type { InboundChannelItem } from '../platform/src/platform/intake/provider-adapter.js';
import { acquireOwnedTriageIdentity } from '../platform/src/platform/intake/providers/account-identity.js';
import { tryAcquireCrossProcessLock } from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const row: InboundChannelItem = { id: 'fixture:one', provider: 'fixture', kind: 'dm', subjectPreview: 'Subject', bodyPreview: 'Body', fromDigest: '0123456789abcdef', unread: true, receivedAt: Date.now() };

test('a receipt store that fails to close does not strand the account storage locks', async () => {
  const directory = makeProjectTempDir('triage-owned-close'), catalog = new GatewayMethodCatalog(), authority = new AbortController();
  const fake = fakePort(name => noulAnswer(name.endsWith('spam') ? .01 : .99));
  let control!: Parameters<NonNullable<Parameters<typeof registerTriagedInbox>[1]['gatePolling']>>[1];
  const grant: InboxTriageAuthority = { accountScopeId: 'account-a', providerId: 'fixture', destinationId: 'synthetic-only', retention: 'ephemeral-no-log',
    port: fake.port, signal: authority.signal, assertCurrent() {} };
  const owned = await registerTriagedInbox({ catalog, workingDirectory: directory, logger: { info() {}, warn() {}, error() {} } }, {
    providerId: 'fixture', accountScopeId: 'account-a', authority: grant,
    adapters: new Map([['fixture', { id: 'fixture', pollIntervalMs: 3_600_000, async poll() { return { items: [row], state: 'ready' as const, configured: true }; } }]]),
    acquireReadLease: async () => Object.assign(async () => {}, { assertCurrent() {} }),
    gatePolling(_id, offered) { control = offered; },
  });
  cleanups.push(() => owned.close().catch(() => {}));
  await owned.ready; await control.start(); await control.stop();
  await owned.runInboxTriage();
  const selected = await acquireOwnedTriageIdentity({ workingDirectory: directory, assertCurrent() {} }, 'fixture', 'account-a');
  const operator = join(directory, '.goodvibes', 'tui', 'operator');
  const locks = [`${selected.mirrorFileName}.owner.lock`, `${selected.triageFileName}.owner.lock`].map(name => join(operator, name));
  const failing = spyOn(SqliteTriageStore.prototype, 'close').mockRejectedValue(new Error('synthetic close failure'));
  try {
    await expect(owned.close()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'Triaged inbox receipt store did not close' })] });
  } finally { failing.mockRestore(); }
  for (const lock of locks) {
    const claim = tryAcquireCrossProcessLock(lock);
    try { expect(claim).not.toBeNull(); } finally { claim?.(); }
  }
});

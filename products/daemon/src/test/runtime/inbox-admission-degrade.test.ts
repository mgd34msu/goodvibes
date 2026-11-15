import { expect, test } from 'bun:test';
import { ConfigManager, createDaemonCredentialStore } from '@goodvibes-jev/engine/platform/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { createOwnedInboxSource, type OwnedInboxSource } from '@goodvibes-jev/engine/platform/platform/intake';
import type { HandlerContext } from '../../daemon/handlers/context.js';
import type { DaemonInboxControls, DaemonInboxFactory } from '../../runtime/daemon-handler-composition.js';
import { createReacquiringDaemonInboxSourceFactory, selectConfiguredSlackInboxAccount } from '../../runtime/configured-inbox-accounts.js';
import { InboxAdmissionRefusal } from '../../runtime/inbox-admission-refusal.js';
import type { DaemonInboxSourceFactory } from '../../runtime/multiowner-inbox-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const root = makeOwnedTempDir('inbox-admission-degrade');
  const config = new ConfigManager({ homeDir: root, workingDir: root, surfaceRoot: 'daemon' });
  const warnings: Array<{ message: string; meta: unknown }> = [];
  const context: HandlerContext = { catalog: new GatewayMethodCatalog(), configManager: config,
    credentials: createDaemonCredentialStore({ async get() { return null; }, async set() { throw new Error('No writes'); } }),
    workingDirectory: root, homeDirectory: root,
    logger: { info() {}, warn(message, meta) { warnings.push({ message, meta }); }, error() {} } };
  const controls: DaemonInboxControls = { gatePolling() {},
    onAccountInvalidation(listener) { return config.onDidInvalidate(listener); },
    onConfigurationChange(key, listener) { return config.subscribe(key, listener); },
  };
  return { config, context, controls, warnings };
}
const routing: Parameters<DaemonInboxFactory>[1] = { async initialize() {}, async close() {}, unregister() {}, resolveProfileId: () => null };
const nextTurn = () => new Promise<void>(resolve => { setImmediate(resolve); });

function realSource(context: HandlerContext): OwnedInboxSource {
  return createOwnedInboxSource(context, { storeFileName: 'degrade-email.sqlite',
    adapters: new Map([['email', { id: 'email', pollIntervalMs: 3_600_000,
      async poll() { throw new Error('Lifecycle fixture must not poll provider content'); } }]]),
    skipInitialPoll: true, gatePolling: () => undefined });
}

/** A scheduler the test fires by hand, so no test waits for time to pass. */
function manualClock() {
  const pending: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  return {
    pending,
    schedule: (callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs, cancelled: false }; pending.push(entry);
      return () => { entry.cancelled = true; };
    },
    live: () => pending.filter(entry => !entry.cancelled),
  };
}

test('a half-configured Slack inbox degrades that provider instead of failing the host start', async () => {
  const f = fixture();
  f.config.set('surfaces.slack.enabled', true);
  const factory: DaemonInboxSourceFactory = (context, _routing, controls) => {
    selectConfiguredSlackInboxAccount(context, controls);
    throw new Error('unreachable: the selector refuses first');
  };
  const owned = await createReacquiringDaemonInboxSourceFactory('slack', factory, { retryDelaysMs: [] })(f.context, routing, f.controls);
  try {
    await owned.ready;
    const read = await owned.acquireRead(true);
    expect(read.sources.store.listItems({} as never)).toEqual([]);
    expect(read.sources.poller.snapshotStatuses()).toEqual([
      { id: 'slack', state: 'unavailable', configured: true, itemCount: 0, polled: true, error: 'account-incomplete' }]);
    read.assertCurrent();
    read.release();
    expect(f.warnings[0]?.meta).toMatchObject({ provider: 'slack', reason: 'account-incomplete' });
  } finally { await owned.close(); }
});

test('an admission failure that is not a typed refusal still stops the start', async () => {
  const f = fixture();
  const factory: DaemonInboxSourceFactory = () => { throw new Error('Synthetic storage failure'); };
  const owned = await createReacquiringDaemonInboxSourceFactory('slack', factory, { retryDelaysMs: [] })(f.context, routing, f.controls);
  try {
    await expect(owned.ready).rejects.toThrow('Synthetic storage failure');
  } finally { await owned.close(); }
});

test('a refused re-admission retries on its own and the source reads again without another invalidation', async () => {
  const f = fixture();
  const clock = manualClock();
  let constructions = 0;
  const factory: DaemonInboxSourceFactory = context => {
    constructions++;
    if (constructions === 2) throw new InboxAdmissionRefusal('settings-changing', 'Synthetic transient refusal');
    return realSource(context);
  };
  const owned = await createReacquiringDaemonInboxSourceFactory('email', factory, { retryDelaysMs: [10, 20], schedule: clock.schedule })(f.context, routing, f.controls);
  try {
    await owned.ready;
    f.config.invalidateExternalPolicy();
    await nextTurn(); await nextTurn();
    expect(constructions).toBe(2);
    const degraded = await owned.acquireRead(true);
    expect(degraded.sources.poller.snapshotStatuses()[0]).toMatchObject({ state: 'unavailable', error: 'settings-changing' });
    degraded.release();
    expect(clock.live().map(entry => entry.delayMs)).toEqual([10]);
    clock.live()[0]!.callback();
    await nextTurn(); await nextTurn();
    expect(constructions).toBe(3);
    const read = await owned.acquireRead(true);
    try {
      expect(read.sources.poller.snapshotStatuses()[0]?.state).not.toBe('unavailable');
    } finally { read.release(); }
  } finally { await owned.close(); }
});

test('retries are bounded and closing the source cancels a pending retry', async () => {
  const f = fixture();
  const clock = manualClock();
  let constructions = 0;
  const factory: DaemonInboxSourceFactory = () => { constructions++; throw new InboxAdmissionRefusal('consent-missing', 'Synthetic refusal'); };
  const owned = await createReacquiringDaemonInboxSourceFactory('email', factory, { retryDelaysMs: [1, 2], schedule: clock.schedule })(f.context, routing, f.controls);
  await owned.ready;
  for (let round = 0; round < 4; round++) {
    const next = clock.live()[0];
    if (!next) break;
    next.callback(); clock.pending.splice(clock.pending.indexOf(next), 1);
    await nextTurn(); await nextTurn();
  }
  expect(constructions).toBe(3);
  expect(clock.live()).toEqual([]);
  await owned.close();

  const closing = fixture();
  const second = manualClock();
  const again = await createReacquiringDaemonInboxSourceFactory('email', factory, { retryDelaysMs: [5], schedule: second.schedule })(closing.context, routing, closing.controls);
  await again.ready;
  expect(second.live()).toHaveLength(1);
  await again.close();
  expect(second.live()).toEqual([]);
});

test('the production inbox starts with a half-configured Slack account and reports it unavailable with the reason', async () => {
  const f = fixture();
  const context: HandlerContext = { ...f.context, credentials: {
    inspectConfigSecret() { return 'absent'; }, async resolveConfigSecret() { return null; }, async resolveRef() { return null; },
    async put() { throw new Error('No credential writes'); }, async has() { return false; } } };
  f.config.set('surfaces.slack.enabled', true);
  const { createProductionDaemonInboxFactory } = await import('../../runtime/production-inbox-composition.js');
  const controls: DaemonInboxControls = { ...f.controls,
    async acquireHostedScreening() { throw new Error('Screening must not be acquired for an incomplete account'); } };
  const surface = await createProductionDaemonInboxFactory()(context, routing, controls);
  try {
    await surface.ready;
    const listing = await context.catalog.invoke('channels.inbox.list', { body: {}, context: { scopes: ['read:channels'] } });
    expect(listing).toMatchObject({ items: [], providers: expect.arrayContaining([
      expect.objectContaining({ provider: 'slack', state: 'error', error: 'account-incomplete' })]) });
    expect(f.warnings.some(entry => JSON.stringify(entry.meta).includes('account-incomplete'))).toBe(true);
  } finally { await surface.close(); }
});

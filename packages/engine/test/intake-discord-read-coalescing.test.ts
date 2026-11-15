import { afterEach, expect, test } from 'bun:test';
import { Client } from 'undici/index.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { acquireDiscordInboxIdentity } from '../platform/src/platform/intake/providers/discord-identity.ts';
import { createDiscordInboxOwner, type DiscordInboxOwnerOptions } from '../platform/src/platform/intake/providers/discord-owner.ts';

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const account = { userId: '100000000000000001' };
const channels = ['100000000000000002', '100000000000000004', '100000000000000005'];

async function fixture(now?: () => number) {
  const paths: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const remote = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    await gate;
    if (path === '/api/v10/users/@me') return Response.json({ id: account.userId, bot: true });
    const id = path.split('/').at(-1)!;
    return channels.includes(id) ? Response.json({ id, type: 1, recipients: [{ id: '100000000000000003' }] }) : new Response(null, { status: 404 });
  } });
  cleanups.push(() => remote.stop(true));
  const signal = new AbortController();
  const options: Omit<DiscordInboxOwnerOptions, 'identity'> = { account, ...(now ? { now } : {}),
    channels: { channelIds: channels, revision: 'declared-dm-scope-1', signal: signal.signal, assertCurrent() {} },
    assertCurrent() {},
    screening: { authority: { ownerId: 'synthetic-local-screening', revision: '1', retention: 'ephemeral-no-log', signal: signal.signal, assertCurrent() {} },
      proposal: { endpoint: 'http://127.0.0.1:9', model: 'synthetic-proposer' }, judgment: { endpoint: 'http://127.0.0.1:9', model: 'jev-1.13.0' } } };
  const identity = await acquireDiscordInboxIdentity({ workingDirectory: makeProjectTempDir('discord-read-coalescing'), assertCurrent() {} }, options);
  const owner = await createDiscordInboxOwner({ logger: { info() {}, warn() {}, error() {} },
    credentials: {
      resolveConfigCredentialSnapshot: () => ({ state: 'resolved' as const, value: 'synthetic-discord-token', revision: '1' }),
      resolveRef: async () => null,
      resolveConfigSecret: async () => 'synthetic-discord-token',
    } }, { ...options, identity },
  { createHttpClient: (_origin, settings) => new Client(`http://127.0.0.1:${remote.port}`, settings) });
  cleanups.push(() => owner.close());
  return { owner, paths, release };
}

test('simultaneous read leases share one account proof instead of one per caller', async () => {
  const f = await fixture();
  const leases = Promise.all([1, 2, 3, 4, 5].map(() => f.owner.acquireReadLease()));
  while (f.paths.length < 1) await new Promise<void>(resolve => setTimeout(resolve, 1));
  f.release();
  expect(await leases).toHaveLength(5);
  // One identity call plus one call per configured channel, however many readers asked.
  expect(f.paths).toHaveLength(1 + channels.length);
});

test('a read that starts right after a finished proof reuses it, but the lease closing check and a later read prove again', async () => {
  let clock = 1_000;
  const f = await fixture(() => clock);
  f.release();
  const perProof = 1 + channels.length;
  const first = await f.owner.acquireReadLease();
  expect(f.paths).toHaveLength(perProof);
  // The closing validation always proves the account again.
  await first();
  expect(f.paths).toHaveLength(2 * perProof);
  // A list that starts moments after that proof does not pay for another.
  clock += 1_000;
  const second = await f.owner.acquireReadLease();
  expect(f.paths).toHaveLength(2 * perProof);
  await second();
  expect(f.paths).toHaveLength(3 * perProof);
  // Outside the reuse window the next read proves the account itself.
  clock += 60_000;
  await f.owner.acquireReadLease();
  expect(f.paths).toHaveLength(4 * perProof);
});

/** Real independent-process source owner used by retention regression source. */
import { createOwnedTriagedInboxSource } from '../../platform/src/platform/intake/triage/owned.js';
const root = process.argv[2];
if (!root) throw new Error('A fixture workspace is required');
// Source startup must not itself expire the deliberately archived fixture.
Date.now = () => 0;
const source = await createOwnedTriagedInboxSource({ workingDirectory: root, logger: { info() {}, warn() {}, error() {} } }, {
  providerId: 'fixture', accountScopeId: 'default-retention-account', skipInitialPoll: true,
  adapters: new Map([['fixture', { id: 'fixture', pollIntervalMs: 3_600_000, async poll() { throw new Error('Provider I/O is not authorized'); } }]]),
  acquireReadLease: async () => Object.assign(async () => {}, { assertCurrent() {} }),
});
try {
  await source.ready;
  process.stdout.write('ready\n');
  await new Response(Bun.stdin).text();
} finally { await source.close(); }

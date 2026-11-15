import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerInboxSurface } from '@goodvibes-jev/engine/platform/platform/intake';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

test('a damaged remote runtime store stops the boot instead of leaving paired devices looking gone', async () => {
  const root = makeOwnedTempDir('daemon-remote-store');
  const remote = join(root, 'workspace', '.goodvibes', 'tui', 'remote');
  mkdirSync(remote, { recursive: true });
  writeFileSync(join(remote, 'distributed-runtime.json'), '{"version":');
  await expect(startDaemonFixture({ root,
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
  })).rejects.toThrow(/distributed-runtime|Remove or repair|JSON/i);
});

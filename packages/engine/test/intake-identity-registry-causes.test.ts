import { expect, test } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireAccountInboxIdentity } from '../platform/src/platform/intake/providers/account-identity.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

const slack = { provider: 'slack', account: { workspaceId: 'T-WORKSPACE', userId: 'U-USER' } } as const;
function fixture() {
  const root = makeProjectTempDir('identity-registry-causes'), directory = join(root, '.goodvibes', 'tui', 'operator');
  return { path: join(directory, 'account-inbox-identities.json'), owner: { workingDirectory: root, assertCurrent() {} } };
}

test('a registry restored with the wrong file mode names the permission cause', async () => {
  const f = fixture();
  await acquireAccountInboxIdentity(f.owner, slack);
  chmodSync(f.path, 0o644);
  const failure = await acquireAccountInboxIdentity(f.owner, slack).then(() => null, (error: Error) => error);
  expect(failure?.message).toContain('Inbox native identity registry is unavailable');
  expect(failure?.message).toContain('mode 0600');
});

test('a registry that is not valid for this version names the content cause and never echoes it', async () => {
  const f = fixture();
  await acquireAccountInboxIdentity(f.owner, slack);
  writeFileSync(f.path, '{"secret-looking-value": ', { mode: 0o600 });
  const failure = await acquireAccountInboxIdentity(f.owner, slack).then(() => null, (error: Error) => error);
  expect(failure?.message).toContain('not a valid registry');
  expect(failure?.message).not.toContain('secret-looking-value');
});

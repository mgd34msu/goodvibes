// Proves: A secrets store that exists but cannot be decrypted is taken for empty and written over by the next set; or a credential another process wrote is lost because this one wrote from its remembered copy.
// Red when: readStoreForWrite treats an unreadable store as empty, or a set writes this process's remembered view of the store without reading the file first.
// Proves: A credential the owner sets again is saved where reads do not look, so the old value stays in force while the set reports success.
// Red when: A plaintext set leaves the same scope's secure copy of the key in place, and reads, which consult the secure store first, keep returning the old credential.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { SecretStoreUnreadableError } from '../platform/src/platform/config/secrets-keyfile.ts';

let home: string;
let project: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gv-secrets-home-'));
  project = mkdtempSync(join(tmpdir(), 'gv-secrets-project-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const open = () => new SecretsManager({ projectRoot: project, globalHome: home, surfaceRoot: 'agent', policy: 'preferred_secure' });
const keyFile = () => join(home, '.goodvibes', 'secrets.key');

async function storePath(manager: SecretsManager, key: string): Promise<string> {
  const record = (await manager.listDetailed()).find((entry) => entry.key === key && entry.source !== 'env');
  expect(record?.secure).toBe(true);
  return record!.path!;
}

test('a store this process cannot decrypt is refused for writing and left byte for byte', async () => {
  const first = open();
  await first.set('GV_FIXTURE_CREDENTIAL_A', 'credential-a', { scope: 'user', medium: 'secure' });
  const store = await storePath(first, 'GV_FIXTURE_CREDENTIAL_A');
  const storeBytes = readFileSync(store);
  const originalKey = readFileSync(keyFile());

  const rows: ReadonlyArray<{ readonly name: string; readonly breakKey: () => void }> = [
    { name: 'another valid key in the keyfile', breakKey: () => writeFileSync(keyFile(), `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 }) },
    { name: 'the keyfile removed', breakKey: () => unlinkSync(keyFile()) },
  ];
  for (const row of rows) {
    row.breakKey();
    const keyAfterBreak = existsSync(keyFile()) ? readFileSync(keyFile()) : null;
    const error = await open().set('GV_FIXTURE_CREDENTIAL_B', 'credential-b', { scope: 'user', medium: 'secure' }).then(() => null, (caught: unknown) => caught);
    expect({ row: row.name, refused: error instanceof SecretStoreUnreadableError }).toEqual({ row: row.name, refused: true });
    expect(readFileSync(store).equals(storeBytes)).toBe(true);
    // No key was minted in place of the missing one, and a wrong key was not replaced.
    expect(existsSync(keyFile()) ? readFileSync(keyFile()) : null).toEqual(keyAfterBreak);
    writeFileSync(keyFile(), originalKey, { mode: 0o600 });
  }

  expect((await open().get('GV_FIXTURE_CREDENTIAL_A'))?.reveal('owner-screen')).toBe('credential-a');
});

test('two managers over one home each keep the credential the other wrote', async () => {
  const one = open();
  const two = open();
  await one.set('GV_FIXTURE_CREDENTIAL_A', 'credential-a', { scope: 'user', medium: 'secure' });
  // Both have read the store; each then writes after the other's write.
  expect((await one.get('GV_FIXTURE_CREDENTIAL_A'))?.reveal('owner-screen')).toBe('credential-a');
  expect((await two.get('GV_FIXTURE_CREDENTIAL_A'))?.reveal('owner-screen')).toBe('credential-a');
  await two.set('GV_FIXTURE_CREDENTIAL_B', 'credential-b', { scope: 'user', medium: 'secure' });
  await one.set('GV_FIXTURE_CREDENTIAL_C', 'credential-c', { scope: 'user', medium: 'secure' });

  const fresh = open();
  expect((await fresh.get('GV_FIXTURE_CREDENTIAL_A'))?.reveal('owner-screen')).toBe('credential-a');
  expect((await fresh.get('GV_FIXTURE_CREDENTIAL_B'))?.reveal('owner-screen')).toBe('credential-b');
  expect((await fresh.get('GV_FIXTURE_CREDENTIAL_C'))?.reveal('owner-screen')).toBe('credential-c');
});

test('a credential set again in plaintext replaces its secure copy in the same scope', async () => {
  await open().set('GV_FIXTURE_CREDENTIAL_A', 'credential-old', { scope: 'user', medium: 'secure' });
  await open().set('GV_FIXTURE_CREDENTIAL_A', 'credential-new', { scope: 'user', medium: 'plaintext' });
  expect((await open().get('GV_FIXTURE_CREDENTIAL_A'))?.reveal('owner-screen')).toBe('credential-new');
});

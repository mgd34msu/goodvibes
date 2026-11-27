// Proves: A push device the owner removed, or one of a user who lost admin access, keeps receiving pushes when the authority record could not be written or read at that moment.
// Red when: A removal whose authority-record write failed is not kept pending, so the record serves the deleted device back, or a principal revoked while the record was unreadable is refused or never revoked on the record.
/**
 * The real push subscription store over the real authority record, both in a
 * temp directory. The faults are the disk's: the record's folder made
 * read-only (the record can be read, not written) and the record file made
 * unreadable. A second store on its own file reads the same record, as another
 * daemon of the group does; it serves what the record holds live.
 */
import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushSubscriptionStore } from '../platform/src/platform/push/subscription-store.ts';
import { openAuthorityRecordFile } from '../platform/src/platform/cluster/authority-record-file.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A browser's subscription keys: an uncompressed P-256 point and a 16-byte secret. */
function keys(): { p256dh: string; auth: string } {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { p256dh: point.toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

test('a removed device and a de-admined user\'s devices stop being served here at once and on the record with the next write', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gv-push-record-'));
  dirs.push(home);
  const recordDir = join(home, 'cluster');
  const recordPath = join(recordDir, 'authority-record.json');
  const store = (name: string) => new PushSubscriptionStore(join(home, name, 'push-subscriptions.json'), { authority: openAuthorityRecordFile(recordPath, () => ({})) });
  const here = store('here');
  const other = store('other');
  const served = async (subscriptions: PushSubscriptionStore) => (await subscriptions.all()).map((record) => record.id).sort();

  const phone = await here.register({ principalId: 'owner', endpoint: 'https://push.example.com/send/phone', keys: keys() });
  const alice = await here.register({ principalId: 'user:alice', endpoint: 'https://push.example.com/send/alice', keys: keys() });
  // The control: the other reader knows both devices from the record alone.
  expect(await served(other)).toEqual([phone.id, alice.id].sort());

  // The owner removes their phone while the record can be read but not written.
  chmodSync(recordDir, 0o500);
  let removed: boolean;
  try {
    removed = await here.remove(phone.id);
  } finally {
    chmodSync(recordDir, 0o700);
  }
  expect({ removed, here: await served(here) }).toEqual({ removed: true, here: [alice.id] });

  // Alice loses admin access while the record cannot be read.
  chmodSync(recordPath, 0o000);
  let revoked: number | string;
  try {
    revoked = await here.revokePrincipal('user:alice', 'admin access withdrawn');
  } catch (error) {
    revoked = `refused: ${String(error)}`;
  } finally {
    chmodSync(recordPath, 0o600);
  }
  expect({ revoked, here: await served(here) }).toEqual({ revoked: 1, here: [] });

  // The next write that reaches the record carries both removals to it.
  const tablet = await here.register({ principalId: 'owner', endpoint: 'https://push.example.com/send/tablet', keys: keys() });
  expect({ here: await served(here), other: await served(other) }).toEqual({ here: [tablet.id], other: [tablet.id] });
});

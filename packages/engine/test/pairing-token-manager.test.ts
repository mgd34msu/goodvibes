// Proves: A device token is readable from disk, a revoked device still signs in, or a token it handed off outlives it.
// Red when: The plain token is stored or listed, a revoked token or a token it handed off still authenticates (now or after a reload), the legacy revocation flag is lost on a restart, or the terminal's token store accepts a folder above the home that someone else can write.
// Proves: Revoking the shared operator token ends the value in use every time, the replacement included.
// Red when: A second revoke leaves the first replacement accepted: a copy of it taken off the machine could never be ended.
// Proves: A pairing code nobody used stays a live credential, or a device token past the rotation age still works.
// Red when: The store stops refusing an offer whose time ran out unused, or a device token older than the managed rotation limit.
/**
 * pairing-token-manager.test.ts
 *
 * The PairingTokenManager in isolation: per-device tokens are hashed (never
 * stored/listed in plaintext), authenticate by hash, revoke immediately, and
 * the legacy shared token can be turned off. Custody + revocation semantics,
 * proven against a temp file. A token a paired device mints through the QR
 * hand-off verb is revoked with that device.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { getOrCreateCompanionToken, readCompanionTokenValue, replaceCompanionToken } from '../platform/src/platform/pairing/companion-token.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { registerPairingHandoffGatewayMethods } from '../platform/src/platform/control-plane/routes/pairing-handoff.ts';
import { readAgentHostPairing } from '../terminal-shell/src/agent-turn/connected-host-pairing-store.ts';
import { isTrustedAncestorDirectory } from '../terminal-shell/src/host-pairing-store.ts';
import { openAuthorityRecordFile } from '../platform/src/platform/cluster/authority-record-file.ts';

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-tok-'));
  dirs.push(dir);
  return join(dir, 'control-plane', 'pairing-tokens.json');
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('PairingTokenManager', () => {
  test('mint returns the secret once; the secret is never persisted or listed', () => {
    const file = tempFile();
    const mgr = new PairingTokenManager(file);
    const minted = mgr.mint({ name: 'Pixel' });
    expect(minted.token).toStartWith('gvp_');
    expect(minted.name).toBe('Pixel');

    // The on-disk record holds only a hash, never the plaintext.
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(minted.token);
    expect(raw).toContain('tokenHash');

    // The listable view never carries the secret or the hash. A token is listed as a device once it was used.
    expect(mgr.authenticate(minted.token)?.id).toBe(minted.id);
    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(minted.token);
    expect(JSON.stringify(list)).not.toContain('tokenHash');
    expect(list[0]).toMatchObject({ id: minted.id, name: 'Pixel' });
  });

  test('authenticate matches by hash and revoke is immediate', () => {
    const mgr = new PairingTokenManager(tempFile());
    const a = mgr.mint({ name: 'Laptop' });
    const b = mgr.mint({ name: 'Phone' });

    expect(mgr.authenticate(a.token)?.id).toBe(a.id);
    expect(mgr.authenticate(b.token)?.id).toBe(b.id);
    expect(mgr.authenticate('gvp_not-a-real-token')).toBeNull();

    // Revoke one device, it fails immediately, the other still works.
    expect(mgr.revokeWithMinted(a.id).revoked).toBe(true);
    expect(mgr.authenticate(a.token)).toBeNull();
    expect(mgr.authenticate(b.token)?.id).toBe(b.id);
    // A second revoke of the same id is an honest false.
    expect(mgr.revokeWithMinted(a.id).revoked).toBe(false);
  });

  test('revoking a device revokes every token it minted, and a revoked device cannot mint', () => {
    const file = tempFile();
    const mgr = new PairingTokenManager(file);
    const phone = mgr.mint({ name: 'phone' });
    const minted = mgr.mint({ name: 'tablet', mintedBy: phone.id });
    const grandchild = mgr.mint({ name: 'laptop', mintedBy: minted.id });
    const unrelated = mgr.mint({ name: 'desk' });
    expect(mgr.authenticate(minted.token)?.id).toBe(minted.id);
    expect(mgr.list().find((entry) => entry.id === minted.id)?.mintedBy).toBe(phone.id);

    expect(mgr.revokeWithMinted(phone.id)).toEqual({ revoked: true, alsoRevoked: [minted.id, grandchild.id] });
    for (const store of [mgr, new PairingTokenManager(file)]) {
      expect(store.authenticate(minted.token)).toBeNull();
      expect(store.authenticate(grandchild.token)).toBeNull();
      expect(store.authenticate(unrelated.token)?.id).toBe(unrelated.id);
    }
    expect(() => mgr.mint({ name: 'late', mintedBy: phone.id })).toThrow('no longer paired');
  });

  test('the legacy shared token can be revoked and the flag persists', () => {
    const file = tempFile();
    const mgr = new PairingTokenManager(file);
    expect(mgr.isLegacyRevoked()).toBe(false);
    mgr.revokeLegacyShared();
    expect(mgr.isLegacyRevoked()).toBe(true);
    expect(new PairingTokenManager(file).isLegacyRevoked()).toBe(true);
  });
});

describe('a device on the authority record', () => {
  test('revoked by the owner, it and what it minted stop signing in here and on a second machine reading the record, and are not listed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pairing-record-'));
    dirs.push(dir);
    const recordPath = join(dir, 'cluster', 'authority-record.json');
    const record = openAuthorityRecordFile(recordPath, () => ({}));
    const here = new PairingTokenManager(join(dir, 'here', 'pairing-tokens.json'), { authority: record });
    // Another machine of the group: its own token file, the same record.
    const machine = (name: string) => new PairingTokenManager(join(dir, name, 'pairing-tokens.json'), { authority: openAuthorityRecordFile(recordPath, () => ({})) });
    const elsewhere = machine('elsewhere');
    const phone = here.mint({ name: 'phone' });
    const tablet = here.mint({ name: 'tablet', mintedBy: phone.id });
    const desk = here.mint({ name: 'desk' });
    for (const device of [phone, tablet, desk]) expect(here.authenticate(device.token)?.id).toBe(device.id);
    // Each first use publishes the device to the record; a no-op write queued behind them resolves once they landed.
    await record.write(() => ({ kind: 'none', value: null }));
    const signsIn = (store: PairingTokenManager) => [phone, tablet, desk].map((device) => store.authenticate(device.token)?.id ?? null);
    const listed = (store: PairingTokenManager) => store.list().map((entry) => entry.id).sort();
    // The control: the other machine knows all three from the record alone.
    expect(signsIn(elsewhere)).toEqual([phone.id, tablet.id, desk.id]);

    expect(await here.revokeEverywhere(phone.id)).toEqual({ revoked: true, alsoRevoked: [tablet.id] });
    const later = machine('later');
    expect({ here: signsIn(here), elsewhere: signsIn(elsewhere), later: signsIn(later) }).toEqual({
      here: [null, null, desk.id], elsewhere: [null, null, desk.id], later: [null, null, desk.id],
    });
    expect({ here: listed(here), elsewhere: listed(elsewhere) }).toEqual({ here: [desk.id], elsewhere: [desk.id] });
  });
});

describe('a token minted through the QR hand-off', () => {
  function handoff(file: string) {
    const tokens = new PairingTokenManager(file);
    const catalog = new GatewayMethodCatalog();
    const unused = (): never => { throw new Error('no offer is requested in this proof'); };
    registerPairingHandoffGatewayMethods(catalog, { tokens, push: { getPublicKey: unused, subscribe: unused }, relayAvailable: () => false });
    /** pairing.handoff.create as the paired device `deviceId` asks for it over the gateway. */
    const create = (deviceId: string, name: string) => catalog.invoke('pairing.handoff.create', {
      context: { principalId: `pairing:${deviceId}`, admin: true }, body: { name, offers: [] },
    }) as Promise<{ token: { id: string; token: string } }>;
    return { tokens, create };
  }

  test('is revoked with the device that asked for it, also after a reload', async () => {
    const file = tempFile();
    const { tokens, create } = handoff(file);
    const phone = tokens.mint({ name: 'phone' });
    const unrelated = tokens.mint({ name: 'desk' });
    const { token: tablet } = await create(phone.id, 'tablet');
    expect(tokens.authenticate(tablet.token)?.id).toBe(tablet.id);
    expect(tokens.revokeWithMinted(phone.id).alsoRevoked).toContain(tablet.id);
    for (const store of [tokens, new PairingTokenManager(file)]) {
      expect(store.authenticate(tablet.token)).toBeNull();
      expect(store.authenticate(unrelated.token)?.id).toBe(unrelated.id);
    }
  });
});

describe('shared operator token revocation', () => {
  test('each revoke ends the value in use, the replacement included', () => {
    const daemonHomeDir = mkdtempSync(join(tmpdir(), 'gv-shared-revoke-'));
    dirs.push(daemonHomeDir);
    let served: string = getOrCreateCompanionToken({ daemonHomeDir }).token;
    const store = new PairingTokenManager(join(daemonHomeDir, 'pairing-tokens.json'));
    const unbind = store.bindSharedTokenCustody({
      current: () => served,
      replacementRefusal: () => (readCompanionTokenValue(daemonHomeDir) === served ? null : 'the served token is not the stored one'),
      replace: (commit) => { served = replaceCompanionToken({ daemonHomeDir }, commit).token; },
    });
    try {
      const original = served;
      store.revokeLegacyShared();
      const firstReplacement = served;
      expect(firstReplacement).not.toBe(original);
      expect(store.refusesSharedToken(original)).toBe(true);
      expect(store.refusesSharedToken(firstReplacement)).toBe(false);

      store.revokeLegacyShared();
      const secondReplacement = served;
      expect(secondReplacement).not.toBe(firstReplacement);
      expect(store.refusesSharedToken(firstReplacement)).toBe(true);
      expect(store.refusesSharedToken(secondReplacement)).toBe(false);
      expect(readCompanionTokenValue(daemonHomeDir)).toBe(secondReplacement);
    } finally {
      unbind();
    }
  });
});

describe('a token that is too old', () => {
  /** The store file as it will read later: each named record's field moved into the past. */
  const age = (file: string, id: string, field: 'offeredUntil' | 'createdAt', at: number): void => {
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as { tokens: Array<Record<string, unknown>> };
    for (const record of snapshot.tokens) if (record.id === id) record[field] = at;
    writeFileSync(file, JSON.stringify(snapshot));
  };

  test('an unused pairing code past its offer time and a device token past the rotation limit do not authenticate', () => {
    const file = tempFile();
    const mgr = new PairingTokenManager(file);
    const DAY = 86_400_000;
    const code = mgr.mint({ name: 'Shown on screen' });
    const device = mgr.mint({ name: 'Old phone' });
    expect(mgr.authenticate(device.token)?.id).toBe(device.id);
    age(file, code.id, 'offeredUntil', Date.now() - 1_000);
    age(file, device.id, 'createdAt', Date.now() - 100 * DAY);

    mgr.setRotationLimit(() => 90 * DAY);
    const limited = {
      code: [mgr.authenticate(code.token), mgr.describeRefusal(code.token)?.code],
      device: [mgr.authenticate(device.token), mgr.describeRefusal(device.token)?.code],
    };
    mgr.setRotationLimit(undefined);
    expect({ ...limited, deviceWithoutLimit: mgr.authenticate(device.token)?.id }).toEqual({
      code: [null, 'PAIRING_OFFER_EXPIRED'],
      device: [null, 'PAIRING_TOKEN_ROTATION_DUE'],
      deviceWithoutLimit: device.id,
    });
  });
});

describe('the folders above a saved device token', () => {
  /**
   * Anyone who can write a folder above the home can swap the store's folder
   * for one they control, then read the device token or plant their own. The
   * terminal's pairing store reads every folder above the home first. A
   * folder owned by the namespace's overflow user (real root's folders seen
   * from a rootless container) cannot be changed by anyone here, so it is
   * accepted, only while nobody else can write it.
   */
  test('a device token store under a folder others can write is refused; one owned by the overflow user only when nobody else can write it', () => {
    const base = mkdtempSync(join(tmpdir(), 'pairing-ancestor-'));
    dirs.push(base);
    const store = (mode: number): string => {
      const folder = join(base, `mode-${mode.toString(8)}`);
      const home = join(folder, 'home');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // Bun's chmod drops the sticky bit, so the system's chmod sets the mode.
      expect(Bun.spawnSync(['chmod', mode.toString(8), folder]).exitCode).toBe(0);
      const read = readAgentHostPairing(home, 'http://127.0.0.1:3421');
      return read.status === 'unavailable' ? read.cause : read.status;
    };
    const onDisk = { world: store(0o777), group: store(0o775), sticky: store(0o1777), private: store(0o755) };
    expect(onDisk).toEqual({ world: 'ancestor-unsafe', group: 'ancestor-unsafe', sticky: 'missing', private: 'missing' });

    // Ownership this account cannot give a folder on disk: the same check, given the folder's facts.
    const overflow = Number(readFileSync('/proc/sys/kernel/overflowuid', 'utf8').trim());
    const folder = (uid: number, mode: number): Stats => ({ ...lstatSync(base), uid, mode: 0o040000 | mode, isDirectory: () => true, isSymbolicLink: () => false }) as Stats;
    const me = process.geteuid!();
    expect({
      overflowPrivate: isTrustedAncestorDirectory(folder(overflow, 0o755), me),
      overflowWorldWritable: isTrustedAncestorDirectory(folder(overflow, 0o777), me),
      overflowGroupWritable: isTrustedAncestorDirectory(folder(overflow, 0o775), me),
      overflowSticky: isTrustedAncestorDirectory(folder(overflow, 0o1777), me),
      anotherUser: isTrustedAncestorDirectory(folder(me + 4242, 0o755), me),
    }).toEqual({ overflowPrivate: true, overflowWorldWritable: false, overflowGroupWritable: false, overflowSticky: true, anotherUser: false });
  });
});

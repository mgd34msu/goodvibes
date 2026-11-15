/**
 * Owner locks left by a crash are reclaimed only when their recorded holder is
 * proven dead; anything else is refused with the lock path named. Transient
 * pairing-store faults recover at the next capture or stamp, without a restart.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PairingTokenManager, PairingTokenStoreBusyError } from '../platform/src/platform/pairing/pairing-token-store.js';
import { setOwnerLockWaitForTest } from '../platform/src/platform/config/durable-policy-epoch.js';
import * as atomic from '../platform/src/platform/utils/atomic-json-store.js';

const dirs: string[] = [];
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string { const dir = mkdtempSync(join(tmpdir(), 'gv-owner-lock-')); dirs.push(dir); return dir; }
function pairingLock(file: string): string { return join(dirname(file), '.pairing-owner-locks', `${basename(file)}.lock`); }
/** A pid that existed and has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  if (typeof child.pid !== 'number') throw new Error('no child pid');
  return child.pid;
}
function crashHeldLock(lock: string, holder: { pid: number; start: string | null } | null): void {
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  if (holder) writeFileSync(join(lock, 'owner'), JSON.stringify(holder), { mode: 0o600 });
}

describe('pairing owner lock', () => {
  test('a lock whose recorded holder has exited is reclaimed', () => {
    const file = join(directory(), 'pairing.json');
    const manager = new PairingTokenManager(file);
    manager.mint({ name: 'First device' });
    crashHeldLock(pairingLock(file), { pid: deadPid(), start: null });
    expect(manager.mint({ name: 'Second device' }).name).toBe('Second device');
    expect(existsSync(pairingLock(file))).toBe(false);
  });

  test.if(process.platform === 'linux')('a lock whose pid now belongs to a different process is reclaimed', () => {
    const file = join(directory(), 'pairing.json');
    const manager = new PairingTokenManager(file);
    crashHeldLock(pairingLock(file), { pid: process.pid, start: '1' });
    expect(manager.mint({ name: 'Device' }).name).toBe('Device');
  });

  test('a lock without a recorded holder, or held by a live process, is refused and named', () => {
    const file = join(directory(), 'pairing.json');
    const manager = new PairingTokenManager(file);
    restores.push(setOwnerLockWaitForTest(() => {}));
    crashHeldLock(pairingLock(file), null);
    expect(() => manager.mint({ name: 'Refused' })).toThrow(PairingTokenStoreBusyError);
    expect(() => manager.mint({ name: 'Refused' })).toThrow(pairingLock(file));
    rmSync(pairingLock(file), { recursive: true });
    crashHeldLock(pairingLock(file), { pid: process.pid, start: null });
    expect(() => manager.mint({ name: 'Refused' })).toThrow(`held by process ${process.pid}`);
    expect(existsSync(pairingLock(file))).toBe(true);
  });
});

describe('pairing owner lock being taken', () => {
  test('a lock whose holder has not written its record yet is waited for, not refused', () => {
    const file = join(directory(), 'pairing.json');
    const manager = new PairingTokenManager(file);
    manager.mint({ name: 'First device' });
    const lock = pairingLock(file);
    crashHeldLock(lock, null);
    // The other process finishes its write and releases while this one waits.
    let waits = 0;
    restores.push(setOwnerLockWaitForTest(() => { waits++; rmSync(lock, { recursive: true, force: true }); }));
    expect(manager.mint({ name: 'Second device' }).name).toBe('Second device');
    expect(waits).toBe(1);
  });
});

describe('pairing store faults', () => {
  test('a first use whose claim cannot be written is refused, and the next use claims', () => {
    const file = join(directory(), 'pairing.json');
    const manager = new PairingTokenManager(file);
    const minted = manager.mint({ name: 'Device' });
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic ENOSPC'); });
    restores.push(() => write.mockRestore());
    expect(manager.authenticate(minted.token)).toBeNull();
    write.mockRestore();
    expect(manager.authenticate(minted.token)?.id).toBe(minted.id);
    expect(manager.authenticateNative(minted.token)?.tokenId).toBe(minted.id);
  });

  test('one failed durability confirmation does not latch settings authority', () => {
    const file = join(directory(), 'pairing.json');
    const manager = new PairingTokenManager(file);
    const minted = manager.mint({ name: 'Device' });
    const confirm = spyOn(atomic, 'confirmFileDurable').mockImplementationOnce(() => { throw new Error('synthetic fsync'); });
    restores.push(() => confirm.mockRestore());
    expect(manager.captureSettingsAuthority({ kind: 'pairing-token', token: minted.token })).toBeNull();
    expect(manager.captureSettingsAuthority({ kind: 'pairing-token', token: minted.token })).not.toBeNull();
  });

  test('a mint that fails to persist does not hold settings authority, a revoke that fails to persist still does', () => {
    const file = join(directory(), 'pairing.json');
    const manager = new PairingTokenManager(file);
    const device = manager.mint({ name: 'Device' });
    const capture = () => manager.captureSettingsAuthority({ kind: 'pairing-token', token: device.token });
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic ENOSPC'); });
    restores.push(() => write.mockRestore());
    expect(() => manager.mint({ name: 'Second device' })).toThrow('synthetic ENOSPC');
    // Adding authority cannot leave a revocation unrecorded; the next capture re-reads the store.
    expect(capture()).not.toBeNull();

    const revokeWrite = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic ENOSPC'); });
    restores.push(() => revokeWrite.mockRestore());
    expect(() => manager.revoke(device.id)).toThrow('synthetic ENOSPC');
    expect(capture()).toBeNull();
    expect(capture()).toBeNull();
  });

  test('a failed first-use claim does not hold settings authority', () => {
    const file = join(directory(), 'pairing.json');
    const manager = new PairingTokenManager(file);
    const device = manager.mint({ name: 'Device' });
    const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation(() => { throw new Error('synthetic ENOSPC'); });
    restores.push(() => write.mockRestore());
    expect(manager.authenticate(device.token)).toBeNull();
    write.mockRestore();
    expect(manager.captureSettingsAuthority({ kind: 'pairing-token', token: device.token })).not.toBeNull();
  });

  test('after its first use a device token authenticates with no write to the store', () => {
    const file = join(directory(), 'pairing.json');
    const manager = new PairingTokenManager(file);
    const device = manager.mint({ name: 'Device' });
    expect(manager.authenticate(device.token)?.id).toBe(device.id);
    const write = spyOn(atomic, 'writeJsonFileAtomic');
    restores.push(() => write.mockRestore());
    for (let i = 0; i < 5; i++) expect(manager.authenticate(device.token)?.id).toBe(device.id);
    expect(write).toHaveBeenCalledTimes(0);
    manager.flushLastSeen();
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('a store opened while another owner held the lock verifies itself at the next capture', () => {
    const file = join(directory(), 'pairing.json');
    const minted = new PairingTokenManager(file).mint({ name: 'Device' });
    crashHeldLock(pairingLock(file), { pid: process.pid, start: null });
    const opened = new PairingTokenManager(file);
    rmSync(pairingLock(file), { recursive: true });
    expect(opened.captureSettingsAuthority({ kind: 'pairing-token', token: minted.token })).not.toBeNull();
  });
});

describe('pairing device list', () => {
  test('a device minted by another process on the same store is listed', () => {
    const file = join(directory(), 'pairing.json');
    const first = new PairingTokenManager(file);
    first.mint({ name: 'Phone' });
    const second = new PairingTokenManager(file);
    const tablet = second.mint({ name: 'Tablet' });
    expect(second.authenticate(tablet.token)?.id).toBe(tablet.id);
    expect(first.list().map(device => device.id)).toContain(tablet.id);
  });
});

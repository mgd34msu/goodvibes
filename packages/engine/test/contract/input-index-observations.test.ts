/** UNRUN regressions for original index observations and saved logical commitments. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureContractInput, assertContractInputOwner, releaseContractInputObservations } from '../../platform/src/platform/contract/input-snapshot.js';
import { makeRepo } from './runner-support.js';
import { git } from './steps-support.js';

function rewriteIndex(root: string): void {
  const path = join(root, '.git', 'index'); writeFileSync(path, readFileSync(path));
}
function physicalIndex(root: string): string {
  const stat = lstatSync(join(root, '.git', 'index'), { bigint: true });
  return `git-index-v2:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

test('actual capture saves one complete logical index pin; warm owner checks use direct originals', async () => {
  const root = makeRepo('sha1'), hashing = spyOn(crypto, 'createHash');
  try {
    const snapshot = await captureContractInput(root);
    const files = snapshot.files.filter(file => file.kind !== 'missing').length;
    expect(snapshot.indexFingerprint).toMatch(/^[a-f0-9]{64}$/);
    // SHA-1 files need independent byte pins. The extra pin commits the full
    // logical index, whose private excluded paths are not persisted as text.
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(files + 1);
    hashing.mockClear();
    await assertContractInputOwner(snapshot);
    rewriteIndex(root);
    await assertContractInputOwner(snapshot);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    // A public copy cannot borrow capture's private original to skip checking
    // its changed persisted expectation.
    await expect(assertContractInputOwner({ ...snapshot, indexFingerprint: '0'.repeat(64) })).rejects.toThrow('index changed');
  } finally { hashing.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('index flag changes after the saved commitment check still refuse at the end of the same owner recheck', async () => {
  const root = makeRepo('sha1');
  try {
    const snapshot = await captureContractInput(root), controller = new AbortController();
    const hashing = spyOn(crypto, 'createHash');
    const originalAbortCheck = controller.signal.throwIfAborted.bind(controller.signal);
    let changed = false;
    const interrupt = spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      originalAbortCheck();
      if (!changed && hashing.mock.calls.some(([algorithm]) => algorithm === 'sha256')) {
        changed = true;
        // A logical index flag changes without changing HEAD or file bytes.
        git(root, 'update-index', '--assume-unchanged', 'README.md');
      }
    });
    try {
      await expect(assertContractInputOwner(structuredClone(snapshot), controller.signal)).rejects.toThrow('changed during recheck');
      expect(changed).toBe(true);
    } finally { interrupt.mockRestore(); hashing.mockRestore(); }
    await expect(assertContractInputOwner(snapshot)).rejects.toThrow('index changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a benign index rewrite during a cold saved-pin check preserves identical logical input without a second index hash', async () => {
  const root = makeRepo('sha1');
  try {
    const snapshot = await captureContractInput(root), controller = new AbortController();
    const hashing = spyOn(crypto, 'createHash');
    const originalAbortCheck = controller.signal.throwIfAborted.bind(controller.signal);
    let rewritten = false;
    const interrupt = spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      originalAbortCheck();
      if (!rewritten && hashing.mock.calls.some(([algorithm]) => algorithm === 'sha256')) {
        rewritten = true; rewriteIndex(root);
      }
    });
    try {
      await assertContractInputOwner(structuredClone(snapshot), controller.signal);
      expect(rewritten).toBe(true);
      const files = snapshot.files.filter(file => file.kind !== 'missing').length;
      // The cold read verifies the independently saved logical pin once; its
      // same-call replacement compares the actual captured buffers directly.
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(files + 1);
    } finally { interrupt.mockRestore(); hashing.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('saved index pins verify equal logical state after restart and refuse a different saved expectation', async () => {
  const root = makeRepo('sha1');
  try {
    const snapshot = await captureContractInput(root), hashing = spyOn(crypto, 'createHash');
    try {
      rewriteIndex(root);
      await assertContractInputOwner(structuredClone(snapshot));
      const files = snapshot.files.filter(file => file.kind !== 'missing').length;
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(files + 1);
      hashing.mockClear();
      await expect(assertContractInputOwner({ ...snapshot, indexFingerprint: 'a'.repeat(64) })).rejects.toThrow('index changed');
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    } finally { hashing.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('executor drainage releases private logical originals; a later changed physical index verifies the actual saved pin', async () => {
  const root = makeRepo('sha1');
  try {
    const snapshot = await captureContractInput(root), hashing = spyOn(crypto, 'createHash');
    try {
      releaseContractInputObservations(snapshot);
      expect(hashing.mock.calls).toHaveLength(0);
      rewriteIndex(root);
      await assertContractInputOwner(snapshot);
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
      hashing.mockClear(); await assertContractInputOwner(snapshot);
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
      // Terminal history does not regain retained private logical buffers:
      // another physical rewrite must verify its independent saved pin again.
      rewriteIndex(root); await assertContractInputOwner(snapshot);
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    } finally { hashing.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unreleased physical-only index records remain readable and never invent missing original logical evidence', async () => {
  const root = makeRepo('sha1');
  try {
    const snapshot = await captureContractInput(root);
    const old = { ...snapshot, indexFingerprint: physicalIndex(root) }, cold = structuredClone(old);
    const hashing = spyOn(crypto, 'createHash');
    try {
      await assertContractInputOwner(old);
      const files = snapshot.files.filter(file => file.kind !== 'missing').length;
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(files);
      hashing.mockClear(); rewriteIndex(root);
      // This real in-process owner retained the previously verified originals.
      await assertContractInputOwner(old);
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
      // A separate cold record knows only the former physical observation.
      await expect(assertContractInputOwner(cold)).rejects.toThrow('index changed');
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    } finally { hashing.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

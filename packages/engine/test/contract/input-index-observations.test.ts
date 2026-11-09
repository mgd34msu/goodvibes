/** UNRUN regressions for original index observations and saved logical commitments. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureContractInput, assertContractInputOwner } from '../../sdk/src/platform/contract/input-snapshot.js';
import { makeRepo } from './runner-support.js';
import { git } from './steps-support.js';

test('actual capture hashes the saved logical index once; owner rechecks retain exact private index observations', async () => {
  const root = makeRepo('sha1'), hashing = spyOn(crypto, 'createHash');
  try {
    const snapshot = await captureContractInput(root);
    const files = snapshot.files.filter(file => file.kind !== 'missing').length;
    // SHA-1 files still carry their recorded strong byte commitments. This
    // budget excludes those two complete file passes and counts only the index.
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(2 * files + 1);
    hashing.mockClear();
    await assertContractInputOwner(snapshot);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(files + 1);
    // A public copy cannot borrow capture's private original to skip checking
    // its changed persisted commitment.
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
      await expect(assertContractInputOwner(snapshot, controller.signal)).rejects.toThrow('changed during recheck');
      expect(changed).toBe(true);
    } finally { interrupt.mockRestore(); hashing.mockRestore(); }
    await expect(assertContractInputOwner(snapshot)).rejects.toThrow('index changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('an incidental index rewrite still compares the whole saved logical state instead of refusing physical drift alone', async () => {
  const root = makeRepo('sha1');
  try {
    const snapshot = await captureContractInput(root), controller = new AbortController();
    const hashing = spyOn(crypto, 'createHash');
    let rewritten = false;
    const interrupt = spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (!rewritten && hashing.mock.calls.some(([algorithm]) => algorithm === 'sha256')) {
        rewritten = true;
        const index = join(root, '.git', 'index');
        writeFileSync(index, readFileSync(index));
      }
    });
    try {
      await assertContractInputOwner(snapshot, controller.signal);
      expect(rewritten).toBe(true);
      const files = snapshot.files.filter(file => file.kind !== 'missing').length;
      // The physical change alone triggers exactly one extra full comparison.
      expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(files + 2);
    } finally { interrupt.mockRestore(); hashing.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

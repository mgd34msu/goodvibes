/** Actual source/readset reuse; qualification runs after the source freeze. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertContractInputOwner, captureContractInput } from '../../platform/src/platform/contract/input-snapshot.js';
import { makeRepo } from './runner-support.js';
import { git } from './steps-support.js';

for (const format of ['sha1', 'sha256'] as const) test(`native ${format} owner rechecks reuse actual original byte observations without hashing again`, async () => {
  const root = makeRepo(format);
  const hashing = spyOn(crypto, 'createHash');
  try {
    const snapshot = await captureContractInput(root);
    const files = snapshot.files.filter(file => file.kind !== 'missing');
    // The index has its own saved commitment. Native Git SHA256 files need
    // their blob OID, whereas SHA1 files need the independent strong digest.
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(files.length + 1);
    hashing.mockClear();
    await assertContractInputOwner(snapshot);
    await assertContractInputOwner(snapshot);
    expect(hashing.mock.calls).toHaveLength(0);
    const reopened = structuredClone(snapshot);
    await assertContractInputOwner(reopened);
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(files.length + 1);
    hashing.mockClear();
    await assertContractInputOwner(reopened);
    expect(hashing.mock.calls).toHaveLength(0);
    const forged = structuredClone(snapshot);
    const first = forged.files.find(file => file.kind !== 'missing')!;
    const changed = { ...forged, files: forged.files.map(file => file === first ? { ...file, oid: '0'.repeat(first.oid!.length) } : file) };
    await expect(assertContractInputOwner(changed)).rejects.toThrow('owner changed');
    expect(hashing.mock.calls.length).toBeGreaterThan(0);
  } finally { hashing.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

for (const mutation of ['bytes', 'same-bytes-replacement', 'bytes-restored', 'parent-replacement', 'missing-file', 'missing-parent'] as const) test(`warm source proof refuses ${mutation} instead of adopting its saved identity`, async () => {
  const root = makeRepo('sha1');
  try {
    if (mutation === 'parent-replacement' || mutation === 'missing-parent') {
      mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/csv.ts'), 'original leaf\n');
      git(root, 'add', 'src/csv.ts'); git(root, 'commit', '-qm', 'tracked original parent');
    }
    const snapshot = await captureContractInput(root);
    const path = join(root, 'README.md'), original = readFileSync(path), before = lstatSync(path);
    if (mutation === 'missing-file') rmSync(path);
    else if (mutation === 'missing-parent') rmSync(join(root, 'src'), { recursive: true });
    else if (mutation === 'same-bytes-replacement') {
      renameSync(path, `${path}.original`);
      writeFileSync(path, original);
      rmSync(`${path}.original`);
    } else if (mutation === 'parent-replacement') {
      const directory = join(root, 'src'), moved = join(root, 'src-original');
      renameSync(directory, moved);
      // Move back the exact leaf inode under a new physical parent.
      mkdirSync(directory);
      renameSync(join(moved, 'csv.ts'), join(directory, 'csv.ts'));
      rmSync(moved, { recursive: true });
    } else {
      const changed = Buffer.from(original); changed[0] = changed[0]! ^ 1;
      writeFileSync(path, changed);
      if (mutation === 'bytes-restored') { writeFileSync(path, original); utimesSync(path, before.atime, before.mtime); }
    }
    await expect(assertContractInputOwner(snapshot)).rejects.toMatchObject({ change: 'file' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a callback changing an earlier file during a later async check cannot publish a warm original readset', async () => {
  const root = makeRepo('sha1');
  try {
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/csv.ts'), 'later leaf\n');
    const snapshot = await captureContractInput(root), signal = new AbortController().signal;
    const inspected = spyOn(fs, 'lstatSync');
    let changed = false;
    const interrupted = spyOn(signal, 'throwIfAborted').mockImplementation(() => {
      // The warm original has inspected this actual leaf, then reaches another
      // asynchronous file check. The complete final readset must still reject
      // a change to the earlier file rather than only checking the last file.
      if (!changed && inspected.mock.calls.some(([path]) => path === join(root, 'README.md'))) {
        changed = true; writeFileSync(join(root, 'README.md'), 'changed after its earlier owner check\n');
      }
    });
    try {
      await expect(assertContractInputOwner(snapshot, signal)).rejects.toThrow('changed');
      expect(changed).toBe(true);
    } finally { interrupted.mockRestore(); inspected.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('warm physical proof never follows a receipt metadata mutation across its asynchronous owner checks', async () => {
  const root = makeRepo('sha1');
  try {
    const snapshot = await captureContractInput(root), signal = new AbortController().signal;
    const hashing = spyOn(crypto, 'createHash');
    let changed = false;
    const interrupted = spyOn(signal, 'throwIfAborted').mockImplementation(() => {
      if (!changed) { changed = true; Object.defineProperty(snapshot, 'ownerRef', { value: 'replacement-ref' }); }
    });
    try {
      await expect(assertContractInputOwner(snapshot, signal)).rejects.toThrow();
      expect(changed).toBe(true);
      expect(hashing.mock.calls).toHaveLength(0);
      await expect(assertContractInputOwner(snapshot)).rejects.toThrow();
    } finally { interrupted.mockRestore(); hashing.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a warm receipt cannot skip the actual owner cancellation guard', async () => {
  const root = makeRepo('sha1');
  try {
    const snapshot = await captureContractInput(root), cancellation = new AbortController();
    cancellation.abort(new Error('Actual owner check cancelled'));
    const hashing = spyOn(crypto, 'createHash');
    try {
      await expect(assertContractInputOwner(snapshot, cancellation.signal)).rejects.toThrow('Actual owner check cancelled');
      expect(hashing.mock.calls).toHaveLength(0);
    } finally { hashing.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

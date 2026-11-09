/** Source regressions authored during coding; execution remains deferred. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeReaderCapabilities } from '../../platform/src/platform/runtime/self-update.js';
import { inspectTerminalReaderArtifact, recordTerminalReaderArtifact, retainTerminalReaderCohort, verifyTerminalReaderArtifact } from '../../toolchain/src/lib/client-reader-artifact.js';
import { retainNativeArtifactFiles } from '@goodvibes-jev/engine/toolchain';
import { makeProjectTempDir } from '../_helpers/project-temp.js';

function fixture() {
  const directory = makeProjectTempDir('terminal-reader-producer'); mkdirSync(directory, { recursive: true });
  const asset = 'goodvibes-linux-x64', marker = join(directory, 'metadata-invoked');
  const readers = nativeReaderCapabilities('3.1.2');
  writeFileSync(join(directory, asset), `#!/bin/sh\nprintf invoked > '${marker}'\nprintf '%s\\n' '${JSON.stringify(readers)}'\n`, { mode: 0o755 });
  for (const suffix of ['.bun', '.bun.LICENSE.md', '.bun.json']) {
    writeFileSync(join(directory, asset + suffix), 'Original captured member');
    chmodSync(join(directory, asset + suffix), suffix === '.bun' ? 0o755 : 0o644);
  }
  const assertCurrent = retainTerminalReaderCohort(directory, '@goodvibes-jev/tui', 'linux-x64');
  const files = ['', '.bun', '.bun.LICENSE.md', '.bun.json'].map(suffix => {
    const path = asset + suffix, bytes = readFileSync(join(directory, path)), stat = statSync(join(directory, path));
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), mode: stat.mode & 0o777, size: bytes.length };
  });
  return { directory, asset, marker, readers, input: { directory, assertCurrent, files, packageName: '@goodvibes-jev/tui' as const,
    version: '3.1.2', target: 'linux-x64' as const, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40) } };
}

test('native producer binds its compiled profile to the exact source and already pinned cohort', () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  const f = fixture(); recordTerminalReaderArtifact(f.input);
  const stored = JSON.parse(readFileSync(join(f.directory, 'reader-ci-artifact.json'), 'utf8'));
  expect(stored).toMatchObject({ schema: 1, packageName: '@goodvibes-jev/tui', version: '3.1.2', readers: f.readers, files: f.input.files });
  expect(verifyTerminalReaderArtifact(f.input)).toEqual(stored);
  stored.readers.formats = [];
  writeFileSync(join(f.directory, 'reader-ci-artifact.json'), JSON.stringify(stored));
  expect(() => verifyTerminalReaderArtifact(f.input)).toThrow('differs');
});

test('a physical replacement after producer pinning cannot run or receive new reader evidence', () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  const f = fixture(); writeFileSync(join(f.directory, f.asset), 'Different program');
  expect(() => inspectTerminalReaderArtifact(f.input)).toThrow('changed'); expect(existsSync(f.marker)).toBe(false);
  expect(existsSync(join(f.directory, 'reader-ci-artifact.json'))).toBe(false);
});


test('a public pin DTO with a no-op callback cannot decorate an actual compiled reader with forged bytes', () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  const f = fixture();
  const files = f.input.files.map((file, index) => index === 0 ? { ...file, sha256: '0'.repeat(64) } : file);
  expect(() => inspectTerminalReaderArtifact({ ...f.input, files, assertCurrent() {} })).toThrow('actual original payloads');
  expect(existsSync(f.marker)).toBe(false);
  expect(existsSync(join(f.directory, 'reader-ci-artifact.json'))).toBe(false);
});

test('only genuine original pins skip repeated local hashing; a foreign or copied owner never does', () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  const f = fixture();
  const original = retainNativeArtifactFiles(f.directory, f.input.files.map(file => ({ path: file.path })), { directoryRevisions: false });
  const hash = spyOn(crypto, 'createHash');
  try {
    const first = inspectTerminalReaderArtifact({ ...f.input, retained: original });
    expect(first.files).toEqual(f.input.files);
    inspectTerminalReaderArtifact({ ...f.input, retained: original });
    expect(hash).not.toHaveBeenCalled();
    // Independent no-owner consumers retain public API compatibility, but must
    // actually cold-verify all four real files, not trust supplied checksums.
    inspectTerminalReaderArtifact(f.input);
    expect(hash).toHaveBeenCalledTimes(4);
    for (const copy of [{ ...original }, Object.create(original)]) {
      expect(() => inspectTerminalReaderArtifact({ ...f.input, retained: copy })).toThrow('original retained owner');
    }
    const other = fixture(), otherOwner = retainNativeArtifactFiles(other.directory,
      other.input.files.map(file => ({ path: file.path })), { directoryRevisions: false });
    expect(() => inspectTerminalReaderArtifact({ ...f.input, retained: otherOwner })).toThrow('another selected root');
  } finally { hash.mockRestore(); }
});

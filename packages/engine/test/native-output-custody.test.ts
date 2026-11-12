/** Real filesystem/tar output custody; inert cohorts do not certify native execution. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { archiveNativeExecutionArtifact, nativeExecutionPayloadMembers, recordNativeExecutionArtifact } from '../../../products/daemon/scripts/native-execution-artifact.mjs';
import { runNativeArchive } from '../../../products/daemon/scripts/native-execution-process.mjs';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { createReleaseStage } from '@goodvibes-jev/engine/toolchain/release-publication';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true }); });
function scratch() { const root = makeProjectTempDir('native-output-custody'); roots.push(root); return root; }
function nativeCohort() {
  const root = scratch(), product = join(root, 'products/daemon'); mkdirSync(product, { recursive: true });
  copyFileSync(new URL('../../../products/daemon/toolchain.config.json', import.meta.url), join(product, 'toolchain.config.json'));
  writeFileSync(join(product, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', version: '3.1.2' }));
  const source = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), target: 'linux-x64' as const, runId: '17', runAttempt: '2' };
  const members = nativeExecutionPayloadMembers(product, source.target);
  for (const member of members) {
    const path = join(product, 'native', member.path); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `inert original ${member.path}`, { mode: member.mode }); chmodSync(path, member.mode);
  }
  recordNativeExecutionArtifact(product, source);
  const output = join(root, 'outputs'); mkdirSync(output);
  return { root, product, source, members, output };
}

test('private stage permission publication changes only the original directory descriptor', () => {
  const root = scratch(), changeMode = fs.fchmodSync;
  let replacement: string | undefined;
  const mode = spyOn(fs, 'fchmodSync').mockImplementation((fd, bits) => {
    if (bits === 0o700 && fs.fstatSync(fd).isDirectory() && replacement === undefined) {
      const name = readdirSync(root).find(name => name.startsWith('.owned-stage-'));
      if (!name) throw new Error('Original stage directory missing');
      replacement = join(root, name);
      renameSync(replacement, replacement + '.original'); mkdirSync(replacement, { mode: 0o755 }); chmodSync(replacement, 0o755);
    }
    changeMode(fd, bits);
  });
  try {
    expect(() => createReleaseStage(root, '.owned-stage-')).toThrow('changed during creation');
    expect(replacement).toBeDefined(); expect(statSync(replacement!).mode & 0o777).toBe(0o755);
    expect(statSync(replacement! + '.original').mode & 0o777).toBe(0o700);
  } finally { mode.mockRestore(); }
});

test('actual native archive publishes its complete cohort through an exclusive descriptor without overwriting a foreign output', async () => {
  const f = nativeCohort(), path = join(f.output, 'daemon-native-linux-x64.tgz');
  writeFileSync(path, 'keep foreign archive', { mode: 0o600 });
  await expect(archiveNativeExecutionArtifact(f.product, f.source, path)).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe('keep foreign archive'); expect(statSync(path).mode & 0o777).toBe(0o600);
  unlinkSync(path);
  const published = await archiveNativeExecutionArtifact(f.product, f.source, path);
  published.assertCurrent(); expect(statSync(path).mode & 0o777).toBe(0o644);
  const names = execFileSync('tar', ['-tzf', path], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n');
  expect(names).toEqual([...f.members.map((member: { path: string }) => member.path), 'native-execution-artifact.json']
    .map(name => `products/daemon/native/${name}`));
  renameSync(path, path + '.original'); writeFileSync(path, 'later foreign archive');
  expect(() => published.removeOwned()).toThrow(); expect(readFileSync(path, 'utf8')).toBe('later foreign archive');
});

test('native archive keeps its original descriptor when the final parent is replaced while tar drains', async () => {
  const f = nativeCohort(), path = join(f.output, 'daemon-native-linux-x64.tgz');
  const producing = archiveNativeExecutionArtifact(f.product, f.source, path);
  // The real async producer has spawned and holds its original file descriptor;
  // replacing the pathname cannot redirect its writes or final publication.
  renameSync(f.output, f.output + '.original'); mkdirSync(f.output); writeFileSync(join(f.output, 'foreign'), 'preserved');
  await expect(producing).rejects.toThrow();
  expect(readdirSync(f.output)).toEqual(['foreign']); expect(readFileSync(join(f.output, 'foreign'), 'utf8')).toBe('preserved');
  expect(existsSync(f.output + '.original')).toBe(true);
});

test('archive cancellation after child close but during final drainage still rejects', async () => {
  const root = scratch(), input = join(root, 'input'); mkdirSync(input); writeFileSync(join(input, 'member'), 'original input');
  const cancellation = new AbortController(), remove = cancellation.signal.removeEventListener.bind(cancellation.signal);
  let cancelledDuringDrain = false;
  const removing = spyOn(cancellation.signal, 'removeEventListener').mockImplementation((...args: Parameters<typeof remove>) => {
    remove(...args);
    if (args[0] === 'abort') queueMicrotask(() => { cancelledDuringDrain = true; cancellation.abort(new Error('Final archive drain cancelled')); });
  });
  const fd = openSync(join(root, 'original.tar.gz'), 'wx', 0o644);
  try {
    await expect(runNativeArchive(['member'], input, fd, cancellation.signal)).rejects.toThrow('Final archive drain cancelled');
    expect(cancelledDuringDrain).toBe(true);
  } finally { removing.mockRestore(); closeSync(fd); }
});

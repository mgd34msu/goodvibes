/** Real filesystem/tar output custody; inert cohorts do not certify native execution. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { archiveNativeExecutionArtifact, nativeExecutionPayloadMembers, recordNativeExecutionArtifact } from '../../../products/daemon/scripts/native-execution-artifact.mjs';
import { runNativeArchive } from '../../../products/daemon/scripts/native-execution-process.mjs';
import { cleanupNativeReleaseStages, createNativeReleaseInput, createNativeReleaseOutput } from '../../../.github/scripts/stage-native-release-assets.mjs';
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

test('final output permission publication cannot chmod a replacement directory', () => {
  const root = scratch(), destination = join(root, 'assets'), changeMode = fs.fchmodSync;
  let replaced = false;
  const mode = spyOn(fs, 'fchmodSync').mockImplementation((fd, bits) => {
    if (bits === 0o755 && fs.fstatSync(fd).isDirectory() && !replaced) {
      replaced = true; renameSync(destination, destination + '.original');
      mkdirSync(destination, { mode: 0o700 }); chmodSync(destination, 0o700);
    }
    changeMode(fd, bits);
  });
  try {
    expect(() => createNativeReleaseOutput(destination)).toThrow('changed during creation');
    expect(replaced).toBe(true); expect(statSync(destination).mode & 0o777).toBe(0o700);
    expect(statSync(destination + '.original').mode & 0o777).toBe(0o755);
  } finally { mode.mockRestore(); }
});

test('private descriptor-based directory publication preserves restrictive umask and restores it after native creation fails', () => {
  const root = scratch(), previous = process.umask(0o777);
  try {
    const output = createNativeReleaseOutput(join(root, 'assets'));
    try {
      output.put('program', Buffer.from('exact release bytes'), 0o644);
      expect(process.umask()).toBe(0o777);
      expect(statSync(output.directory).mode & 0o777).toBe(0o755);
      expect(statSync(join(output.directory, 'program')).mode & 0o777).toBe(0o644);
    } finally { const failure = cleanupNativeReleaseStages([output], undefined); if (failure) throw failure; }
    const createStage = spyOn(fs, 'mkdtempSync').mockImplementation(() => { throw new Error('Synthetic private create failure'); });
    try {
      expect(() => createReleaseStage(root, '.failed-stage-')).toThrow('Synthetic private create failure');
      expect(process.umask()).toBe(0o777);
    } finally { createStage.mockRestore(); }
    const mkdir = fs.mkdirSync;
    const createOutput = spyOn(fs, 'mkdirSync').mockImplementation(((...args: Parameters<typeof mkdir>) => {
      if (String(args[0]).endsWith('/failed-assets')) throw new Error('Synthetic output create failure');
      return mkdir(...args);
    }) as typeof mkdir);
    try {
      expect(() => createNativeReleaseOutput(join(root, 'failed-assets'))).toThrow('Synthetic output create failure');
      expect(process.umask()).toBe(0o777);
    } finally { createOutput.mockRestore(); }
  } finally { process.umask(previous); }
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

test('actual release output accepts only its own duplicate assets and preserves partial publication on failure', () => {
  const root = scratch(), output = createNativeReleaseOutput(join(root, 'assets'));
  try {
    const original = output.put('shared.so', Buffer.from('owned bytes'), 0o644);
    expect(output.put('shared.so', Buffer.from('owned bytes'), 0o644)).toBe(original);
    expect(() => output.put('shared.so', Buffer.from('different'), 0o644)).toThrow('bytes differ');
    writeFileSync(join(output.directory, 'foreign.json'), 'foreign', { mode: 0o600 });
    expect(() => output.put('foreign.json', Buffer.from('foreign'), 0o644)).toThrow();
    expect(readFileSync(join(output.directory, 'foreign.json'), 'utf8')).toBe('foreign');
    expect(cleanupNativeReleaseStages([output], undefined)).toBeUndefined();
    expect(readFileSync(original.path, 'utf8')).toBe('owned bytes');
  } finally { cleanupNativeReleaseStages([output], undefined); }
});

test('actual stage archive refuses a replaced output tree across its real tar await and cleanup preserves it', async () => {
  const root = scratch(), output = createNativeReleaseOutput(join(root, 'assets'));
  const input = join(root, 'input'); mkdirSync(input); writeFileSync(join(input, 'member'), 'original member');
  const archive = output.archive('addon.tar.gz', ['member'], input);
  renameSync(output.directory, output.directory + '.original'); mkdirSync(output.directory);
  writeFileSync(join(output.directory, 'foreign'), 'keep replacement');
  let failure: unknown;
  try { await archive; } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  const result = cleanupNativeReleaseStages([output], failure);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors[0]).toBe(failure);
  expect(readdirSync(output.directory)).toEqual(['foreign']);
  expect(readFileSync(join(output.directory, 'foreign'), 'utf8')).toBe('keep replacement');
});

test('actual source retirement during tar refuses before final archive publication', async () => {
  const root = scratch(), input = join(root, 'input'); mkdirSync(input); writeFileSync(join(input, 'member'), 'original input');
  let current = true, checked = 0;
  const output = createNativeReleaseOutput(join(root, 'assets'), () => { checked++; if (!current) throw new Error('Original source retired'); });
  const producing = output.archive('addon.tar.gz', ['member'], input);
  current = false;
  try {
    await expect(producing).rejects.toThrow('source is unavailable');
    expect(checked).toBe(1); expect(existsSync(join(output.directory, 'addon.tar.gz'))).toBe(false);
  } finally { const failure = cleanupNativeReleaseStages([output], undefined); if (failure) throw failure; }
});

for (const kind of ['async-return', 'nonvoid-return', 'thrown-promise'] as const) test(`final archive source restriction rejects and drains ${kind}`, async () => {
  const root = scratch(), input = join(root, 'input'); mkdirSync(input); writeFileSync(join(input, 'member'), 'original input');
  const unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  const output = createNativeReleaseOutput(join(root, 'assets'), () => {
    if (kind === 'thrown-promise') throw Promise.reject(new Error('Synthetic rejected guard work'));
    if (kind === 'async-return') return Promise.reject(new Error('Synthetic returned guard work'));
    return false;
  });
  try {
    await expect(output.archive('addon.tar.gz', ['member'], input)).rejects.toThrow('source is unavailable');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]); expect(existsSync(join(output.directory, 'addon.tar.gz'))).toBe(false);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    const failure = cleanupNativeReleaseStages([output], undefined); if (failure) throw failure;
  }
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

test('release output refuses a changed configured parent alias while preserving both original and foreign final files', () => {
  const root = scratch(), first = join(root, 'first'), other = join(root, 'other'), alias = join(root, 'alias');
  mkdirSync(first); mkdirSync(other); symlinkSync(first, alias);
  const output = createNativeReleaseOutput(join(alias, 'assets'));
  output.put('before', Buffer.from('original partial output'), 0o644);
  unlinkSync(alias); symlinkSync(other, alias); mkdirSync(join(other, 'assets'));
  writeFileSync(join(other, 'assets/foreign'), 'preserve foreign');
  expect(() => output.put('after', Buffer.from('must not publish'), 0o644)).toThrow();
  cleanupNativeReleaseStages([output], undefined);
  expect(readFileSync(join(first, 'assets/before'), 'utf8')).toBe('original partial output');
  expect(readdirSync(join(other, 'assets'))).toEqual(['foreign']);
});

test('release output preserves configured parent aliases and symlink-aware dot-dot lookup', () => {
  const root = scratch(), actual = join(root, 'actual'), nested = join(actual, 'nested'), alias = join(root, 'alias');
  mkdirSync(nested, { recursive: true }); symlinkSync(nested, alias);
  const output = createNativeReleaseOutput(`${alias}/../assets`);
  try {
    output.put('original', Buffer.from('owned canonical output'), 0o644);
    expect(output.directory).toBe(join(actual, 'assets'));
    expect(existsSync(join(root, 'assets'))).toBe(false);
    expect(readFileSync(join(actual, 'assets/original'), 'utf8')).toBe('owned canonical output');
  } finally { const failure = cleanupNativeReleaseStages([output], undefined); if (failure) throw failure; }
});

test('the real temporary-input stage never recursively cleans a replacement and retains the primary error', async () => {
  const input = createNativeReleaseInput(); roots.push(input.path + '.original'); roots.push(input.path);
  writeFileSync(join(input.path, 'original'), 'retained original input');
  renameSync(input.path, input.path + '.original'); mkdirSync(input.path); writeFileSync(join(input.path, 'foreign'), 'keep replacement input');
  await Promise.resolve();
  const primary = new Error('original staging failure'), result = cleanupNativeReleaseStages([input], primary);
  expect(result).toBeInstanceOf(AggregateError); expect((result as AggregateError).errors[0]).toBe(primary);
  expect(readFileSync(join(input.path, 'foreign'), 'utf8')).toBe('keep replacement input');
  expect(readFileSync(join(input.path + '.original', 'original'), 'utf8')).toBe('retained original input');
});

test('cancelled archive publication drains a SIGTERM-resistant owned producer before closing its output', async () => {
  const root = scratch(), bin = join(root, 'bin'), input = join(root, 'input'), marker = join(root, 'producer.pid');
  mkdirSync(bin); mkdirSync(input); writeFileSync(join(input, 'member'), 'original member');
  // A real process fixture using the normal executable lookup, never a mocked
  // close event. Its builtin busy loop spawns no unowned helper processes.
  writeFileSync(join(bin, 'tar'), '#!/bin/sh\ntrap "" TERM\nprintf "%s" "$$" > "$NATIVE_ARCHIVE_TEST_MARKER"\nprintf "partial"\nwhile :; do :; done\n', { mode: 0o755 });
  const previousPath = process.env.PATH, previousMarker = process.env.NATIVE_ARCHIVE_TEST_MARKER;
  const output = createNativeReleaseOutput(join(root, 'assets')), cancellation = new AbortController();
  let publishing: Promise<unknown> | undefined;
  try {
    process.env.PATH = bin; process.env.NATIVE_ARCHIVE_TEST_MARKER = marker;
    publishing = output.archive('cancelled.tar.gz', ['member'], input, cancellation.signal);
    void publishing.catch(() => {});
    const deadline = Date.now() + 5_000;
    let pid = 0;
    for (;;) {
      if (existsSync(marker)) pid = Number(readFileSync(marker, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) break;
      if (Date.now() > deadline) throw new Error('Owned archive producer did not start');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    cancellation.abort(new Error('Owned archive cancelled'));
    await expect(publishing).rejects.toThrow();
    let code: unknown;
    try { process.kill(pid, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
    expect(code).toBe('ESRCH'); expect(existsSync(join(output.directory, 'cancelled.tar.gz'))).toBe(false);
  } finally {
    cancellation.abort(); await publishing?.catch(() => {});
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.NATIVE_ARCHIVE_TEST_MARKER; else process.env.NATIVE_ARCHIVE_TEST_MARKER = previousMarker;
    const failure = cleanupNativeReleaseStages([output], undefined); if (failure) throw failure;
  }
}, 15_000);

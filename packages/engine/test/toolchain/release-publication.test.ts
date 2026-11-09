import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createReleaseStage } from '@goodvibes-jev/engine/toolchain/release-publication';
import { makeProjectTempDir } from '../_helpers/project-temp.ts';
const scratch = () => makeProjectTempDir('pack-bundle-release-publication-');

test('companion/archive publishers use independent original stages and refuse existing names', () => {
  const out = scratch();
  for (const directory of ['.addon', '.browser']) { mkdirSync(join(out, directory)); writeFileSync(join(out, directory, 'foreign'), directory); }
  const addon = createReleaseStage(out, '.suite-staging-'), browser = createReleaseStage(out, '.suite-staging-');
  expect(addon.path).not.toBe(browser.path);
  const first = addon.publishBytes('sqlite-vec-linux-x64.tar.gz', Buffer.from('original addon'));
  expect(() => browser.publishBytes('sqlite-vec-linux-x64.tar.gz', Buffer.from('other addon'))).toThrow();
  const second = browser.publishBytes('browser-driver.tar.gz', Buffer.from('original browser'));
  addon.cleanup(); browser.cleanup(); first.assertCurrent(); second.assertCurrent();
  expect(readFileSync(first.path, 'utf8')).toBe('original addon');
  for (const directory of ['.addon', '.browser']) expect(readFileSync(join(out, directory, 'foreign'), 'utf8')).toBe(directory);
});

test('metadata/binary publication never overwrites aliases and compensation refuses later edits or replacements', () => {
  const out = scratch(), stage = createReleaseStage(out, '.suite-staging-');
  const foreign = join(out, 'foreign'); writeFileSync(foreign, 'keep'); symlinkSync(foreign, join(out, 'reader.json'));
  expect(() => stage.publishBytes('reader.json', Buffer.from('new metadata'))).toThrow();
  const original = stage.publishBytes('program', Buffer.from('original binary'));
  writeFileSync(original.path, 'edited binary');
  expect(() => original.removeOwned()).toThrow(); expect(readFileSync(original.path, 'utf8')).toBe('edited binary');
  const manifest = stage.publishBytes('suite-release-source-linux-x64.json', Buffer.from('original inventory'));
  writeFileSync(manifest.path + '.foreign', 'later inventory'); renameSync(manifest.path + '.foreign', manifest.path);
  expect(() => manifest.removeOwned()).toThrow(); expect(readFileSync(manifest.path, 'utf8')).toBe('later inventory');
  stage.cleanup(); expect(readFileSync(foreign, 'utf8')).toBe('keep');
});

test('cleanup never adopts a replacement staging directory or a changed output parent alias', () => {
  const out = scratch(), stage = createReleaseStage(out, '.suite-staging-');
  renameSync(stage.path, stage.path + '.original'); mkdirSync(stage.path); writeFileSync(join(stage.path, 'foreign'), 'preserved');
  expect(() => stage.cleanup()).toThrow(); expect(readFileSync(join(stage.path, 'foreign'), 'utf8')).toBe('preserved');
  const root = scratch(), actual = join(root, 'actual'), alias = join(root, 'alias'); mkdirSync(actual); symlinkSync(actual, alias);
  const publisher = createReleaseStage(alias, '.suite-staging-');
  const original = publisher.publishBytes('program', Buffer.from('original'));
  renameSync(alias, alias + '.old'); mkdirSync(alias); writeFileSync(join(alias, 'program'), 'foreign');
  expect(() => original.removeOwned()).toThrow(); expect(readFileSync(join(alias, 'program'), 'utf8')).toBe('foreign');
  publisher.cleanup(); expect(readFileSync(join(actual, 'program'), 'utf8')).toBe('original');
});

test('fresh private stages can publish and drain under a restrictive process umask', () => {
  const out = scratch(), previous = process.umask(0o777);
  try {
    const stage = createReleaseStage(join(out, 'nested', 'release'), '.suite-staging-');
    const file = stage.publishBytes('program', Buffer.from('actual bytes'));
    stage.cleanup(); file.assertCurrent(); file.removeOwned();
    expect(readdirSync(join(out, 'nested', 'release'))).toEqual([]);
  } finally { process.umask(previous); }
});


test('publication never adopts a foreign destination introduced during the original link handoff', () => {
  const out = scratch(), stage = createReleaseStage(out, '.suite-staging-');
  const source = join(stage.path, 'archive.tar.gz'), destination = join(out, 'archive.tar.gz');
  writeFileSync(source, 'original archive');
  const unlink = fs.unlinkSync;
  const changed = spyOn(fs, 'unlinkSync').mockImplementation((path) => {
    unlink(path);
    if (path === source) {
      renameSync(destination, destination + '.original'); writeFileSync(destination, 'later foreign archive');
    }
  });
  try {
    expect(() => stage.publish('archive.tar.gz', 'archive.tar.gz')).toThrow('changed during publication');
    expect(readFileSync(destination, 'utf8')).toBe('later foreign archive');
    expect(readFileSync(destination + '.original', 'utf8')).toBe('original archive');
  } finally { changed.mockRestore(); stage.cleanup(); }
});


test('the actual suite coordinator reader-emission closure publishes metadata with its own mode and exact pin', () => {
  // Execute the actual small publisher closure, rather than a reimplementation
  // or a full native product build. Any accidental capture from another local
  // (for example put()'s path) fails here before metadata can be certified.
  const script = resolve(import.meta.dir, '../../../../.github/scripts/package-suite-release.mjs');
  const source = ts.createSourceFile(script, readFileSync(script, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'emitReader'
      && node.initializer && ts.isArrowFunction(node.initializer)) declarations.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source); expect(declarations).toHaveLength(1);
  const out = scratch(), stage = createReleaseStage(out, '.suite-staging-');
  const files: Record<string, { sha256: string; size: number }> = {};
  const published: ReturnType<typeof stage.publishBytes>[] = [];
  const publishBytes = (name: string, bytes: Uint8Array, mode: number): void => {
    published.push(stage.publishBytes(name, bytes, mode));
  };
  const emit = new Function('publishBytes', 'files', 'createHash', 'Buffer',
    `'use strict'; return (${declarations[0]!.getText(source)});`)(publishBytes, files, createHash, Buffer) as
      (name: string, artifact: unknown) => void;
  const name = 'goodvibes-linux-x64.reader-ci-artifact.json';
  const artifact = { schema: 1, packageName: '@goodvibes-jev/tui', version: '3.1.2', files: [] };
  const previous = process.umask(0o777);
  try {
    emit(name, artifact);
    expect(JSON.parse(readFileSync(join(out, name), 'utf8'))).toEqual(artifact);
    expect(readFileSync(join(out, name), 'utf8').endsWith('\n')).toBe(true);
    expect(statSync(join(out, name)).mode & 0o777).toBe(0o644);
    // Independently fixed protocol bytes; no second runtime checksum producer.
    expect(files[name]).toEqual({ sha256: '8088aa6782157003b115d9e8e24b4bdec99efb1e6f49a29a2a108d76ad4c2624', size: 94 });
    expect(published).toHaveLength(1); published[0]!.assertCurrent();
  } finally { process.umask(previous); stage.cleanup(); }
});

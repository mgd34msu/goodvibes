import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { writeFileAtomic } from '../sdk/src/platform/utils/atomic-json-store.js';
import { logger } from '../sdk/src/platform/utils/logger.js';
import { join } from 'node:path';
import { writeWorkstreamSnapshot, loadWorkstreamSnapshot, listSnapshotWorkstreamIds, reapOrchestrationSnapshots } from '../sdk/src/platform/orchestration/persistence.js';
import type { Workstream } from '../sdk/src/platform/orchestration/types.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const make = (id = 'ws-original'): Workstream => ({ id, title: 'Original', schemaVersion: 1, phases: [], items: [], createdAt: 0 });
function fixture() {
  const root = makeProjectTempDir('snapshot-original'); roots.push(root);
  const dir = join(root, '.goodvibes', 'orchestration'); mkdirSync(dir, { recursive: true });
  return { root, dir, path: join(dir, 'ws-original.json') };
}

// UNRUN source regressions: public APIs, original files and actual publication.
test('future envelopes remain at the original path through load/list and both cached-owner and copied-owner writes', () => {
  const f = fixture(), workstream = make(); writeWorkstreamSnapshot(f.root, workstream, []);
  const future = JSON.stringify({ schemaVersion: 99, workstream: { privateFutureState: 'preserve original bytes' }, completedResults: [] });
  writeFileSync(f.path, future);
  expect(loadWorkstreamSnapshot(f.root, workstream.id)).toBeNull();
  expect(listSnapshotWorkstreamIds(f.root)).toContain(workstream.id);
  writeWorkstreamSnapshot(f.root, workstream, []);
  writeWorkstreamSnapshot(f.root, { ...workstream }, []);
  expect(readFileSync(f.path, 'utf8')).toBe(future);
  expect(readdirSync(f.dir)).toEqual(['ws-original.json']);
});

test('an older reader never ages out a future envelope already quarantined by historical code', () => {
  const f = fixture(), path = `${f.path}.unrecognized`, now = Date.now();
  const future = JSON.stringify({ schemaVersion: 99, privateFutureState: 'preserve' });
  writeFileSync(path, future); utimesSync(path, new Date(now - 60 * 86400_000), new Date(now - 60 * 86400_000));
  reapOrchestrationSnapshots(f.root, { now });
  expect(readFileSync(path, 'utf8')).toBe(future);
});

test('snapshot IDs cannot write or quarantine a file outside the selected snapshot directory', () => {
  const f = fixture(), outside = join(f.root, '.goodvibes', 'target.json'), original = 'preserve outside file';
  writeFileSync(outside, original);
  writeWorkstreamSnapshot(f.root, make('../target'), []);
  expect(loadWorkstreamSnapshot(f.root, '../target')).toBeNull();
  expect(readFileSync(outside, 'utf8')).toBe(original);
  expect(readdirSync(f.dir)).toEqual([]);
});

test('each corrupt snapshot retains its own original forensic bytes instead of replacing an older quarantine', () => {
  const f = fixture();
  writeFileSync(f.path, '{ first original'); expect(loadWorkstreamSnapshot(f.root, 'ws-original')).toBeNull();
  writeFileSync(f.path, '{ second original'); expect(loadWorkstreamSnapshot(f.root, 'ws-original')).toBeNull();
  const originals = readdirSync(f.dir).filter(name => name.endsWith('.unrecognized')).map(name => readFileSync(join(f.dir, name), 'utf8')).sort();
  expect(originals).toEqual(['{ first original', '{ second original']);
});

test('only exact native temporary formats with proven-dead owners are reclaimed', () => {
  const f = fixture(), now = Date.now(), staleAt = new Date(now - 7200_000), oldStamp = now - 7200_000;
  const names = {
    dead: `ws-original.json.999999.${oldStamp}.tmp`,
    live: `ws-original.json.${process.pid}.${oldStamp}.tmp`,
    future: `ws-original.json.999999.${now + 86400_000}.tmp`,
    malformed: 'ws-original.json.0.1.tmp',
    unknown: 'some-foreign.tmp',
    inaccessible: `ws-original.json.999998.${oldStamp}.tmp`,
    modern: 'ws-original.json.tmp-999999-1-1234abcd',
  };
  for (const name of Object.values(names)) { writeFileSync(join(f.dir, name), 'original staged bytes'); utimesSync(join(f.dir, name), staleAt, staleAt); }
  const linked = join(f.dir, `ws-original.json.999999.${oldStamp - 1}.tmp`);
  linkSync(join(f.dir, names.live), linked);
  const alias = join(f.dir, `ws-original.json.999999.${oldStamp - 2}.tmp`);
  symlinkSync(join(f.dir, names.live), alias);
  const originalKill = process.kill;
  const kill = spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 999999) throw Object.assign(new Error('fixture dead'), { code: 'ESRCH' });
    if (pid === 999998) throw Object.assign(new Error('fixture inaccessible'), { code: 'EPERM' });
    return originalKill(pid, signal);
  });
  try {
    const summary = reapOrchestrationSnapshots(f.root, { now });
    expect(summary.staleTempRemoved).toBe(2);
    expect(existsSync(join(f.dir, names.dead))).toBe(false);
    expect(existsSync(join(f.dir, names.modern))).toBe(false);
    for (const key of ['live', 'future', 'malformed', 'unknown', 'inaccessible'] as const) expect(existsSync(join(f.dir, names[key]))).toBe(true);
    expect(existsSync(linked)).toBe(true); expect(existsSync(alias)).toBe(true);
  } finally { kill.mockRestore(); }
});


/** Directory enumeration order is unspecified. Select real fixture entries in
 * this permitted order so the real isRunning callback runs after admission. */
function quarantinesFirst(directory: string) {
  const native = fs.readdirSync;
  return spyOn(fs, 'readdirSync').mockImplementation(((...args: unknown[]) => {
    const entries: unknown = Reflect.apply(native, fs, args);
    if (args[0] !== directory || !Array.isArray(entries) || !entries.every(entry => typeof entry === 'string')) return entries;
    return [...entries as string[]].sort((a, b) => Number(!a.endsWith('.unrecognized')) - Number(!b.endsWith('.unrecognized')) || a.localeCompare(b));
  }) as typeof fs.readdirSync);
}
function oldQuarantine(f: ReturnType<typeof fixture>) {
  const path = join(f.dir, 'admitted-original.json.unrecognized');
  writeFileSync(path, '{ original admitted forensic bytes');
  const old = new Date(Date.now() - 60 * 86400_000); utimesSync(path, old, old);
  writeWorkstreamSnapshot(f.root, make('trigger'), []);
  return { path, old };
}

test('a later real isRunning callback cannot replace an admitted quarantine with future data and have it deleted', () => {
  const f = fixture(), q = oldQuarantine(f), order = quarantinesFirst(f.dir);
  const future = JSON.stringify({ schemaVersion: 99, futureOriginal: 'preserve replacement' });
  let replaced = false;
  try {
    const summary = reapOrchestrationSnapshots(f.root, { isRunning(id) {
      if (id === 'trigger') { writeFileAtomic(q.path, future); utimesSync(q.path, q.old, q.old); replaced = true; }
      return false;
    } });
    expect(replaced).toBe(true);
    expect(readFileSync(q.path, 'utf8')).toBe(future);
    expect(summary.quarantineExpired).toBe(0); expect(summary.total).toBe(0); expect(summary.bytesReclaimed).toBe(0);
  } finally { order.mockRestore(); }
});

test('retiring an original parent alias cannot reclaim even the same original leaf through its replacement', () => {
  const f = fixture(), q = oldQuarantine(f), physical = join(f.root, 'physical-snapshots');
  fs.renameSync(f.dir, physical); symlinkSync(physical, f.dir, 'dir');
  const order = quarantinesFirst(f.dir);
  try {
    const summary = reapOrchestrationSnapshots(f.root, { isRunning(id) {
      if (id === 'trigger') { fs.unlinkSync(f.dir); symlinkSync(physical, f.dir, 'dir'); }
      return false;
    } });
    expect(readFileSync(q.path, 'utf8')).toBe('{ original admitted forensic bytes');
    expect(summary.total).toBe(0); expect(summary.bytesReclaimed).toBe(0);
  } finally { order.mockRestore(); }
});

test('an unchanged original parent alias remains supported for owned quarantine cleanup', () => {
  const f = fixture(), q = oldQuarantine(f), physical = join(f.root, 'original-snapshots');
  fs.renameSync(f.dir, physical); symlinkSync(physical, f.dir, 'dir');
  const summary = reapOrchestrationSnapshots(f.root);
  expect(existsSync(q.path)).toBe(false);
  expect(summary.quarantineExpired).toBe(1);
  expect(fs.lstatSync(f.dir).isSymbolicLink()).toBe(true);
});

test('a failed selected-original unlink is not counted as reclaimed bytes or a removed file', () => {
  const f = fixture(), q = oldQuarantine(f), original = fs.unlinkSync;
  const unlink = spyOn(fs, 'unlinkSync').mockImplementation(path => {
    if (path === q.path) throw Object.assign(new Error('fixture unavailable'), { code: 'EBUSY' });
    return original(path);
  });
  try {
    const summary = reapOrchestrationSnapshots(f.root);
    expect(existsSync(q.path)).toBe(true);
    expect(summary.quarantineExpired).toBe(0); expect(summary.total).toBe(0); expect(summary.bytesReclaimed).toBe(0);
  } finally { unlink.mockRestore(); }
});

test('corruption parsing cannot quarantine through a retired original parent alias', () => {
  const f = fixture(), physical = join(f.root, 'physical-corrupt-snapshots');
  writeFileSync(f.path, '{ original corrupt bytes'); fs.renameSync(f.dir, physical); symlinkSync(physical, f.dir, 'dir');
  let changed = false;
  const error = spyOn(logger, 'error').mockImplementation(message => {
    if (!changed && message === 'orchestration persistence: invalid snapshot JSON') {
      fs.unlinkSync(f.dir); symlinkSync(physical, f.dir, 'dir'); changed = true;
    }
  });
  try {
    expect(loadWorkstreamSnapshot(f.root, 'ws-original')).toBeNull();
    expect(changed).toBe(true);
    expect(readFileSync(f.path, 'utf8')).toBe('{ original corrupt bytes');
    expect(readdirSync(physical)).toEqual(['ws-original.json']);
  } finally { error.mockRestore(); }
});


test('malformed current-version item entries are preserved without crashing periodic reaping', () => {
  const f = fixture(), original = JSON.stringify({ schemaVersion: 1, writtenAt: 0, workstream: { ...make(), items: [null, 'passed'] }, completedResults: [] });
  writeFileSync(f.path, original);
  expect(() => reapOrchestrationSnapshots(f.root)).not.toThrow();
  expect(readFileSync(f.path, 'utf8')).toBe(original);
});

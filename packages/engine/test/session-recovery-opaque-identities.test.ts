import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { createSessionSurface } from '../sdk/src/platform/runtime/session-surface.js';
import { autoRestoreRecovery, checkRecoveryForSession, consumeRecovery, deleteRecoveryFile, getRecoveryFilePath,
  loadRecoveryConversation, removeRecoveryPoint, writeRecoveryFile } from '../sdk/src/platform/runtime/session-persistence.js';
import { writeFileAtomic } from '../sdk/src/platform/utils/atomic-json-store.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities, NativeDataCompatibilityError, NATIVE_READER_REQUIREMENT_FILE } from '../sdk/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../sdk/src/platform/runtime/self-update.js';
import { createSessionStorageServices } from '../sdk/src/platform/runtime/session-storage-services.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = makeProjectTempDir('recovery-opaque'); roots.push(root);
  const identity = { surfaceRoot: 'tui', workingDirectory: root, homeDirectory: root };
  return { root, identity, surface: createSessionSurface(identity) };
}
const snapshot = (text: string) => ({ messages: [{ role: 'user', content: text }] });
const files = (directory: string) => fs.readdirSync(directory).filter(name => name.startsWith('recovery-') && name.endsWith('.jsonl'));
function age(path: string) { const at = new Date(Date.now() - 600_000); fs.utimesSync(path, at, at); }

// Source regressions only. Execution is deliberately deferred until coding completes.
test('arbitrary private IDs use opaque persisted names; safe paths and restart lookup retain their identities without SHA', () => {
  const f = fixture(), id = 'private/🔒/4111111111111111';
  const hash = spyOn(crypto, 'createHash'), bunHash = spyOn(Bun.CryptoHasher, 'hash');
  try {
    expect(f.surface.recoveryFile('a1b2c3d4')).toBe(join(f.surface.recoveryDir, 'recovery-a1b2c3d4.jsonl'));
    writeRecoveryFile(snapshot('first tail'), id, 'title', { surface: f.surface });
    const path = f.surface.recoveryFile(id);
    expect(basename(path)).toMatch(/^recovery-opaque-[a-p-]+\.jsonl$/);
    expect(path).not.toContain('private'); expect(path).not.toContain('4111111111111111');
    expect(JSON.parse(fs.readFileSync(path, 'utf8').split('\n')[0]!)).toMatchObject({ sessionId: id });
    const restarted = createSessionSurface(f.identity);
    expect(restarted.recoveryFile(id)).toBe(path);
    writeRecoveryFile(snapshot('second tail'), id, 'updated title', { surface: restarted });
    expect(loadRecoveryConversation({ surface: restarted }, id)?.messages[0]?.content).toBe('second tail');
    expect(files(f.surface.recoveryDir)).toEqual([basename(path)]);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(bunHash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hash.mockRestore(); bunHash.mockRestore(); }
});

test('actual original headers locate old hashed paths without recomputing their formatter, including long headers', () => {
  const f = fixture(), id = 'old/private/id', title = 'long-title-'.repeat(1000);
  const digest = crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
  fs.mkdirSync(f.surface.recoveryDir, { recursive: true });
  const path = join(f.surface.recoveryDir, `recovery-old_private_id-${digest}.jsonl`);
  fs.writeFileSync(path, `${JSON.stringify({ type: 'meta', sessionId: id, title, timestamp: 1 })}\n${JSON.stringify({ type: 'message', role: 'user', content: 'retained' })}\n`, { mode: 0o600 });
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(f.surface.recoveryFile(id)).toBe(path);
    expect(checkRecoveryForSession(f.surface, id)?.title).toBe(title);
    writeRecoveryFile(snapshot('new tail'), id, title, { surface: f.surface });
    expect(f.surface.recoveryFile(id)).toBe(path);
    expect(loadRecoveryConversation({ surface: f.surface }, id)?.messages[0]?.content).toBe('new tail');
    deleteRecoveryFile({ surface: f.surface }, id);
    expect(fs.existsSync(path)).toBe(false);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hash.mockRestore(); }
});

test('different declared owners converge on the actual first publication, not their unpublished suggestions', () => {
  const f = fixture(), other = createSessionSurface(f.identity), id = 'same/arbitrary/private-id';
  const firstSuggestion = f.surface.recoveryFile(id), secondSuggestion = other.recoveryFile(id);
  expect(firstSuggestion).not.toBe(secondSuggestion);
  writeRecoveryFile(snapshot('owner one'), id, '', { surface: f.surface });
  writeRecoveryFile(snapshot('owner two'), id, '', { surface: other });
  expect(other.recoveryFile(id)).toBe(f.surface.recoveryFile(id));
  expect(files(f.surface.recoveryDir)).toHaveLength(1);
  expect(loadRecoveryConversation({ surface: other }, id)?.messages[0]?.content).toBe('owner two');
});

test('an old running writer publishing its old name is reconciled instead of hidden by an opaque path cache', () => {
  const f = fixture(), id = 'same/private-id';
  writeRecoveryFile(snapshot('new writer tail'), id, '', { surface: f.surface });
  const opaque = f.surface.recoveryFile(id); age(opaque);
  const oldPath = join(f.surface.recoveryDir, 'recovery-same_private-id-previous.jsonl');
  fs.writeFileSync(oldPath, `${JSON.stringify({ type: 'meta', sessionId: id })}\n${JSON.stringify({ type: 'message', role: 'user', content: 'old writer latest tail' })}\n`);
  expect(f.surface.recoveryFile(id)).toBe(oldPath);
  expect(loadRecoveryConversation({ surface: f.surface }, id)?.messages[0]?.content).toBe('old writer latest tail');
});

test('restore never deletes a foreign replacement created by its receipt callback', () => {
  const f = fixture(), id = 'private/recovery';
  writeRecoveryFile(snapshot('original loaded tail'), id, '', { surface: f.surface });
  const path = f.surface.recoveryFile(id); age(path);
  const restored = autoRestoreRecovery({ surface: f.surface }, { record() {
    writeFileAtomic(path, `${JSON.stringify({ type: 'meta', sessionId: 'foreign-session' })}\n${JSON.stringify({ type: 'message', content: 'foreign preserved tail' })}\n`);
    return true;
  } });
  expect(restored?.snapshot.messages[0]?.content).toBe('original loaded tail');
  expect(fs.readFileSync(path, 'utf8')).toContain('foreign preserved tail');
  expect(JSON.stringify(restored)).not.toContain('physical');
});

test('keyed load, consume, check and delete refuse another session even when a borrowed resolver selects it', () => {
  const f = fixture();
  writeRecoveryFile(snapshot('other session tail'), 'other-session', '', { surface: f.surface });
  const path = f.surface.recoveryFile('other-session');
  const borrowed = { ...f.surface, recoveryFile: () => path };
  expect(loadRecoveryConversation({ surface: borrowed }, 'requested-session')).toBeNull();
  expect(checkRecoveryForSession(borrowed, 'requested-session')).toBeNull();
  expect(consumeRecovery(borrowed, 'requested-session')).toEqual({ snapshot: null, consumed: false });
  expect(removeRecoveryPoint(borrowed, 'requested-session')).toEqual({ removed: false });
  deleteRecoveryFile({ surface: borrowed }, 'requested-session');
  expect(fs.existsSync(path)).toBe(true);
});

test('a failed unlink reports unconsumed while preserving the loaded data and original file', () => {
  const f = fixture(), id = 'failed-cleanup';
  writeRecoveryFile(snapshot('still recovered'), id, '', { surface: f.surface });
  const path = f.surface.recoveryFile(id), unlink = spyOn(fs, 'unlinkSync');
  unlink.mockImplementation(() => { throw Object.assign(new Error('fixture busy'), { code: 'EBUSY' }); });
  try {
    const consumed = consumeRecovery(f.surface, id);
    expect(consumed.consumed).toBe(false);
    expect(consumed.snapshot?.messages[0]?.content).toBe('still recovered');
    expect(fs.existsSync(path)).toBe(true);
  } finally { unlink.mockRestore(); }
});

test('deprecated getter discovers the actual published opaque file without a sidecar registry', () => {
  const f = fixture(), id = 'deprecated/private/identifier';
  const options = { homeDirectory: f.root, workingDirectory: f.root, surfaceRoot: 'test' };
  const proposed = getRecoveryFilePath(f.root, id, 'test');
  expect(getRecoveryFilePath(f.root, id, 'test')).toBe(proposed);
  writeRecoveryFile(snapshot('retained compatibility data'), id, '', options);
  const actual = getRecoveryFilePath(f.root, id, 'test');
  expect(actual).toBe(proposed);
  expect(loadRecoveryConversation(options, id)?.messages[0]?.content).toBe('retained compatibility data');
});

test('actual concurrent processes publish one unsafe-ID snapshot through the common allocation lock', async () => {
  const f = fixture(), id = 'shared/private/process-identity';
  const helper = join(f.root, 'recovery-child.ts'), input = join(f.root, 'recovery-input.json'), go = join(f.root, 'go');
  const surfaceModule = new URL('../sdk/src/platform/runtime/session-surface.ts', import.meta.url).href;
  const persistenceModule = new URL('../sdk/src/platform/runtime/session-persistence.ts', import.meta.url).href;
  fs.writeFileSync(input, JSON.stringify({ identity: f.identity, id }), { mode: 0o600 });
  fs.writeFileSync(helper, `
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSessionSurface } from ${JSON.stringify(surfaceModule)};
import { writeRecoveryFile } from ${JSON.stringify(persistenceModule)};
const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const name = process.argv[3]!, surface = createSessionSurface(input.identity), root = input.identity.workingDirectory;
surface.recoveryFile(input.id);
writeFileSync(join(root, 'ready-' + name), 'ready');
const deadline = Date.now() + 15000;
while (!existsSync(join(root, 'go'))) { if (Date.now() > deadline) throw new Error('fixture barrier timeout'); await new Promise(r => setTimeout(r, 5)); }
writeRecoveryFile({ messages: [{ role: 'user', content: name }] }, input.id, '', { surface });
while (!existsSync(surface.recoveryDir) || !readdirSync(surface.recoveryDir).some(n => n.startsWith('recovery-') && n.endsWith('.jsonl'))) {
  if (Date.now() > deadline) throw new Error('fixture publication timeout'); await new Promise(r => setTimeout(r, 5));
}
process.stdout.write(JSON.stringify({ path: surface.recoveryFile(input.id) }));
`);
  const children = ['A', 'B'].map(name => Bun.spawn([process.execPath, '--no-env-file', helper, input, name], { stdout: 'pipe', stderr: 'pipe' }));
  try {
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(join(f.root, 'ready-A')) || !fs.existsSync(join(f.root, 'ready-B'))) {
      if (Date.now() > deadline) throw new Error('fixture readiness timeout');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    fs.writeFileSync(go, 'go');
    const results = await Promise.all(children.map(async child => {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0); expect(stderr).not.toContain(id);
      return JSON.parse(stdout) as { path: string };
    }));
    expect(results[0]?.path).toBe(results[1]?.path);
    expect(files(f.surface.recoveryDir)).toHaveLength(1);
    expect(['A', 'B']).toContain(loadRecoveryConversation({ surface: f.surface }, id)?.messages[0]?.content);
    expect(fs.readdirSync(f.surface.recoveryDir).some(name => name.includes('.tmp'))).toBe(false);
  } finally { for (const child of children) child.kill(); }
}, 30_000);

test('first unsafe-ID publication retains private modes under a restrictive umask', () => {
  const f = fixture(), id = 'first/private/identifier', previous = process.umask(0o777);
  try { writeRecoveryFile(snapshot('protected original'), id, '', { surface: f.surface }); }
  finally { process.umask(previous); }
  const path = f.surface.recoveryFile(id);
  expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  expect(fs.statSync(f.surface.recoveryDir).mode & 0o700).toBe(0o700);
  expect(loadRecoveryConversation({ surface: f.surface }, id)?.messages[0]?.content).toBe('protected original');
});


test('actual storage composition publishes the reader requirement before opaque data and refuses old same-version capabilities', () => {
  const f = fixture(), execPath = join(f.root, 'goodvibes-tui');
  const publisher = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  let declarations = 0;
  const nativeDataWriter = { declare(format: Parameters<typeof publisher.declare>[0]) {
    expect(fs.existsSync(f.surface.recoveryDir) ? files(f.surface.recoveryDir) : []).toHaveLength(0);
    publisher.declare(format); declarations += 1;
    expect(JSON.parse(fs.readFileSync(join(f.root, NATIVE_READER_REQUIREMENT_FILE), 'utf8')).formats).toContain('session-recovery-opaque-paths-v1');
    expect(() => assertNativeReaderCompatible(execPath, '3.1.1', realUpdateFileIo)).toThrow(NativeDataCompatibilityError);
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, { schema: 1, version: '3.1.2', formats: [] })).toThrow(NativeDataCompatibilityError);
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, nativeReaderCapabilities('3.1.2'))).not.toThrow();
  } };
  const { surface } = createSessionStorageServices({ ...f.identity, nativeDataWriter });
  writeRecoveryFile(snapshot('current reader data'), 'private/native-format', '', { surface });
  expect(declarations).toBe(1);
  expect(files(surface.recoveryDir)).toHaveLength(1);
});

test('retired installation ownership prevents first opaque publication, while unchanged safe paths require no new format', () => {
  const f = fixture();
  let declarations = 0;
  const surface = createSessionSurface({ ...f.identity, nativeDataWriter: { declare() { declarations += 1; throw new Error('fixture retired'); } } });
  writeRecoveryFile(snapshot('not published'), 'private/retired-owner', '', { surface });
  expect(declarations).toBe(1);
  expect(fs.existsSync(surface.recoveryDir) ? files(surface.recoveryDir) : []).toHaveLength(0);
  writeRecoveryFile(snapshot('compatible safe data'), 'a1b2c3d4', '', { surface });
  expect(declarations).toBe(1);
  expect(loadRecoveryConversation({ surface }, 'a1b2c3d4')?.messages[0]?.content).toBe('compatible safe data');
});


test('installation callbacks cannot publish through a retired parent or remove its foreign replacement lock', () => {
  const f = fixture(), retired = join(f.root, 'retired-recovery');
  const surface = createSessionSurface({ ...f.identity, nativeDataWriter: { declare() {
    fs.renameSync(f.surface.recoveryDir, retired);
    fs.mkdirSync(f.surface.recoveryDir);
    fs.writeFileSync(join(f.surface.recoveryDir, '.recovery-writer.lock'), 'foreign lock');
  } } });
  writeRecoveryFile(snapshot('withheld original data'), 'private/parent-incarnation', '', { surface });
  expect(fs.readFileSync(join(surface.recoveryDir, '.recovery-writer.lock'), 'utf8')).toBe('foreign lock');
  expect(files(surface.recoveryDir)).toHaveLength(0);
  expect(files(retired)).toHaveLength(0);
});


test('invalid UTF8 cannot alias a stored header to another session through replacement decoding', () => {
  const f = fixture(), id = 'private/\uFFFD';
  fs.mkdirSync(f.surface.recoveryDir, { recursive: true });
  const path = join(f.surface.recoveryDir, 'recovery-invalid-utf8.jsonl');
  const original = Buffer.concat([Buffer.from('{"type":"meta","sessionId":"private/'), Buffer.from([0xff]),
    Buffer.from('"}\n{"type":"message","content":"preserve malformed source"}\n')]);
  fs.writeFileSync(path, original);
  expect(f.surface.recoveryFile(id)).not.toBe(path);
  const borrowed = { ...f.surface, recoveryFile: () => path };
  expect(checkRecoveryForSession(borrowed, id)).toBeNull();
  expect(loadRecoveryConversation({ surface: borrowed }, id)).toBeNull();
  expect(consumeRecovery(borrowed, id)).toEqual({ snapshot: null, consumed: false });
  expect(fs.readFileSync(path)).toEqual(original);
});

test('a non-meta first line cannot be loaded or retired as a recovery header', () => {
  const f = fixture(), id = 'malformed-header';
  fs.mkdirSync(f.surface.recoveryDir, { recursive: true });
  const path = join(f.surface.recoveryDir, 'recovery-malformed.jsonl');
  const original = `${JSON.stringify({ type: 'message', sessionId: id })}\n${JSON.stringify({ type: 'message', content: 'preserve original' })}\n`;
  fs.writeFileSync(path, original);
  const borrowed = { ...f.surface, recoveryFile: () => path };
  expect(checkRecoveryForSession(borrowed, id)).toBeNull();
  expect(loadRecoveryConversation({ surface: borrowed }, id)).toBeNull();
  expect(consumeRecovery(borrowed, id)).toEqual({ snapshot: null, consumed: false });
  expect(removeRecoveryPoint(borrowed, id)).toEqual({ removed: false });
  deleteRecoveryFile({ surface: borrowed }, id);
  expect(fs.readFileSync(path, 'utf8')).toBe(original);
});

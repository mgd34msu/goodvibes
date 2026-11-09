/** Complete no-replace publication uses the original exclusive stage. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtomicWriteDurabilityError, writeFileAtomic } from '../platform/src/platform/utils/atomic-json-store.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
const restore: Array<() => void> = [];
afterEach(() => { for (const cleanup of restore.splice(0).reverse()) cleanup(); });

test.each(['file', 'symlink'] as const)('exclusive publication preserves a preexisting %s and removes only its own stage', kind => {
  const root = makeProjectTempDir('atomic-exclusive-existing'), file = join(root, 'state.json'), foreign = join(root, 'foreign');
  fs.writeFileSync(foreign, 'Foreign original', { mode: 0o644 });
  if (kind === 'file') fs.writeFileSync(file, 'Existing target', { mode: 0o640 }); else fs.symlinkSync(foreign, file);
  const original = fs.lstatSync(file, { bigint: true }); let acknowledged = false;
  expect(() => writeFileAtomic(file, 'Must not win', { replaceExisting: false, cleanupStaleTemps: false,
    onEffect(published) { if (published) acknowledged = true; } })).toThrow();
  expect(fs.lstatSync(file, { bigint: true }).ino).toBe(original.ino);
  expect(fs.readFileSync(file, 'utf8')).toBe(kind === 'file' ? 'Existing target' : 'Foreign original');
  expect(fs.statSync(foreign).mode & 0o777).toBe(0o644);
  expect(acknowledged).toBe(false);
  expect(fs.readdirSync(root).filter(name => name.startsWith('state.json.tmp-'))).toEqual([]);
});

test('a failed post-link stage transfer preserves uncertain evidence and never acknowledges publication', () => {
  const root = makeProjectTempDir('atomic-exclusive-transfer'), file = join(root, 'state.json');
  const unlink = fs.unlinkSync; let stage: string | undefined, acknowledged = false;
  const fail = spyOn(fs, 'unlinkSync').mockImplementation(path => {
    if (typeof path === 'string' && path.startsWith(`${file}.tmp-`)) { stage = path; throw new Error('Fixture unlink failed'); }
    return unlink(path);
  }); restore.push(() => fail.mockRestore());
  let caught: unknown;
  try { writeFileAtomic(file, 'Complete original', { replaceExisting: false, durable: true, cleanupStaleTemps: false,
    onEffect(published) { if (published) acknowledged = true; } }); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AtomicWriteDurabilityError);
  if (!(caught instanceof AtomicWriteDurabilityError)) throw caught;
  expect(caught.phase).toBe('published-indeterminate'); expect(acknowledged).toBe(false);
  expect(stage).toBeDefined(); expect(fs.readFileSync(stage!, 'utf8')).toBe('Complete original');
  expect(fs.readFileSync(file, 'utf8')).toBe('Complete original');
  expect(fs.statSync(stage!).ino).toBe(fs.statSync(file).ino); expect(fs.statSync(file).nlink).toBe(2);
});

test('exclusive observers and durable success require the same single-link final image', () => {
  const root = makeProjectTempDir('atomic-exclusive-observer'), file = join(root, 'state.json');
  let acknowledgements = 0;
  writeFileAtomic(file, 'Original image', { replaceExisting: false, durable: true,
    onEffect(published) { if (published) { acknowledgements++; expect(fs.statSync(file).nlink).toBe(1); } } });
  expect(acknowledgements).toBe(1); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const next = join(root, 'changed.json');
  expect(() => writeFileAtomic(next, 'Original second', { replaceExisting: false, durable: true,
    onEffect(published) { if (published) { fs.unlinkSync(next); fs.writeFileSync(next, 'Foreign replacement'); } } })).toThrow();
  expect(fs.readFileSync(next, 'utf8')).toBe('Foreign replacement');
});

test('two processes observing absence publish exactly one complete original image', async () => {
  const root = makeProjectTempDir('atomic-exclusive-processes'), file = join(root, 'state.json'), go = join(root, 'go');
  const module = fileURLToPath(new URL('../platform/src/platform/utils/atomic-json-store.ts', import.meta.url));
  const worker = join(root, 'worker.mts');
  fs.writeFileSync(worker, `import { existsSync, writeFileSync } from 'node:fs';
import { writeFileAtomic } from ${JSON.stringify(module)};
const [file, go, label, ready] = process.argv.slice(2);
if (existsSync(file)) throw new Error('Target was not absent');
writeFileSync(ready, 'ready', { flag: 'wx', mode: 0o600 });
while (!existsSync(go)) await new Promise(resolve => setTimeout(resolve, 2));
try { writeFileAtomic(file, label.repeat(10000), { replaceExisting: false, durable: true, cleanupStaleTemps: false });
  process.stdout.write(JSON.stringify({ ok: true, label }));
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.cause?.code ?? error.code })); }
`);
  const children = ['first', 'second'].map(label => Bun.spawn([process.execPath, '--no-env-file', worker, file, go, label, join(root, `${label}.ready`)], { stdout: 'pipe', stderr: 'pipe' }));
  const results = children.map(async child => {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!['first', 'second'].every(label => fs.existsSync(join(root, `${label}.ready`)))) {
      if (Date.now() > deadline) throw new Error('Publication workers did not reach their original absence barrier');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    fs.writeFileSync(go, 'go', { flag: 'wx', mode: 0o600 });
    const output = await Promise.all(results);
    for (const result of output) { expect(result.code).toBe(0); expect(result.stderr).toBe(''); }
    const outcomes: unknown[] = output.map(result => JSON.parse(result.stdout));
    const winner = outcomes.find((value): value is { ok: true; label: string } => value !== null && typeof value === 'object' && 'ok' in value && value.ok === true && 'label' in value && typeof value.label === 'string');
    expect(winner).toBeDefined(); expect(outcomes.filter(value => value !== null && typeof value === 'object' && 'ok' in value && value.ok === true)).toHaveLength(1);
    expect(outcomes).toContainEqual({ ok: false, code: 'EEXIST' });
    expect(fs.readFileSync(file, 'utf8')).toBe(winner!.label.repeat(10000));
    expect(fs.statSync(file).nlink).toBe(1); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root).filter(name => name.startsWith('state.json.tmp-'))).toEqual([]);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); await Promise.allSettled(results); }
});

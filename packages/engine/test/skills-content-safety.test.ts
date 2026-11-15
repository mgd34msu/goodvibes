/**
 * Skill files are line-based frontmatter: content that would be re-read as a
 * different value or another key is refused, a skill is listed under the name
 * it is opened by, and concurrent writes to one name are ordered and atomic.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSystemSkillStore,
  InMemorySkillStore,
  SkillService,
  SkillServiceError,
  parseSkill,
  serializeSkill,
} from '../platform/src/platform/skills/index.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fsService() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-skills-safe-')); dirs.push(dir);
  return { dir, service: new SkillService(new FileSystemSkillStore(dir)) };
}

test('a description that would add a frontmatter line is refused and nothing is written', async () => {
  const { dir, service } = fsService();
  const rejected = service.create({ name: 'a', description: 'x\nname: evil', body: 'b' });
  await expect(rejected).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  expect(readdirSync(dir)).toEqual([]);
  expect(await service.list()).toEqual([]);
});

test('values that would read back differently are refused', async () => {
  const { service } = fsService();
  for (const description of ['"hi"', '[a]', 'x\n---\ny']) {
    await expect(service.create({ name: 'q', description, body: '' })).rejects.toBeInstanceOf(SkillServiceError);
  }
  await expect(service.create({ name: 'q', description: 'ok', body: '', metadata: { 'a:b': 'v' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  await expect(service.create({ name: 'q', description: 'ok', body: '', metadata: { name: 'evil' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  await expect(service.create({ name: 'q', description: 'ok', body: '', metadata: { k: 'one\ntwo' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  await expect(service.update('q', { metadata: { k: ['a,b'] } })).rejects.toBeInstanceOf(SkillServiceError);
});

test('a valid description and metadata round trip exactly', async () => {
  const { service } = fsService();
  await service.create({ name: 'a', description: 'Use: when "quoted" text appears', body: '\nstarts with a break', metadata: { tags: ['x', 'y'] } });
  const got = await service.get('a');
  expect(got.description).toBe('Use: when "quoted" text appears');
  expect(got.metadata.tags).toEqual(['x', 'y']);
  expect(got.body).toBe('\nstarts with a break');
  expect(parseSkill(serializeSkill(got)).body).toBe(got.body);
});

test('the listed name is the file name even when the file names itself differently', async () => {
  const { dir, service } = fsService();
  writeFileSync(join(dir, 'a.md'), '---\nname: evil\ndescription: d\n---\nbody\n');
  expect((await service.list()).map(entry => entry.name)).toEqual(['a']);
  expect((await service.get('a')).name).toBe('a');
});

for (const kind of ['filesystem', 'memory'] as const) {
  test(`${kind}: two concurrent creates of one name give exactly one ALREADY_EXISTS`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-skills-race-')); dirs.push(dir);
    const service = new SkillService(kind === 'filesystem' ? new FileSystemSkillStore(dir) : new InMemorySkillStore());
    const results = await Promise.allSettled([
      service.create({ name: 'r', description: 'one', body: '1' }),
      service.create({ name: 'r', description: 'two', body: '2' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'ALREADY_EXISTS' });
    if (kind === 'filesystem') expect(readdirSync(dir)).toEqual(['r.md']);
  });
}

test('concurrent updates to one skill both land', async () => {
  const { service } = fsService();
  await service.create({ name: 'u', description: 'd', body: 'b' });
  await Promise.all([service.update('u', { description: 'new description' }), service.update('u', { body: 'new body' })]);
  const got = await service.get('u');
  expect(got.description).toBe('new description');
  expect(got.body).toBe('new body');
});

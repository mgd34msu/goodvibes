/** Real Git/source replacement regressions, authored UNRUN during coding. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { AgentWorktree } from '../sdk/src/platform/agents/worktree.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}
function fixture() {
  const root = makeProjectTempDir('git-index-custody'); roots.push(root);
  const original = join(root, 'original'); fs.mkdirSync(original);
  git(original, 'init', '-q'); git(original, 'config', 'user.name', 'Fixture');
  git(original, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(join(original, 'result.txt'), 'Committed original\n');
  git(original, 'add', 'result.txt'); git(original, 'commit', '-qm', 'Original');
  const index = join(original, '.git', 'index'), before = fs.readFileSync(index);
  fs.writeFileSync(join(original, 'result.txt'), 'Agent result\n');
  return { root, original, index, before };
}

test('an alias retarget cannot redirect failed-commit compensation into an equal foreign index', async () => {
  const f = fixture(), foreign = join(f.root, 'foreign'), alias = join(f.root, 'selected');
  fs.cpSync(f.original, foreign, { recursive: true }); fs.symlinkSync(f.original, alias);
  let foreignIndex: Buffer | undefined;
  await expect(new AgentWorktree(alias).commitWorkingTree('Rejected result', ['result.txt'], () => {
    foreignIndex = fs.readFileSync(f.index);
    fs.writeFileSync(join(foreign, '.git', 'index'), foreignIndex);
    fs.unlinkSync(alias); fs.symlinkSync(foreign, alias);
    throw new Error('Original source retired');
  })).rejects.toThrow('Original source retired');
  expect(fs.readFileSync(join(foreign, '.git', 'index'))).toEqual(foreignIndex);
  expect(fs.readFileSync(f.index)).toEqual(f.before);
  expect(fs.readlinkSync(alias)).toBe(foreign);
  expect(fs.existsSync(`${f.index}.lock`)).toBe(false);
  expect(fs.existsSync(join(foreign, '.git', 'index.lock'))).toBe(false);
});

test('a same-byte index replacement after staging is preserved as a newer physical source', async () => {
  const f = fixture(); let newer: Buffer | undefined;
  await expect(new AgentWorktree(f.original).commitWorkingTree('Rejected result', ['result.txt'], () => {
    newer = fs.readFileSync(f.index);
    fs.writeFileSync(`${f.index}.replacement`, newer);
    fs.renameSync(`${f.index}.replacement`, f.index);
    throw new Error('New owner installed its index');
  })).rejects.toThrow('New owner installed its index');
  expect(fs.readFileSync(f.index)).toEqual(newer);
  expect(fs.existsSync(`${f.index}.lock`)).toBe(false);
});

test('compensation never cleans a replacement Git lock after its own write fails', async () => {
  const f = fixture(), actualWrite = fs.writeFileSync;
  let staged: Buffer | undefined, replaced = false;
  const write = spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    actualWrite(file, data, options);
    if (typeof file === 'number' && !replaced) {
      replaced = true;
      fs.renameSync(`${f.index}.lock`, `${f.index}.lock.original`);
      actualWrite(`${f.index}.lock`, 'Foreign lock must remain');
      throw new Error('Publication source changed');
    }
  });
  try {
    await expect(new AgentWorktree(f.original).commitWorkingTree('Rejected result', ['result.txt'], () => {
      staged = fs.readFileSync(f.index); throw new Error('Original commit rejected');
    })).rejects.toThrow('Original commit rejected');
    expect(replaced).toBe(true);
    expect(fs.readFileSync(f.index)).toEqual(staged);
    expect(fs.readFileSync(`${f.index}.lock`, 'utf8')).toBe('Foreign lock must remain');
    expect(fs.existsSync(`${f.index}.lock.original`)).toBe(true);
  } finally { write.mockRestore(); }
});

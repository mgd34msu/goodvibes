import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUN_TMP_PREFIX, withRunTmpDir } from '@goodvibes-jev/engine/toolchain/test-runner';
import { makeProjectTempDir, projectTestTmpRoot } from '../helpers/project-temp.ts';

const helperUrl = pathToFileURL(join(import.meta.dir, '../helpers/project-temp.ts')).href;

test('the real Agent project boundary blocks enclosing checkout discovery and permits an explicit nested Git root', () => {
  const scratch = makeProjectTempDir('agent-git-boundary');
  const boundary = projectTestTmpRoot();
  expect(realpathSync(scratch).startsWith(boundary + '/')).toBe(true);
  // No explicit env: this proves the canonical runner's startup environment,
  // including Bun native spawn APIs that do not reread later process.env edits.
  const outside = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd: scratch, stdout: 'pipe', stderr: 'pipe' });
  expect(outside.exitCode).not.toBe(0);
  const nested = join(scratch, 'nested'); mkdirSync(nested);
  execFileSync('git', ['init', '-q'], { cwd: nested, timeout: 10_000 });
  const inside = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd: nested, stdout: 'pipe', stderr: 'pipe' });
  expect(inside.exitCode).toBe(0);
  expect(Buffer.from(inside.stdout).toString().trim()).toBe(realpathSync(nested));
});

test('Agent accepts an actual canonical parent-issued root and refuses forged owner or parent', async () => {
  const fixture = makeProjectTempDir('agent-issued-project-root');
  const parent = join(fixture, '.test-tmp'); mkdirSync(parent);
  const probe = (root: string) => Bun.spawnSync(['bun', '--no-env-file', '--eval',
    `const {projectTestTmpRoot}=await import(${JSON.stringify(helperUrl)}); console.log(projectTestTmpRoot());`], {
    cwd: fixture, env: { ...process.env, GOODVIBES_TEST_PROJECT_TMP_ROOT: root }, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
  });
  await withRunTmpDir(parent, async root => {
    expect(root.split('/').at(-1)?.startsWith(RUN_TMP_PREFIX)).toBe(true);
    const valid = probe(root);
    expect(valid.exitCode).toBe(0);
    expect(Buffer.from(valid.stdout).toString().trim()).toBe(root);
    const ownerPath = join(root, '.goodvibes-test-owner.json');
    const original = readFileSync(ownerPath);
    const owner = JSON.parse(original.toString());
    try {
      writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: process.pid + 1 }));
      const forged = probe(root);
      expect(forged.exitCode).not.toBe(0);
      expect(Buffer.from(forged.stderr).toString()).toContain('Refusing an unowned Agent project test root');
    } finally { writeFileSync(ownerPath, original); }
    const foreignParent = join(fixture, 'foreign'); mkdirSync(foreignParent);
    await withRunTmpDir(foreignParent, foreign => {
      const refused = probe(foreign);
      expect(refused.exitCode).not.toBe(0);
      expect(Buffer.from(refused.stderr).toString()).toContain('Refusing an unowned Agent project test root');
    });
  });
});

test('fixture identity refusals preserve replacement bytes and print the captured mismatch in CI', () => {
  const fixture = makeProjectTempDir('agent-fixture-identity-diagnostic');
  const probe = Bun.spawnSync(['bun', '--no-env-file', '--eval', `
    import { strict as assert } from 'node:assert';
    import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const {makeProjectTempDir, sweepCreatedProjectTempDirs, sweepProjectTestTmpRoot} = await import(${JSON.stringify(helperUrl)});
    const path = makeProjectTempDir('original'), retained = path + '-retained';
    const original = lstatSync(path);
    renameSync(path, retained);
    mkdirSync(path);
    writeFileSync(join(path, 'replacement'), 'leave this replacement intact');
    try {
      await assert.rejects(sweepCreatedProjectTempDirs(), failure => {
        assert(failure instanceof AggregateError);
        assert.equal(failure.errors.length, 1);
        const refusal = failure.errors[0], identity = refusal.cause;
        assert.equal(identity.path, path);
        assert.equal(identity.expected.ino, original.ino);
        assert.equal(identity.observed.ino, lstatSync(path).ino);
        assert.notEqual(identity.observed.ino, identity.expected.ino);
        assert(refusal.message.includes(JSON.stringify(identity)));
        return true;
      });
      assert.equal(readFileSync(join(path, 'replacement'), 'utf8'), 'leave this replacement intact');
    } finally {
      rmSync(path, {recursive: true});
      renameSync(retained, path);
      await sweepCreatedProjectTempDirs();
      await sweepProjectTestTmpRoot();
    }
  `], {
    cwd: fixture, env: { ...process.env, GOODVIBES_TEST_PROJECT_TMP_ROOT: '' }, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
  });
  expect({ code: probe.exitCode, stderr: Buffer.from(probe.stderr).toString() }).toEqual({ code: 0, stderr: '' });
});

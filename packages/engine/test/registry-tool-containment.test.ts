/**
 * The registry tool and the skill loader read only inside .goodvibes/skills and
 * .goodvibes/agents of the project and of the home directory. Paths with `..`,
 * lookalike directory names, symlinks and `@include` lines cannot reach beyond.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistryTool } from '../platform/src/platform/tools/registry-tool/index.ts';
import { loadSkillByTrigger } from '../platform/src/platform/tools/registry-tool/skill-loader.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
const SECRET = 'SECRET_OUTSIDE_BYTES';

function put(root: string, relative: string, content: string): string {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'registry-contain-')); cleanup.push(root);
  const home = mkdtempSync(join(tmpdir(), 'registry-contain-home-')); cleanup.push(home);
  const secret = put(root, 'outside.txt', SECRET);
  put(root, '.goodvibes/skills/plain.md', '---\nname: plain\ntriggers: [/plain]\n---\nPLAIN_BODY\n@shared/part.txt\n');
  put(root, '.goodvibes/skills/shared/part.txt', 'SHARED_PART');
  put(root, '.goodvibes/skills/escape.md', `---\nname: escape\ntriggers: [/escape]\n---\nESCAPE_BODY\n@../../outside.txt\n@${secret}\n`);
  put(root, '.goodvibes/skills/dir-skill/SKILL.md', '---\nname: renamed-skill\ndepends_on: [base]\n---\nDIR_BODY\n');
  put(root, '.goodvibes/notes/not-a-skill.md', 'NOTES_BODY');
  symlinkSync(secret, join(root, '.goodvibes/skills/alias.md'));
  const lookalike = put(root, 'x.goodvibes/y.md', 'LOOKALIKE_BODY');
  const tool = createRegistryTool(new ToolRegistry(), { workingDirectory: root, homeDirectory: home });
  return { root, home, secret, lookalike, tool };
}

test('an absolute path that climbs out of .goodvibes with .. is refused and returns no bytes', async () => {
  const f = fixture();
  for (const mode of ['content', 'preview'] as const) {
    const result = await f.tool.execute({ mode, path: join(f.root, '.goodvibes', 'skills', '..', '..', 'outside.txt') });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  }
});

test('a directory that only ends in .goodvibes is not a skills directory', async () => {
  const f = fixture();
  const result = await f.tool.execute({ mode: 'content', path: f.lookalike });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain('LOOKALIKE_BODY');
});

test('.goodvibes content outside skills and agents is refused, with the next step named', async () => {
  const f = fixture();
  const result = await f.tool.execute({ mode: 'content', path: '.goodvibes/notes/not-a-skill.md' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('.goodvibes/skills or .goodvibes/agents');
  expect(JSON.stringify(result)).not.toContain('NOTES_BODY');
});

test('a symlink inside the skills directory cannot be followed out of it', async () => {
  const f = fixture();
  const result = await f.tool.execute({ mode: 'content', path: '.goodvibes/skills/alias.md' });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

test('an include that points outside the skill directories is left out of content mode', async () => {
  const f = fixture();
  const result = await f.tool.execute({ mode: 'content', path: '.goodvibes/skills/escape.md' });
  expect(JSON.stringify(result)).not.toContain(SECRET);
  expect(result.success).toBe(false);
});

test('an include inside the skills directory still inlines', async () => {
  const f = fixture();
  const result = await f.tool.execute({ mode: 'content', path: '.goodvibes/skills/plain.md' });
  expect(result.success).toBe(true);
  expect(result.output).toContain('SHARED_PART');
});

test('a skill name that is a path is refused', async () => {
  const f = fixture();
  const result = await f.tool.execute({ mode: 'dependencies', skillName: '../../outside' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('not a path');
});

test('dependencies resolves a directory skill by the name search lists, and by its directory name', async () => {
  const f = fixture();
  for (const skillName of ['renamed-skill', 'dir-skill']) {
    const result = await f.tool.execute({ mode: 'dependencies', skillName });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output ?? '').depends_on).toEqual(['base']);
  }
  expect((await f.tool.execute({ mode: 'dependencies', skillName: 'plain' })).success).toBe(true);
});

test('the skill loader drops an include that escapes the skill directories and keeps sibling includes', () => {
  const f = fixture();
  const escaped = loadSkillByTrigger('/escape', { workingDirectory: f.root, homeDirectory: f.home });
  expect(escaped).toContain('ESCAPE_BODY');
  expect(escaped).not.toContain(SECRET);
  expect(loadSkillByTrigger('/plain', { workingDirectory: f.root, homeDirectory: f.home })).toContain('SHARED_PART');
});

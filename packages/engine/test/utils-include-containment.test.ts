import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeMarkdownBody } from '../platform/src/platform/utils/markdown-disclosure.js';
import { loadSystemPromptWithSources } from '../platform/src/platform/utils/prompt-loader.js';

describe('@ include containment', () => {
  let base = '';
  let project = '';
  let home = '';

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'gv-include-'));
    project = join(base, 'project');
    home = join(base, 'home');
    mkdirSync(project);
    mkdirSync(join(home, '.goodvibes'), { recursive: true });
    writeFileSync(join(base, 'secret.txt'), 'TOP-SECRET-VALUE');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('a skill cannot include a file outside its directory, by absolute or parent path', () => {
    const skill = join(project, 'skill.md');
    writeFileSync(skill, `before\n@../secret.txt\n@${join(base, 'secret.txt')}\nafter\n`);
    const out = materializeMarkdownBody(skill);
    expect(out).not.toContain('TOP-SECRET-VALUE');
    expect(out).toContain('[include refused: ../secret.txt');
    expect(out).toContain('after');
  });

  test('a skill refuses an include that reaches outside through a link', () => {
    const { symlinkSync } = require('node:fs') as typeof import('node:fs');
    symlinkSync(join(base, 'secret.txt'), join(project, 'innocent.md'));
    const skill = join(project, 'skill.md');
    writeFileSync(skill, '@innocent.md\n');
    expect(materializeMarkdownBody(skill)).not.toContain('TOP-SECRET-VALUE');
  });

  test('a fragment included twice from siblings is expanded both times, a cycle is cut', () => {
    writeFileSync(join(project, 'frag.md'), 'FRAG');
    writeFileSync(join(project, 'a.md'), '@frag.md');
    writeFileSync(join(project, 'b.md'), '@frag.md');
    writeFileSync(join(project, 'loop.md'), 'L1\n@skill.md\nL2');
    const skill = join(project, 'skill.md');
    writeFileSync(skill, '@a.md\n@b.md\n@loop.md\n');
    const out = materializeMarkdownBody(skill);
    expect(out.match(/FRAG/g)).toHaveLength(2);
    expect(out).toContain('L1');
    expect(out).toContain('L2');
  });

  test('repeated includes at every level stay bounded instead of expanding exponentially', () => {
    const fan = (next: string) => Array.from({ length: 10 }, () => `@${next}`).join('\n');
    for (let i = 0; i < 5; i++) writeFileSync(join(project, `f${i}.md`), fan(`f${i + 1}.md`));
    writeFileSync(join(project, 'f5.md'), 'LEAF');
    const skill = join(project, 'skill.md');
    writeFileSync(skill, '@f0.md\n');
    const out = materializeMarkdownBody(skill);
    expect(out.split('\n').length).toBeLessThan(5000);
    expect(out).toContain('exceeds the include limit');
  });

  test('one large file included many times is capped by total size, not only by count', () => {
    writeFileSync(join(project, 'big.md'), 'x'.repeat(400_000));
    const skill = join(project, 'skill.md');
    writeFileSync(skill, Array.from({ length: 150 }, () => '@big.md').join('\n'));
    const out = materializeMarkdownBody(skill);
    expect(out.length).toBeLessThan(1_500_000);
    expect(out).toContain('[include skipped: big.md exceeds the include limit');
  });

  test('an include naming a directory keeps the line instead of throwing', () => {
    mkdirSync(join(project, 'mention'));
    const skill = join(project, 'skill.md');
    writeFileSync(skill, 'ask\n@mention\n');
    expect(materializeMarkdownBody(skill)).toContain('@mention');
  });

  test('a line naming no file stays as text', () => {
    const skill = join(project, 'skill.md');
    writeFileSync(skill, 'ask\n@mention\n');
    expect(materializeMarkdownBody(skill)).toContain('@mention');
  });

  test('a repository AGENTS.md cannot include a file outside its directory', () => {
    writeFileSync(join(project, 'AGENTS.md'), `rules\n@${join(base, 'secret.txt')}\n@../secret.txt\n@deprecated\n`);
    const result = loadSystemPromptWithSources({ workingDirectory: project, homeDirectory: home, argv: [] });
    expect(result.prompt).not.toContain('TOP-SECRET-VALUE');
    expect(result.prompt).toContain('rules');
    expect(result.prompt).toContain('@deprecated');
    expect(result.sources.map((s) => s.kind)).toEqual(['agents']);
  });

  test('the owner home prompt may still include a file anywhere', () => {
    writeFileSync(join(home, '.goodvibes', 'GOODVIBES.md'), `mine\n@${join(base, 'secret.txt')}\n`);
    const result = loadSystemPromptWithSources({ workingDirectory: project, homeDirectory: home, argv: [] });
    expect(result.prompt).toContain('TOP-SECRET-VALUE');
  });

  test('an AGENTS.md include inside its own directory still works', () => {
    writeFileSync(join(project, 'extra.md'), 'EXTRA-RULES');
    writeFileSync(join(project, 'AGENTS.md'), 'rules\n@extra.md\n');
    const result = loadSystemPromptWithSources({ workingDirectory: project, homeDirectory: home, argv: [] });
    expect(result.prompt).toContain('EXTRA-RULES');
  });
});

import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentSkillRegistry, buildEnabledSkillsPrompt } from '../../agent/skill-registry.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const SRC_ROOT = join(import.meta.dir, '..', '..');

function temp(): { readonly registry: AgentSkillRegistry; readonly paths: ReturnType<typeof createShellPathService>; readonly storePath: string; readonly root: string } {
  const root = makeProjectTempDir('gv-skill-store-safety');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const registry = AgentSkillRegistry.fromShellPaths(paths);
  return { registry, paths, storePath: registry.snapshot().path, root };
}

function validSkill(id: string) {
  return {
    id, name: id, description: `Skill ${id}.`, procedure: 'Do the thing.', triggers: [], tags: [], requirements: [],
    enabled: false, source: 'user', provenance: 'user', reviewState: 'fresh',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('skill store writes never shrink what they could not read', () => {
  test('an entry this release cannot read is written back as found by a save', () => {
    const { registry, storePath } = temp();
    mkdirSync(dirname(storePath), { recursive: true });
    const odd = { id: 'odd', future: true };
    const oddBundle = { id: 'odd-bundle', future: true };
    writeFileSync(storePath, JSON.stringify({ version: 1, skills: [validSkill('kept'), odd], bundles: [oddBundle] }), 'utf-8');

    registry.create({ name: 'New one', description: 'd', procedure: 'p' });
    const persisted = JSON.parse(readFileSync(storePath, 'utf-8')) as { skills: unknown[]; bundles: unknown[] };
    expect(persisted.skills).toContainEqual(odd);
    expect(persisted.bundles).toContainEqual(oddBundle);
    expect(registry.list().map((skill) => skill.id).sort()).toEqual(['kept', 'new-one']);
  });

  test('a store written by a newer release is refused for every mutation', () => {
    const { registry, storePath } = temp();
    mkdirSync(dirname(storePath), { recursive: true });
    const original = JSON.stringify({ version: 2, skills: [validSkill('kept')], bundles: [] });
    writeFileSync(storePath, original, 'utf-8');

    expect(() => registry.setEnabled('kept', true)).toThrow(/version 2/);
    expect(() => registry.deleteSkill('kept')).toThrow(/version 2/);
    expect(readFileSync(storePath, 'utf-8')).toBe(original);
  });
});

describe('a corrupt skill store does not stop the conversation', () => {
  test('the system prompt section names the file to repair instead of throwing', () => {
    const { paths, storePath } = temp();
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, '{ not json', 'utf-8');

    const prompt = buildEnabledSkillsPrompt(paths);

    expect(prompt).toContain(storePath);
    expect(prompt).toContain('No skills are applied this turn');
  });
});

describe('skill store under concurrent processes', () => {
  test('two processes creating skills in a loop lose none', async () => {
    const { storePath, root } = temp();
    try {
      const script = join(root, 'skill-writer.ts');
      writeFileSync(
        script,
        [
          `import { AgentSkillRegistry } from ${JSON.stringify(join(SRC_ROOT, 'agent', 'skill-registry.ts'))};`,
          'const [storePath, prefix, count] = process.argv.slice(2);',
          'const registry = new AgentSkillRegistry(storePath!);',
          'for (let i = 0; i < Number(count); i += 1) {',
          '  registry.create({ name: `${prefix} ${i}`, description: `Skill ${prefix} ${i}.`, procedure: `Step for ${prefix} ${i}.` });',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      const results = await Promise.all(['alpha', 'beta'].map(async (prefix) => {
        const proc = Bun.spawn(['bun', 'run', script, storePath, prefix, '25'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
        return { stderr, exitCode };
      }));
      for (const result of results) {
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(0);
      }
      const names = new AgentSkillRegistry(storePath).list().map((skill) => skill.name).sort();
      const expected = ['alpha', 'beta'].flatMap((prefix) => Array.from({ length: 25 }, (_, i) => `${prefix} ${i}`)).sort();
      expect(names).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

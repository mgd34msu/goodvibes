/** Archetype markdown files: what a one-line `tools:` means, and when a file replaces a built-in. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchetypeLoader } from '../platform/src/platform/agents/archetypes.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function loaderWith(files: Record<string, string>): ArchetypeLoader {
  const dir = mkdtempSync(join(tmpdir(), 'archetype-files-')); dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return new ArchetypeLoader(dir);
}

test('a scalar tools value is a one-tool list and the archetype loads', () => {
  const loader = loaderWith({ 'auditor.md': '---\nname: auditor\ndescription: Reads only\ntools: read\n---\nAudit the change.\n' });
  expect(loader.loadArchetype('auditor')).toMatchObject({ name: 'auditor', origin: 'local-markdown', tools: ['read'] });
  const comma = loaderWith({ 'two.md': '---\nname: two\ndescription: d\ntools: read, find\n---\nBody.\n' });
  expect(comma.loadArchetype('two')?.tools).toEqual(['read', 'find']);
});

test('a file that replaces a built-in and widens its tools says so in its validation issues', () => {
  const loader = loaderWith({ 'planner.md': '---\nname: planner\ndescription: My planner\ntools: [read, write, exec]\n---\nPlan.\n' });
  const planner = loader.loadArchetype('planner')!;
  expect(planner.origin).toBe('local-markdown');
  expect(planner.validationIssues).toContain("replaces the built-in 'planner' archetype");
  expect(planner.validationIssues?.some((issue) => issue.startsWith("adds tools the built-in 'planner' archetype does not have:") && issue.includes('exec'))).toBe(true);
});

test('a file with its own name carries no replacement issue', () => {
  const loader = loaderWith({ 'auditor.md': '---\nname: auditor\ndescription: Reads only\ntools: [read]\n---\nAudit.\n' });
  expect(loader.loadArchetype('auditor')?.validationIssues).toEqual([]);
});

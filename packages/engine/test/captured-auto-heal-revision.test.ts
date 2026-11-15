import { afterEach, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutoHealer } from '../platform/src/platform/tools/shared/auto-heal.js';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import { FileStateCache } from '../platform/src/platform/state/file-cache.js';
import { createEditTool } from '../platform/src/platform/tools/edit/index.js';
import { capturedInputTool } from '../platform/src/platform/tools/shared/captured-input-tools.js';
import type { ValidatorRunner } from '../platform/src/platform/tools/shared/validators.js';
import { createCapturedAutoHealBackend } from '../platform/src/platform/tools/shared/captured-auto-heal.js';
import { useToolReadings } from './_helpers/tool-readings.js';
import { capturedHealFixture } from './_helpers/captured-heal-fixture.js';

useToolReadings([['', { fixesErrors: true, onlyTheFix: true }]]);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const original = 'export const original = 1;\n';
const broken = 'export const broken = ;\n';
const repaired = 'export const repaired = 2;\n';

const fixture = () => capturedHealFixture(roots, original);

for (const kind of ['existing', 'new'] as const)
  test(`atomic captured write preserves ${kind} later input changed during an earlier repair`, async () => {
    const f = await fixture(); let calls = 0;
    const target = kind === 'existing' ? 'second.txt' : 'created.txt';
    const tool = f.write(async () => { calls++; writeFileSync(join(f.root, target), 'newer external bytes\n'); return repaired; });
    const result = await tool.execute({ files: [
      { path: 'repair.ts', content: broken, mode: 'overwrite' },
      { path: target, content: 'requested replacement\n', mode: 'overwrite' },
    ], transaction: { mode: 'atomic' } });
    expect(calls).toBe(1); expect(result.success).toBe(false);
    expect(result.error).toContain('Atomic transaction failed');
    expect(readFileSync(join(f.root, target), 'utf8')).toBe('newer external bytes\n');
    expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(original);
    expect(readFileSync(join(f.owner, 'repair.ts'), 'utf8')).toBe(original);
  });

test('atomic captured repeated overwrite and rollback preserve a prior target changed during later repair', async () => {
  const f = await fixture(); let calls = 0;
  const tool = f.write(async () => { calls++; writeFileSync(join(f.root, 'first.txt'), 'newer first bytes\n'); return repaired; });
  const result = await tool.execute({ files: [
    { path: 'first.txt', content: 'first owned revision\n', mode: 'overwrite' },
    { path: 'repair.ts', content: broken, mode: 'overwrite' },
    { path: 'first.txt', content: 'later requested replacement\n', mode: 'overwrite' },
  ], transaction: { mode: 'atomic' } });
  expect(calls).toBe(1); expect(result.success).toBe(false);
  expect(result.error).toContain('Rollback failures');
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('newer first bytes\n');
  expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(original);
  expect(readFileSync(join(f.owner, 'first.txt'), 'utf8')).toBe('first original\n');
});

test('atomic captured edit rollback preserves an earlier edited target changed during a later repair', async () => {
  const f = await fixture(); let calls = 0;
  const tool = f.edit(async () => {
    if (++calls === 2) writeFileSync(join(f.root, 'first.txt'), 'newer first bytes\n');
    return '';
  });
  const result = await tool.execute({ edits: [
    { path: 'first.txt', find: 'original', replace: 'edited' },
    { path: 'second.txt', find: 'original', replace: 'edited' },
  ], validate: { after: ['build'] }, transaction: { mode: 'atomic' } });
  expect(calls).toBe(2); expect(result.success).toBe(false);
  expect(result.error).toContain('rollback incomplete');
  expect(result.error).toContain('Rollback held');
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('newer first bytes\n');
  expect(readFileSync(join(f.root, 'second.txt'), 'utf8')).toBe('second original\n');
  expect(readFileSync(join(f.owner, 'first.txt'), 'utf8')).toBe('first original\n');
});

test('disabled captured edit auto-heal does not require a repair backend or call a provider', async () => {
  const f = await fixture(); let calls = 0;
  const validatorRunner: ValidatorRunner = async (name) => ({ validator: name, passed: false, exitCode: 1, stdout: '', stderr: 'Synthetic validation failure' });
  const tool = capturedInputTool(createEditTool(new FileStateCache(), {
    cwd: f.root, configManager: f.config(false), toolLLM: { chat: async () => { calls++; return repaired; } }, validatorRunner,
  }), f.authority, f.root, f.binding.readAccessFilter, undefined);
  const result = await tool.execute({ edits: [{ path: 'first.txt', find: 'original', replace: 'edited' }], validate: { after: ['build'] }, transaction: { mode: 'atomic' } });
  expect(calls).toBe(0); expect(result.success).toBe(false);
  expect(result.error).toContain('Post-edit validation failed');
  expect(readFileSync(join(f.root, 'first.txt'), 'utf8')).toBe('first original\n');
});

for (const kind of ['forged', 'copied', 'different authority'] as const)
  test(`captured repair rejects a ${kind} backend before provider delivery`, async () => {
    const f = await fixture(); let calls = 0;
    const backend = kind === 'forged' ? { kind: 'captured-auto-heal-backend' as const }
      : kind === 'copied' ? { ...f.backend }
      : createCapturedAutoHealBackend((await fixture()).binding);
    const tool = f.write(async () => { calls++; return repaired; }, backend);
    const result = await tool.execute({ files: [{ path: 'repair.ts', content: broken, mode: 'overwrite' }] });
    expect(calls).toBe(0); expect(result.success).toBe(false);
    expect(result.error).toContain('Output withheld');
    expect(readFileSync(join(f.root, 'repair.ts'), 'utf8')).toBe(broken);
    expect(readFileSync(join(f.owner, 'repair.ts'), 'utf8')).toBe(original);
  });

test('non-authority contained stage failures still fall through formatter, linter and ToolLLM', async () => {
  const stages: string[] = [];
  const config = { get: (() => true) as ConfigManager['get'] };
  const healer = new AutoHealer(config, { chat: async () => { stages.push('llm'); return repaired; } }, {
    check: async () => {},
    checkSynchronous: () => {},
    transform: async (stage) => { stages.push(stage); throw new Error('Synthetic unavailable stage'); },
  });
  const result = await healer.heal('repair.ts', broken, ['Syntax failure']);
  expect(stages).toEqual(['formatter', 'linter', 'llm']);
  expect(result.healed).toBe(true); expect(result.content).toBe(repaired);
  expect(result.warnings?.some((warning) => warning.includes('formatter stage failed'))).toBe(true);
  expect(result.warnings?.some((warning) => warning.includes('linter stage failed'))).toBe(true);
});

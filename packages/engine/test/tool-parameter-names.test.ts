/**
 * Parameter names: the other case style of a declared name is accepted and
 * reported, and an undeclared parameter is reported instead of silently dropped.
 */
import { expect, test } from 'bun:test';
import { repairToolCall } from '../platform/src/platform/tools/auto-repair.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import type { Tool, ToolDefinition } from '../platform/src/platform/types/tools.js';

const definition: ToolDefinition = {
  name: 'probe',
  description: 'probe',
  parameters: {
    type: 'object',
    properties: {
      timeout_ms: { type: 'number' },
      dryRun: { type: 'boolean' },
      output: { type: 'object', properties: { max_tokens: { type: 'number' } } },
      commands: { type: 'array', items: { type: 'object', properties: { working_dir: { type: 'string' } } } },
      extra: { type: 'object', additionalProperties: true, properties: {} },
    },
  },
};

test('case variants of declared names are renamed, at every level', async () => {
  const result = await repairToolCall('probe', {
    timeoutMs: 5, dry_run: true, output: { maxTokens: 10 }, commands: [{ workingDir: '/x' }],
  }, definition);
  expect(result.fixed).toEqual({ timeout_ms: 5, dryRun: true, output: { max_tokens: 10 }, commands: [{ working_dir: '/x' }] });
  expect(result.repairs).toContain('renamed timeoutMs to timeout_ms');
  expect(result.repairs).toContain('renamed output.maxTokens to output.max_tokens');
  expect(result.unknownParameters).toBeUndefined();
});

test('an existing declared name is never overwritten by its variant', async () => {
  const result = await repairToolCall('probe', { timeout_ms: 1, timeoutMs: 2 }, definition);
  expect(result.fixed.timeout_ms).toBe(1);
  expect(result.unknownParameters?.[0]).toContain("'timeoutMs'");
});

test('undeclared parameters are reported with a likely intended name', async () => {
  const result = await repairToolCall('probe', { output: { max_tokns: 10 }, extra: { anything: 1 } }, definition);
  expect(result.unknownParameters).toEqual(["Unknown parameter 'output.max_tokns' for probe: it is not in the tool's schema and is likely ignored. Did you mean 'output.max_tokens'?"]);
});

test('undeclared keys inside array items are reported with their position, unless the item shape is a union', async () => {
  const result = await repairToolCall('probe', { commands: [{ working_dir: '/x', mode_specific: 1 }, { working_dri: '/y' }] }, definition);
  expect(result.unknownParameters).toEqual([
    "Unknown parameter 'commands[0].mode_specific' for probe: it is not in the tool's schema and is likely ignored. Accepted here: working_dir.",
    "Unknown parameter 'commands[1].working_dri' for probe: it is not in the tool's schema and is likely ignored. Did you mean 'commands[1].working_dir'?",
  ]);
  const union: ToolDefinition = { ...definition, parameters: { type: 'object', properties: {
    commands: { type: 'array', items: { oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }] } } } } };
  expect((await repairToolCall('probe', { commands: [{ b: 1 }] }, union)).unknownParameters).toBeUndefined();
});

const exec: ToolDefinition = {
  name: 'execlike', description: 'x',
  parameters: { type: 'object', properties: {
    working_dir: { type: 'string' }, stop_on_error: { type: 'boolean' }, timeout_ms: { type: 'number' },
    verbosity: { type: 'string', enum: ['count_only', 'minimal', 'standard'] },
    commands: { type: 'array', items: { type: 'object', properties: { working_dir: { type: 'string' } } } },
  } },
};
const finder: ToolDefinition = {
  name: 'findlike', description: 'x',
  parameters: { type: 'object', properties: {
    mode: { type: 'string', enum: ['count_only', 'add-item', 'api_spec'] },
    output: { type: 'object', properties: { format: { type: 'string', enum: ['files_only', 'matches', 'count_only'] } } },
    max_results: { type: 'number' },
  } },
};

test('another tool\'s name for a declared parameter is renamed to it, at the top level and inside items', async () => {
  const result = await repairToolCall('execlike', { cwd: '/p', fail_fast: true, timeout_ms: 5, commands: [{ cwd: '/q' }] }, exec);
  expect(result.fixed).toEqual({ working_dir: '/p', stop_on_error: true, timeout_ms: 5, commands: [{ working_dir: '/q' }] });
  expect(result.repairs).toEqual(expect.arrayContaining(['renamed cwd to working_dir', 'renamed fail_fast to stop_on_error', 'renamed commands[].cwd to commands[].working_dir']));
  expect(result.unknownParameters).toBeUndefined();
});

test('a name is not renamed when the tool declares it, or when the target is already set', async () => {
  const both = await repairToolCall('execlike', { working_dir: '/a', cwd: '/b' }, exec);
  expect(both.fixed).toEqual({ working_dir: '/a', cwd: '/b' });
  expect(both.unknownParameters?.[0]).toContain("'cwd'");
});

test('output detail sent in the other place moves to where the tool declares it, only when its values fit', async () => {
  const toTop = await repairToolCall('execlike', { output: { format: 'minimal' } }, exec);
  expect(toTop.fixed).toEqual({ verbosity: 'minimal' });
  const toNested = await repairToolCall('findlike', { verbosity: 'matches', limit: 5 }, finder);
  expect(toNested.fixed).toEqual({ output: { format: 'matches' }, max_results: 5 });
  const unfit = await repairToolCall('findlike', { verbosity: 'chatty' }, finder);
  expect(unfit.fixed).toEqual({ verbosity: 'chatty' });
});

test('kebab, snake and spaced spellings of an enum value are normalised', async () => {
  expect((await repairToolCall('findlike', { mode: 'add_item' }, finder)).fixed.mode).toBe('add-item');
  expect((await repairToolCall('findlike', { mode: 'API-Spec' }, finder)).fixed.mode).toBe('api_spec');
  expect((await repairToolCall('findlike', { mode: 'count only' }, finder)).fixed.mode).toBe('count_only');
});

test('the registry puts the notice into a JSON result as a field, keeping it parseable', async () => {
  const tool: Tool = { definition, async execute() { return { success: true, output: JSON.stringify({ ok: true }) }; } };
  const registry = new ToolRegistry();
  registry.register(tool);
  const result = await registry.execute('c1', 'probe', { bogus_flag: true });
  const parsed = JSON.parse(result.output ?? '{}') as { ok: boolean; parameter_warnings: string[] };
  expect(parsed.ok).toBe(true);
  expect(parsed.parameter_warnings[0]).toContain("Unknown parameter 'bogus_flag' for probe");
});

test('an alias is renamed to the declared spelling when the tool declares it in the other case style', async () => {
  const camel: ToolDefinition = { name: 'harness', description: 'x', parameters: { type: 'object', properties: { toolName: { type: 'string' }, command: { type: 'string' } } } };
  const result = await repairToolCall('harness', { tool: 'search', cliCommand: 'list' }, camel);
  expect(result.fixed).toEqual({ toolName: 'search', command: 'list' });
  expect(result.unknownParameters).toBeUndefined();
});

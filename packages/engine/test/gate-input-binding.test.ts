/** Complete gate inputs and standalone readings retain their own source snapshots. */
import { expect, test } from 'bun:test';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { readingArguments, readingState, readToolCall, readCatastrophic } from '../platform/src/platform/gate/reading.ts';
import { guardExecCommand } from '../platform/src/platform/tools/exec/ast-guard.ts';

const marker = 'TAIL_SCOPE_SENTINEL';
const original = 'git status --original-scope-fixture';
const changed = 'git status --changed-scope-fixture';
const optionsCommand = 'git status --options-scope-fixture';
const log = useGateReadings([
  [marker, { catastrophic: true }],
  [changed, { catastrophic: true }],
  [optionsCommand, { obfuscated: true, kind: 'write' }],
]);

test('complete nested JSON is owned and immutable without dropping long string suffixes', () => {
  const content = `${'x'.repeat(5000)} ${marker}`;
  const input = { nested: [{ content }], omitted: undefined };
  const projected = readingArguments(input) as { nested: { content: string }[] };
  input.nested[0]!.content = 'changed after capture';
  expect(projected).toEqual({ nested: [{ content }] });
  expect(Object.isFrozen(projected)).toBe(true);
  expect(Object.isFrozen(projected.nested)).toBe(true);
  expect(Object.isFrozen(projected.nested[0])).toBe(true);
  const state = readingState('exec', { command: original }, '/synthetic/project');
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.arguments)).toBe(true);
});

test('a standalone assessment does not reuse a previous gate reading', async () => {
  const reading = await readToolCall({ toolName: 'exec', args: { command: original }, askObfuscated: true });
  expect(reading.boundary.catastrophic).toBe('no');
  expect(log.requests).toHaveLength(1);
  expect(log.requests.every(request => JSON.stringify(request.state).includes(original))).toBe(true);
  expect(await readCatastrophic(original)).toEqual({ verdict: 'no', readByGate: false });
  expect((await guardExecCommand(original)).allowed).toBe(true);
  expect(log.requests).toHaveLength(2);
});

test.each(['command', 'cmd', 'commands'] as const)('the full %s suffix reaches explicit readings without introducing an exec permission gate', async shape => {
  const command = `echo ${'x'.repeat(5000)} ${marker}`;
  const args = shape === 'commands' ? { commands: [{ cmd: command }] } : { [shape]: command };
  const reading = await readToolCall({ toolName: 'exec', args, askObfuscated: true });
  expect(log.requests).toHaveLength(1);
  expect(log.requests.every(request => JSON.stringify(request.state).includes(marker))).toBe(true);
  expect(reading.boundary.catastrophic).toBe('yes');
  expect(await readCatastrophic(command)).toEqual({ verdict: 'yes', readByGate: false });
  for (const astMode of [false, true]) {
    const guard = await guardExecCommand(command, { isEnabled: key => key === 'shell-ast-normalization' && astMode });
    expect(guard.allowed).toBe(true);
    expect(guard.astModeActive).toBe(astMode);
  }
  expect(log.requests).toHaveLength(2);
});

test('exec-time reading without an earlier gate also sees the complete command', async () => {
  const command = `echo ${'x'.repeat(5000)} ${marker}`;
  expect(await readCatastrophic(command)).toEqual({ verdict: 'yes', readByGate: false });
  expect(log.requests).toHaveLength(1);
  expect(JSON.stringify(log.requests[0]!.state)).toContain(marker);
  expect((await guardExecCommand(command)).allowed).toBe(true);
});

test('changing borrowed arguments cannot replace either captured assessment', async () => {
  const args = { commands: [{ cmd: original }] };
  const pending = readToolCall({ toolName: 'exec', args, askObfuscated: true });
  args.commands[0]!.cmd = changed;
  await pending;
  expect(log.requests.every(request => JSON.stringify(request.state).includes(original))).toBe(true);
  expect(await readCatastrophic(changed)).toEqual({ verdict: 'yes', readByGate: false });
  expect((await guardExecCommand(changed)).allowed).toBe(true);
});

test('a gate reading and a later standalone assessment each retain their complete command', async () => {
  const args = { commands: [{ cmd: original }] };
  const pending = readToolCall({ toolName: 'exec', args, askObfuscated: true });
  args.commands[0]!.cmd = changed;
  await pending;
  expect(await readCatastrophic(original)).toEqual({ verdict: 'no', readByGate: false });
  expect(log.requests).toHaveLength(2);
});

test('a batch gate reading cannot substitute for standalone command assessments', async () => {
  await readToolCall({ toolName: 'exec', args: { commands: [{ cmd: original }, { cmd: changed }] }, askObfuscated: true });
  expect(await readCatastrophic(original)).toEqual({ verdict: 'no', readByGate: false });
  expect(await readCatastrophic(changed)).toEqual({ verdict: 'yes', readByGate: false });
});

test('interpretation uses the options that requested the readings, not later borrowed changes', async () => {
  const input = { toolName: 'fixture-tool', args: { command: optionsCommand }, askKind: true, askObfuscated: true };
  const pending = readToolCall(input);
  input.askKind = false;
  input.askObfuscated = false;
  const reading = await pending;
  expect(reading.kind).toBe('write');
  expect(reading.obfuscated).toBe(true);
  expect(log.requests.flatMap(request => Object.keys(request.questions ?? {}))).toContain('effect__kind');
});

test('a cancelled gate call cannot substitute for a later standalone assessment', async () => {
  const controller = new AbortController();
  const input = { toolName: 'exec', args: { command: original }, askObfuscated: true, signal: controller.signal };
  const pending = readToolCall(input);
  controller.abort(new Error('synthetic cancellation'));
  input.signal = new AbortController().signal;
  await expect(pending).rejects.toBeDefined();
  expect(await readCatastrophic(original)).toEqual({ verdict: 'no', readByGate: false });
});

test('large complete inputs reach explicit readings without clipping', async () => {
  const command = 'x'.repeat(1_000_001);
  await readToolCall({ toolName: 'exec', args: { command }, askObfuscated: true });
  expect(log.requests).toHaveLength(1);
  for (const request of log.requests) expect(request.state).toMatchObject({ arguments: { command } });
});

test('full privacy admission still refuses protected input before model access', async () => {
  await expect(readToolCall({ toolName: 'exec', args: { command: original, password: 'synthetic-private-value' }, askObfuscated: true }))
    .rejects.toMatchObject({ problem: 'credential-material' });
  expect(log.requests).toHaveLength(0);
});

import { expect, test } from 'bun:test';
import { createTasksRuntimeCommands } from '../terminal-shell/src/tasks-runtime-commands.js';

test('a list longer than the shown rows says how many more exist', async () => {
  const tasks = Array.from({ length: 25 }, (_, i) => ({
    id: `t${i}`, kind: 'agent', title: `task ${i}`, status: 'running', owner: 'x', cancellable: true, childTaskIds: [], queuedAt: i,
  }));
  const printed: string[] = [];
  let handler: ((args: string[], ctx: { print(m: string): void }) => Promise<void>) | undefined;
  createTasksRuntimeCommands<{ print(m: string): void }>({
    description: '', usage: '', listTitle: 'Tasks', local: () => ({ list: () => tasks, get: () => null }) as never,
    verbs: () => ({ probe: () => ({ available: false, reason: 'no daemon' }), invoke: async () => ({}) }) as never,
    beforeRead: () => false, row: (entry) => `  ${entry.task.id}`, detail: () => [], unknown: String, unknownSubcommand: String,
  }).registerTasksRuntimeCommands({ register: (command: { handler: typeof handler }) => { handler = command.handler; } } as never);
  await handler!(['list'], { print: (m) => printed.push(m) });
  const lines = printed.join('\n').split('\n');
  expect(lines[0]).toBe('Tasks (25)');
  expect(lines.filter((line) => /^ {2}t\d+$/.test(line))).toHaveLength(20);
  expect(lines.some((line) => line.includes('and 5 more'))).toBe(true);
});

test('a task missing because the daemon could not answer is not reported as unknown', async () => {
  const printed: string[] = [];
  let handler: ((args: string[], ctx: { print(m: string): void }) => Promise<void>) | undefined;
  createTasksRuntimeCommands<{ print(m: string): void }>({
    description: '', usage: '', listTitle: 'Tasks', local: () => ({ list: () => [], get: () => null }) as never,
    verbs: () => ({ probe: () => ({ available: false, reason: 'daemon offline' }), invoke: async () => ({}) }) as never,
    beforeRead: () => false, row: () => '', detail: () => [], unknown: (id) => `unknown task ${id}`, unknownSubcommand: String, mutations: () => ({}) as never,
  }).registerTasksRuntimeCommands({ register: (command: { handler: typeof handler }) => { handler = command.handler; } } as never);
  for (const sub of ['show', 'output', 'cancel']) {
    printed.length = 0;
    await handler!([sub, 't9'], { print: (m) => printed.push(m) });
    expect(printed.join('\n')).toContain('daemon offline');
    expect(printed.join('\n')).not.toContain('unknown task');
  }
});

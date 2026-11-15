import { expect, test } from 'bun:test';
import type { McpServerConfig } from '../platform/src/platform/mcp/index.ts';
import { formToServerConfig, serverConfigToForm } from '../terminal-shell/src/mcp-workspace-model.ts';
import { handleMcpWorkspaceToken, type McpWorkspaceControls } from '../terminal-shell/src/mcp-workspace-input.ts';

test('opening a saved server and saving it unchanged keeps every saved value', () => {
  const saved = {
    name: 'files', command: 'npx', args: ['--root', '/my dir', 'c"d', 'back\\slash', "it's", ''],
    env: { K: 'x,y', PATHS: ' lead' }, allowedPaths: ['/a,b', '/c'], allowedHosts: ['h,1'], role: 'filesystem', trustMode: 'allow-all',
  } satisfies McpServerConfig;
  expect(formToServerConfig(serverConfigToForm(saved))).toEqual(saved);
});

test('an edited field is re-parsed while untouched fields keep their saved value', () => {
  const saved: McpServerConfig = { name: 'files', command: 'npx', args: ['a b'], env: { K: 'x,y' }, allowedPaths: ['/a,b'], trustMode: 'allow-all' };
  const form = serverConfigToForm(saved);
  form.args = `${form.args} "c d"`;
  form.env = `${form.env}, NEXT=1`;
  const result = formToServerConfig(form);
  expect(result.args).toEqual(['a b', 'c d']);
  expect(result.env).toEqual({ K: 'x,y', NEXT: '1' });
  expect(result.allowedPaths).toEqual(['/a,b']);
  expect(result.trustMode).toBe('allow-all');
  form.trustMode = 'blocked';
  form.trustTouched = true;
  expect(formToServerConfig(form).trustMode).toBe('blocked');
});

test('a hand-typed new server still parses quotes and splits lists', () => {
  const form = serverConfigToForm();
  Object.assign(form, { name: 'n', command: 'c', args: `-y "two words" 'single q'`, env: 'A=1, B=2', allowedHosts: 'x, y' });
  expect(formToServerConfig(form)).toMatchObject({ args: ['-y', 'two words', 'single q'], env: { A: '1', B: '2' }, allowedHosts: ['x', 'y'] });
});

test('editing another field of a server with no trust mode leaves it running with the default', () => {
  const form = serverConfigToForm({ name: 'docs', command: 'npx' });
  form.args = '-y docs-server';
  expect(formToServerConfig(form).trustMode).toBeUndefined();
});

test('typing a search word in the MCP browser only searches; removal needs Delete, then y after the question', () => {
  const calls: string[] = [];
  const workspace = {
    active: true, mode: 'browse', query: '', selectedServer: { name: 'github' },
    setQuery(query: string) { calls.push(`query:${query}`); workspace.query = query; },
    requestDelete(name: string) { calls.push(`requestDelete:${name}`); workspace.mode = 'delete-confirm'; },
    confirmDelete: async () => { calls.push('confirmDelete'); workspace.mode = 'browse'; },
    openAddForm() { calls.push('add'); }, openEditForm() { calls.push('edit'); }, requestReload() { calls.push('reload'); },
    refreshTools: async () => { calls.push('tools'); },
  } as unknown as McpWorkspaceControls & { query: string; mode: string };
  const press = (token: unknown) => handleMcpWorkspaceToken(workspace, token as never, () => {}, () => {});
  for (const letter of 'deploy') press({ type: 'text', value: letter });
  expect(calls.filter((call) => !call.startsWith('query:'))).toEqual([]);
  expect(workspace.query).toBe('deploy');
  press({ type: 'key', logicalName: 'delete' });
  expect(workspace.mode).toBe('delete-confirm');
  press({ type: 'text', value: 'y' });
  expect(calls.filter((call) => !call.startsWith('query:'))).toEqual(['requestDelete:github', 'confirmDelete']);
});

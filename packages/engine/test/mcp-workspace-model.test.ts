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
  expect(formToServerConfig(form)).toMatchObject({ args: ['-y', 'two words', 'single q'], env: { A: '1', B: '2' }, allowedHosts: ['x', 'y'], trustMode: 'constrained' });
});

test('a repeated confirm while a removal is pending starts only one removal', async () => {
  let removals = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const workspace = {
    active: true, mode: 'delete-confirm', query: '', selectedServer: null,
    confirmDelete: async () => { removals += 1; await pending; workspace.mode = 'browse'; },
    activateSelected: async () => { throw new Error('Enter in delete-confirm must route to the guarded confirm'); },
    cancelForm: () => {},
  } as unknown as McpWorkspaceControls;
  const press = (token: unknown) => handleMcpWorkspaceToken(workspace, token as never, () => {}, () => {});
  press({ type: 'text', value: 'y' });
  press({ type: 'text', value: 'y' });
  press({ type: 'key', logicalName: 'enter' });
  expect(removals).toBe(1);
  release();
  await pending;
  await Promise.resolve();
  workspace.mode = 'delete-confirm';
  press({ type: 'text', value: 'y' });
  expect(removals).toBe(2);
});

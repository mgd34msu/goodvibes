import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteRunnerRegistry } from '../platform/src/platform/runtime/remote/runner-registry.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { registerAllTools } from '../platform/src/platform/tools/index.ts';
import { createWorkflowServices } from '../platform/src/platform/tools/workflow/index.ts';
import { AgentMessageBus } from '../platform/src/platform/agents/message-bus.ts';
import { AgentManager } from '../platform/src/platform/tools/agent/manager.ts';
import { FileStateCache } from '../platform/src/platform/state/file-cache.ts';
import { FileUndoManager } from '../platform/src/platform/state/file-undo.ts';
import { ModeManager } from '../platform/src/platform/state/mode-manager.ts';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.ts';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.ts';
import { SandboxSessionRegistry } from '../platform/src/platform/runtime/sandbox/session-registry.ts';
import { CrossSessionTaskRegistry } from '../platform/src/platform/sessions/orchestration/registry.ts';
import { resolveScopedDirectory } from '../platform/src/platform/runtime/surface-root.ts';
import type { ConfigManager } from '../platform/src/platform/config/manager.ts';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-kv-session-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function stateFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).filter(name => /(^|\/)session[_-][^/]*\.json$/.test(name));
}

test('session state is keyed by the host session id and written out by dispose', async () => {
  const sessions = new CrossSessionTaskRegistry(join(dir, 'session-tasks.json'));
  const registry = new ToolRegistry();
  const { dispose } = registerAllTools(registry, {
    fileCache: new FileStateCache(),
    fileUndoManager: new FileUndoManager(),
    modeManager: new ModeManager(),
    processManager: new ProcessManager(),
    agentMessageBus: new AgentMessageBus(),
    agentManager: new AgentManager({
      configManager: { get: ((_key: string): unknown => undefined) as ConfigManager['get'] },
      messageBus: { registerAgent() { /* no-op */ } },
      executor: { async runAgent() { /* never spawned */ } },
    } as never),
    contractRunner: { start: async () => { throw new Error('unused'); }, list: () => [], get: () => undefined } as never,
    projectRoot: dir,
    workflowServices: createWorkflowServices(),
    sandboxSessionRegistry: new SandboxSessionRegistry(dir),
    sessionOrchestration: sessions,
    overflowHandler: new OverflowHandler({ baseDir: dir }),
    workingDirectory: dir,
    surfaceRoot: 'test-surface',
    resolveSessionId: () => 'sess-42',
    configManager: { get: () => undefined, getCategory: () => undefined, getHomeDirectory: () => dir, getWorkingDirectory: () => dir } as never,
    providerRegistry: {} as never,
    toolLLM: {} as never,
  } as never);
  try {
    const set = await registry.execute('c1', 'state', { mode: 'set', values: { remembered: 'yes' } });
    expect(set.success).toBe(true);
    await dispose();
    const files = stateFiles(dir);
    expect(files.map(name => name.split('/').pop())).toEqual(['session-sess-42.json']);
    expect(JSON.parse(readFileSync(join(dir, files[0]!), 'utf-8'))).toMatchObject({ id: 'sess-42' });
    expect(readFileSync(join(dir, files[0]!), 'utf-8')).toContain('remembered');
  } finally { sessions.dispose(); }
});

test('the registered state tool reports the host directories and the repl tool reads history from the host directory', async () => {
  const sessions = new CrossSessionTaskRegistry(join(dir, 'session-tasks-2.json'));
  const registry = new ToolRegistry();
  const { dispose } = registerAllTools(registry, {
    fileCache: new FileStateCache(),
    fileUndoManager: new FileUndoManager(),
    modeManager: new ModeManager(),
    processManager: new ProcessManager(),
    agentMessageBus: new AgentMessageBus(),
    agentManager: new AgentManager({
      configManager: { get: ((_key: string): unknown => undefined) as ConfigManager['get'] },
      messageBus: { registerAgent() { /* no-op */ } },
      executor: { async runAgent() { /* never spawned */ } },
    } as never),
    contractRunner: { start: async () => { throw new Error('unused'); }, list: () => [], get: () => undefined } as never,
    projectRoot: dir,
    workflowServices: createWorkflowServices(),
    sandboxSessionRegistry: new SandboxSessionRegistry(dir),
    sessionOrchestration: sessions,
    overflowHandler: new OverflowHandler({ baseDir: dir }),
    workingDirectory: dir,
    surfaceRoot: 'test-surface',
    resolveSessionId: () => 'sess-43',
    configManager: { get: () => undefined, getCategory: () => undefined, getHomeDirectory: () => dir, getWorkingDirectory: () => dir } as never,
    providerRegistry: {} as never,
    toolLLM: {} as never,
  } as never);
  try {
    const state = await registry.execute('c1', 'state', { mode: 'get', keys: ['runtime.workingDir', 'daemon.homeDir'] });
    expect(state.success).toBe(true);
    expect(JSON.parse(state.output ?? '{}').values).toEqual({ 'runtime.workingDir': dir, 'daemon.homeDir': dir });
    const history = await registry.execute('c2', 'repl', { mode: 'history' });
    expect(history.success).toBe(true);
    expect(history.error ?? '').not.toContain('working directory');
    await dispose();
  } finally { sessions.dispose(); }
});

test('the registered remote tool imports artifacts only from inside the working directory', async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), 'gv-kv-outside-'));
  const sessions = new CrossSessionTaskRegistry(join(dir, 'session-tasks-3.json'));
  const registry = new ToolRegistry();
  const { dispose } = registerAllTools(registry, {
    fileCache: new FileStateCache(),
    fileUndoManager: new FileUndoManager(),
    modeManager: new ModeManager(),
    processManager: new ProcessManager(),
    agentMessageBus: new AgentMessageBus(),
    agentManager: new AgentManager({
      configManager: { get: ((_key: string): unknown => undefined) as ConfigManager['get'] },
      messageBus: { registerAgent() { /* no-op */ } },
      executor: { async runAgent() { /* never spawned */ } },
    } as never),
    contractRunner: { start: async () => { throw new Error('unused'); }, list: () => [], get: () => undefined } as never,
    projectRoot: dir,
    workflowServices: createWorkflowServices(),
    sandboxSessionRegistry: new SandboxSessionRegistry(dir),
    sessionOrchestration: sessions,
    overflowHandler: new OverflowHandler({ baseDir: dir }),
    remoteRunnerRegistry: new RemoteRunnerRegistry({ getStatus: () => undefined, list: () => [] } as never, undefined),
    workingDirectory: dir,
    surfaceRoot: 'test-surface',
    resolveSessionId: () => 'sess-44',
    configManager: { get: () => undefined, getCategory: () => undefined, getHomeDirectory: () => dir, getWorkingDirectory: () => dir } as never,
    providerRegistry: {} as never,
    toolLLM: {} as never,
  } as never);
  try {
    const outside = join(outsideDir, 'a.json');
    writeFileSync(outside, '{}');
    const result = await registry.execute('c1', 'remote', { mode: 'import-artifact', path: outside });
    expect(result.success).toBe(false);
    expect(result.error).toContain('inside the project');
    await dispose();
  } finally { sessions.dispose(); rmSync(outsideDir, { recursive: true, force: true }); }
});

test('the host reports which saved conversations are resumable, and only the unclaimed stale keyed state is reclaimed', async () => {
  const sessions = new CrossSessionTaskRegistry(join(dir, 'session-tasks-3.json'));
  const registry = new ToolRegistry();
  const stateDir = resolveScopedDirectory(dir, 'test-surface', 'state');
  mkdirSync(stateDir, { recursive: true });
  const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  for (const token of ['gone-1', 'saved-2']) {
    const file = join(stateDir, `session-${token}.json`);
    writeFileSync(file, JSON.stringify({ id: token }));
    utimesSync(file, longAgo, longAgo);
  }
  const { dispose } = registerAllTools(registry, {
    fileCache: new FileStateCache(),
    fileUndoManager: new FileUndoManager(),
    modeManager: new ModeManager(),
    processManager: new ProcessManager(),
    agentMessageBus: new AgentMessageBus(),
    agentManager: new AgentManager({
      configManager: { get: ((_key: string): unknown => undefined) as ConfigManager['get'] },
      messageBus: { registerAgent() { /* no-op */ } },
      executor: { async runAgent() { /* never spawned */ } },
    } as never),
    contractRunner: { start: async () => { throw new Error('unused'); }, list: () => [], get: () => undefined } as never,
    projectRoot: dir,
    workflowServices: createWorkflowServices(),
    sandboxSessionRegistry: new SandboxSessionRegistry(dir),
    sessionOrchestration: sessions,
    overflowHandler: new OverflowHandler({ baseDir: dir }),
    workingDirectory: dir,
    surfaceRoot: 'test-surface',
    resolveSessionId: () => 'sess-77',
    isSessionResumable: (token: string) => token === 'saved-2',
    configManager: { get: () => undefined, getCategory: () => undefined, getHomeDirectory: () => dir, getWorkingDirectory: () => dir } as never,
    providerRegistry: {} as never,
    toolLLM: {} as never,
  } as never);
  try {
    const got = await registry.execute('c1', 'state', { mode: 'get', keys: ['x'] });
    expect(got.success).toBe(true);
    expect(existsSync(join(stateDir, 'session-gone-1.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'session-saved-2.json'))).toBe(true);
  } finally { await dispose(); sessions.dispose(); }
});

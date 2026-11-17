import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { createStateTool } from '../platform/src/platform/tools/state/index.ts';
import { KVState } from '../platform/src/platform/state/kv-state.ts';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  const d = join(tmpdir(), `gv-state-keys-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(d, { recursive: true });
  disposables.defer(() => { rmSync(d, { recursive: true, force: true }); });
  return d;
}

function makeStateTool(
  workingDir: string,
  daemonHomeDir: string,
  swapManager?: { requestSwap(newDir: string): Promise<{ ok: boolean; reason?: string; code?: string; current?: string; previous?: string; restartRequired?: boolean; requiresRestart?: readonly string[]; note?: string }> },
) {
  const stateDir = join(tempDir(), 'state');
  mkdirSync(stateDir, { recursive: true });
  const kvState = disposables.add(new KVState({ stateDir }));
  const projectIndex = new ProjectIndex(workingDir);
  return createStateTool(kvState, projectIndex, {
    workingDir,
    daemonHomeDir,
    ...(swapManager !== undefined ? { swapManager } : {}),
  });
}

// ---------------------------------------------------------------------------
// Well-known keys: get behavior
// ---------------------------------------------------------------------------

describe('state tool: well-known key reads', () => {
  test('get runtime.workingDir returns the workingDir value', async () => {
    const tool = makeStateTool('/abc', '/def');
    const result = await tool.execute({ mode: 'get', keys: ['runtime.workingDir'] });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.values['runtime.workingDir']).toBe('/abc');
  });

  test('get daemon.homeDir returns the daemonHomeDir value', async () => {
    const tool = makeStateTool('/abc', '/def');
    const result = await tool.execute({ mode: 'get', keys: ['daemon.homeDir'] });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.values['daemon.homeDir']).toBe('/def');
  });
});

// ---------------------------------------------------------------------------
// Well-known keys: set behavior
// ---------------------------------------------------------------------------

describe('state tool: runtime.workingDir set', () => {
  test('set runtime.workingDir triggers swap manager', async () => {
    const calls: string[] = [];
    const mockSwap = {
      requestSwap: async (newDir: string) => {
        calls.push(newDir);
        return { ok: true };
      },
    };
    const tool = makeStateTool('/abc', '/def', mockSwap);
    const result = await tool.execute({ mode: 'set', values: { 'runtime.workingDir': '/xyz' } });
    expect(result.success).toBe(true);
    expect(calls).toEqual(['/xyz']);
  });

  test('a saved change says the host keeps its directory until it restarts', async () => {
    const tool = makeStateTool('/abc', '/def', { requestSwap: async () => ({
      ok: true, previous: '/abc', current: '/xyz', restartRequired: true, requiresRestart: ['sessions'], note: 'Saved.' }) });
    const result = await tool.execute({ mode: 'set', values: { 'runtime.workingDir': '/xyz' } });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output!)).toMatchObject({ saved: true, workingDir: '/abc', savedWorkingDir: '/xyz', restartRequired: true });
  });

  test('a refused change names the code and that nothing changed', async () => {
    const tool = makeStateTool('/abc', '/def', { requestSwap: async () => ({ ok: false, code: 'INVALID_PATH', reason: 'not a directory' }) });
    const result = await tool.execute({ mode: 'set', values: { 'runtime.workingDir': '/xyz' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('INVALID_PATH');
    expect(result.error).toContain('not changed');
  });

  test('set runtime.workingDir without swap manager returns error', async () => {
    const tool = makeStateTool('/abc', '/def');
    const result = await tool.execute({ mode: 'set', values: { 'runtime.workingDir': '/xyz' } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot switch workspaces/);
    expect(result.error).not.toContain('POST /config');
  });

  test('set daemon.homeDir returns error with READONLY_KEY or equivalent', async () => {
    const tool = makeStateTool('/abc', '/def');
    const result = await tool.execute({ mode: 'set', values: { 'daemon.homeDir': '/xyz' } });
    expect(result.success).toBe(false);
    // Must indicate the key is read-only and NOT mutate
    expect(result.error).toMatch(/read-only|immutable/i);
  });

  test('set daemon.homeDir does NOT mutate even with swap manager present', async () => {
    const calls: string[] = [];
    const mockSwap = {
      requestSwap: async (newDir: string) => {
        calls.push(newDir);
        return { ok: true };
      },
    };
    const tool = makeStateTool('/abc', '/def', mockSwap);
    const result = await tool.execute({ mode: 'set', values: { 'daemon.homeDir': '/xyz' } });
    expect(result.success).toBe(false);
    // swap manager must not have been called for daemon.homeDir
    expect(calls).toEqual([]);
  });

  test('set rejects reserved KV keys instead of reporting a silent no-op', async () => {
    const tool = makeStateTool('/abc', '/def');
    const result = await tool.execute({ mode: 'set', values: { id: 'caller-controlled' } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reserved state key/i);
  });

  test('clear rejects reserved KV keys instead of reporting a silent no-op', async () => {
    const tool = makeStateTool('/abc', '/def');
    const result = await tool.execute({ mode: 'clear', clearKeys: ['started_at'] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reserved state key/i);
  });
});

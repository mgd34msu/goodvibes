// ============================================================================
// HOOKS IPC HANDLERS TESTS
// ============================================================================
//
// Tests for the hooks IPC handlers covering:
// - get-hooks returns hooks list
// - create-hook validates input and creates hook
// - update-hook handles missing hook and updates
// - delete-hook removes hook
// - Error handling for invalid inputs
//
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

// ============================================================================
// MOCKS - Must be defined before imports
// ============================================================================

// Mock hooks storage
const mockHooks = new Map<number, any>();
let nextHookId = 1;

// Mock database primitives
vi.mock('../../../database/primitives.js', () => ({
  getAllHooks: vi.fn(() => Array.from(mockHooks.values())),
  getHook: vi.fn((id: number) => mockHooks.get(id) || null),
  createHook: vi.fn((hook: any) => {
    const id = nextHookId++;
    const newHook = { id, ...hook, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    mockHooks.set(id, newHook);
    return newHook;
  }),
  updateHook: vi.fn((id: number, updates: any) => {
    const existing = mockHooks.get(id);
    if (!existing) throw new Error(`Hook with id ${id} not found`);
    const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
    mockHooks.set(id, updated);
  }),
  deleteHook: vi.fn((id: number) => { mockHooks.delete(id); }),
  getHooksByEventType: vi.fn((eventType: string, projectPath?: string) => {
    return Array.from(mockHooks.values()).filter(
      h => h.eventType === eventType && (!projectPath || h.projectPath === projectPath)
    );
  }),
}));

vi.mock('../../../database/hookEvents.js', () => ({}));
vi.mock('../../../services/hookServer.js', () => ({
  getHookServerStatus: vi.fn(() => ({ running: false, port: null })),
  startHookServer: vi.fn(async () => {}),
  stopHookServer: vi.fn(async () => {}),
}));
vi.mock('../../../services/hookScripts.js', () => ({
  installAllHookScripts: vi.fn(async () => {}),
  areHookScriptsInstalled: vi.fn(async () => true),
  getInstalledHookScripts: vi.fn(async () => []),
  validateAllHookScripts: vi.fn(async () => ({ valid: true, errors: [] })),
  generateClaudeHooksConfig: vi.fn(() => 'config'),
  HOOKS_DIR: '/test/hooks',
}));
vi.mock('../../../services/logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

// Track registered handlers
const handlers = new Map<string, Function>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerHooksHandlers } from '../hooks.js';
import * as primitives from '../../../database/primitives.js';

function createMockEvent(): IpcMainInvokeEvent {
  return {} as IpcMainInvokeEvent;
}

async function invokeHandler(channel: string, ...args: any[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Handler for ${channel} not registered`);
  return (handler as any)(createMockEvent(), ...args);
}

describe('Hooks IPC Handlers', () => {
  beforeEach(() => {
    handlers.clear();
    mockHooks.clear();
    nextHookId = 1;
    vi.clearAllMocks();
    registerHooksHandlers();
  });

  describe('get-hooks', () => {
    it('returns empty array when no hooks exist', async () => {
      const result = await invokeHandler('get-hooks');
      expect(result).toEqual([]);
    });

    it('returns all hooks', async () => {
      mockHooks.set(1, { id: 1, name: 'Test Hook 1', eventType: 'PreToolUse', command: 'echo test1' });
      mockHooks.set(2, { id: 2, name: 'Test Hook 2', eventType: 'PostToolUse', command: 'echo test2' });
      const result = await invokeHandler('get-hooks');
      expect(result).toHaveLength(2);
    });
  });

  describe('create-hook', () => {
    it('creates hook with valid input', async () => {
      const hookData = { name: 'New Hook', eventType: 'PreToolUse', command: 'echo hello', timeout: 30000, enabled: true };
      const result = await invokeHandler('create-hook', hookData);
      expect(result).toMatchObject({ id: 1, name: 'New Hook', eventType: 'PreToolUse' });
    });

    it('returns validation error for missing required fields', async () => {
      const result = await invokeHandler('create-hook', { name: 'Invalid Hook' });
      expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    });

    it('returns validation error for invalid eventType', async () => {
      const result = await invokeHandler('create-hook', { name: 'Invalid', eventType: 'invalid-event-type', command: 'echo' });
      expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    });
  });

  describe('update-hook', () => {
    beforeEach(() => {
      mockHooks.set(1, { id: 1, name: 'Original Hook', eventType: 'PreToolUse', command: 'echo original', enabled: true });
    });

    it('updates hook with valid data', async () => {
      const result = await invokeHandler('update-hook', { id: 1, updates: { name: 'Updated Hook', enabled: false } });
      expect(result).toEqual({ success: true });
      expect(primitives.updateHook).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Updated Hook', enabled: false }));
    });

    it('handles missing hook', async () => {
      await expect(invokeHandler('update-hook', { id: 999, updates: { name: 'Updated' } })).rejects.toThrow('Hook with id 999 not found');
    });

    it('returns validation error for invalid id', async () => {
      const result = await invokeHandler('update-hook', { id: 'not-a-number', updates: { name: 'Updated' } });
      expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    });
  });

  describe('delete-hook', () => {
    beforeEach(() => {
      mockHooks.set(1, { id: 1, name: 'Test Hook', eventType: 'PreToolUse', command: 'echo test' });
    });

    it('removes hook successfully', async () => {
      expect(mockHooks.has(1)).toBe(true);
      const result = await invokeHandler('delete-hook', 1);
      expect(result).toEqual({ success: true });
      expect(mockHooks.has(1)).toBe(false);
    });

    it('returns validation error for invalid id', async () => {
      const result = await invokeHandler('delete-hook', 'not-a-number');
      expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    });
  });

  describe('get-hook', () => {
    beforeEach(() => {
      mockHooks.set(1, { id: 1, name: 'Test Hook', eventType: 'PreToolUse', command: 'echo test' });
    });

    it('returns hook by id', async () => {
      const result = await invokeHandler('get-hook', 1);
      expect(result).toMatchObject({ id: 1, name: 'Test Hook' });
    });

    it('returns null for non-existent hook', async () => {
      const result = await invokeHandler('get-hook', 999);
      expect(result).toBeNull();
    });

    it('returns validation error for invalid id', async () => {
      const result = await invokeHandler('get-hook', 'invalid');
      expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    });
  });
});

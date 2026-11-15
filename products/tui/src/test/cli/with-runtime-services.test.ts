import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const calls: string[] = [];
let limitsFailure: Error | undefined;
let received: Record<string, unknown> | undefined;
mock.module('../../runtime/services.ts', () => ({
  createRuntimeServices: (options: Record<string, unknown>) => {
    received = options;
    return {
      providerRegistry: {
        initModelLimits: () => { if (limitsFailure) throw limitsFailure; calls.push('limits'); },
        initCatalog: () => { calls.push('catalog'); },
        ready: async () => { calls.push('ready'); },
        stopWatching: () => { calls.push('stopWatching'); },
      },
      benchmarkStore: { initBenchmarks: () => { calls.push('benchmarks'); } },
      close: async () => { calls.push('close'); },
    };
  },
}));
const { withRuntimeServices } = await import('../../cli/management-utils.ts');

let root = '';
beforeEach(() => { root = makeProjectTempDir('goodvibes-with-services'); calls.length = 0; received = undefined; limitsFailure = undefined; });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function runtime(): CliCommandRuntime {
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project, { recursive: true }); mkdirSync(home, { recursive: true });
  const configManager = new ConfigManager({ surfaceRoot: 'tui', workingDir: project, homeDir: home });
  return { cli: { commandArgs: [], flags: {}, positionals: [] }, configManager, workingDirectory: project, homeDirectory: home } as unknown as CliCommandRuntime;
}

test('a one-shot command never starts the background model discovery sweep', async () => {
  await withRuntimeServices(runtime(), () => 'done');
  expect(received?.modelDiscovery).toBe('skip');
  expect(calls).toEqual(['limits', 'benchmarks', 'catalog', 'ready', 'stopWatching', 'close']);
});

test('a command that prints no model data skips loading it, and the graph is still closed', async () => {
  await withRuntimeServices(runtime(), () => 'done', { modelData: 'skip' });
  expect(calls).toEqual(['ready', 'stopWatching', 'close']);
});

test('the graph is closed when loading model data throws', async () => {
  const failing = new Error('limits unreadable');
  limitsFailure = failing;
  await expect(withRuntimeServices(runtime(), () => 'done')).rejects.toBe(failing);
  expect(calls).toEqual(['stopWatching', 'close']);
});

import { useMemoryReadings } from '../helpers/memory-readings.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { withMemory } from '../../cli/memory-command.ts';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, resolveCanonicalMemoryDbPath } from '@goodvibes-jev/engine/platform/platform/state';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

useMemoryReadings();

const roots: string[] = [];
const originalFetch = globalThis.fetch;
beforeEach(() => {
  // No daemon answers the wire probe, so every command takes the local path.
  globalThis.fetch = mockFetch(async () => { throw new Error('network disabled'); });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = makeProjectTempDir('goodvibes-agent-memory-handoff');
  roots.push(root);
  return root;
}

async function runCli(args: readonly string[], root: string): Promise<{ readonly exitCode: number; readonly output: string }> {
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'agent' }),
      workingDirectory: root,
      homeDirectory: root,
    });
    return { exitCode: result.exitCode, output: output.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

describe('memory handoff', () => {
  test('inspecting a bundle that does not exist answers with a failure envelope', async () => {
    const root = freshRoot();
    const result = await runCli(['memory', 'handoff-inspect', 'missing.json', '--json'], root);
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.output) as { readonly ok: boolean; readonly kind: string };
    expect(body.ok).toBe(false);
    expect(body.kind).toBe('agent.memory.error');
  });

  test('exporting more than 200 records carries every one of them', async () => {
    const root = freshRoot();
    const configManager = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'agent' });
    const store = new MemoryStore(resolveCanonicalMemoryDbPath(root), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    await store.init();
    try {
      const registry = new MemoryRegistry(store);
      for (let index = 0; index < 205; index += 1) {
        await registry.add({ scope: 'project', cls: 'fact', summary: `Handoff record number ${index}`, tags: [] });
      }
      await store.save();
    } finally {
      store.close();
    }
    const result = await runCli(['memory', 'export', 'bundle.json', '--yes'], root);
    expect(result.exitCode).toBe(0);
    const bundle = JSON.parse(readFileSync(join(root, 'bundle.json'), 'utf8')) as { readonly recordCount: number; readonly records: readonly unknown[] };
    expect(bundle.recordCount).toBe(205);
    expect(bundle.records).toHaveLength(205);
  });
});

describe('memory store handle', () => {
  async function writeFromAnotherProcess(root: string): Promise<void> {
    const configManager = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'agent' });
    const other = new MemoryStore(resolveCanonicalMemoryDbPath(root), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }) });
    await other.init();
    try {
      await new MemoryRegistry(other).add({ scope: 'project', cls: 'fact', summary: 'Written by the daemon meanwhile', tags: [] });
      await other.save();
    } finally {
      other.close();
    }
  }

  function runtimeFor(root: string) {
    return {
      cli: parseGoodVibesCli(['memory', 'list']),
      configManager: new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'agent' }),
      workingDirectory: root,
      homeDirectory: root,
    };
  }

  test('a read-only command keeps its answer when another process writes the file meanwhile', async () => {
    const root = freshRoot();
    const answer = await withMemory(runtimeFor(root), async () => {
      await writeFromAnotherProcess(root);
      return 'listed';
    }, { save: false });
    expect(answer).toBe('listed');
  });

  test('a command that changes memory refuses to overwrite the other process and says to rerun', async () => {
    const root = freshRoot();
    await expect(withMemory(runtimeFor(root), async () => {
      await writeFromAnotherProcess(root);
      return 'added';
    }, { save: true })).rejects.toMatchObject({ name: 'MemoryStoreChangedOnDiskError' });
  });
});

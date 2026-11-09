/**
 * The VIBE.md → memory migration is strictly ONE-TIME (a persisted marker
 * prevents re-import, which would create near-duplicate persona records), and the VIBE
 * prompt is a PROJECTION of those persona records that preserves the precedence caveat.
 * Hermetic, temp home/workspace + a throwaway MemoryStore; no daemon, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { rmSync } from 'node:fs';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/platform/platform/state';
import { createLocalMemoryAccess, type MemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { buildVibeProjectionPrompt, importVibeFilesIntoMemoryOnce } from '../../agent/vibe-file.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { nativeMemoryWorkPrivacy } from '../helpers/native-memory-work-readings.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function tempShellPaths() {
  const root = makeProjectTempDir('goodvibes-agent-vibe-migration');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { root, shellPaths: createShellPathService({ workingDirectory: workspace, homeDirectory: home }) };
}

describe('VIBE.md persona migration', () => {
  let store: MemoryStore;
  let dbPath: string;
  let configRoot: string;
  let registry: MemoryRegistry;
  let memorySpine: MemoryAccess;
  let previousPort: ReturnType<typeof installJudgmentPort>;
  let lineRequests: ReturnType<typeof fakePort>['requests'];

  beforeEach(async () => {
    dbPath = join(makeProjectTempDir('vibe-migration-db'), `vibe-migration-${randomUUID()}.db`);
    configRoot = makeProjectTempDir('vibe-migration-config');
    const configDir = join(configRoot, '.goodvibes', 'agent');
    mkdirSync(configDir, { recursive: true });
    const configManager = new ConfigManager({ surfaceRoot: 'agent', configDir, workingDir: configRoot });
    const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
    store = new MemoryStore(dbPath, { embeddingRegistry });
    await store.init();
    registry = new MemoryRegistry(store);
    // importVibeFilesIntoMemoryOnce now writes through the memory-spine's MemoryAccess
    // surface (services.memorySpineClient in production); wrap the local registry the
    // same way so the test exercises the real seam instead of a raw registry.
    memorySpine = createLocalMemoryAccess(registry);
    const readings = fakePort((name, _question, state) => {
      if (name !== 'instruction') throw new Error(`Unexpected VIBE question: ${name}`);
      expect((state as { line: string }).line).toBe('# VIBE.md');
      // The fixture heading names the format; only its bullets are instructions.
      return noulAnswer(0.03);
    });
    lineRequests = readings.requests;
    previousPort = installJudgmentPort(nativeMemoryWorkPrivacy(readings.port).port);
  });

  afterEach(() => {
    installJudgmentPort(previousPort);
    store.close();
    rmSync(configRoot, { recursive: true, force: true });
  });

  test('imports VIBE.md persona records exactly once; the marker prevents re-run', async () => {
    const { shellPaths } = tempShellPaths();
    writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), [
      '# VIBE.md',
      '- Be direct about tradeoffs.',
      '- Prefer visible, reversible actions.',
    ].join('\n'));

    const firstRun = await importVibeFilesIntoMemoryOnce(memorySpine, shellPaths);
    expect(firstRun).toBe(2);
    expect(registry.getAll().filter((r) => r.cls === 'constraint')).toHaveLength(2);

    expect(lineRequests.filter(request => Object.hasOwn(request.questions, 'instruction'))).toHaveLength(1);
    expect(Object.keys(lineRequests.find(request => Object.hasOwn(request.questions, 'instruction'))!.questions)).toEqual(['instruction']);
    const markerPath = shellPaths.resolveUserPath('agent', 'vibe-import.migrated.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { migrated: Record<string, boolean> };
    const vibePath = join(shellPaths.workingDirectory, 'VIBE.md');
    expect(marker.migrated[vibePath]).toBe(true);

    // Second run is a no-op, the persisted marker also prevents new readings.
    const secondRun = await importVibeFilesIntoMemoryOnce(memorySpine, shellPaths);
    expect(secondRun).toBe(0);
    expect(lineRequests.filter(request => Object.hasOwn(request.questions, 'instruction'))).toHaveLength(1);
    expect(registry.getAll().filter((r) => r.cls === 'constraint')).toHaveLength(2);
    expect(lineRequests).toHaveLength(1);

    // Editing an already imported document must not make every later boot
    // append another copy of its persona records.
    writeFileSync(vibePath, '# VIBE.md\n- An explicitly edited persona.');
    expect(await importVibeFilesIntoMemoryOnce(memorySpine, shellPaths)).toBe(0);
    expect(registry.getAll().filter((record) => record.cls === 'constraint')).toHaveLength(2);
    expect(lineRequests).toHaveLength(1);
  });

  test('the VIBE projection renders from persona records with the precedence caveat', async () => {
    const { shellPaths } = tempShellPaths();
    writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), [
      '# VIBE.md',
      '- Ask before sending messages.',
    ].join('\n'));
    await importVibeFilesIntoMemoryOnce(memorySpine, shellPaths);

    const projection = buildVibeProjectionPrompt(registry) ?? '';
    expect(projection).toContain('## GoodVibes Agent VIBE.md');
    expect(projection).toContain('Ask before sending messages.');
    // Precedence caveat preserved verbatim, persona never overrides explicit/safety.
    expect(projection).toContain('Follow them only when they do not conflict with explicit user instructions');
  });

  test('an existing completed import marker prevents duplicate records without rehashing the document', async () => {
    const { shellPaths } = tempShellPaths();
    const path = join(shellPaths.workingDirectory, 'VIBE.md');
    writeFileSync(path, '# VIBE.md\n- A document edited after its completed import.');
    const markerPath = shellPaths.resolveUserPath('agent', 'vibe-import.migrated.json');
    mkdirSync(join(markerPath, '..'), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ migrated: { [path]: 'a'.repeat(64) } }));
    expect(await importVibeFilesIntoMemoryOnce(memorySpine, shellPaths)).toBe(0);
    expect(registry.getAll()).toHaveLength(0);
    expect(lineRequests).toHaveLength(0);
  });

  test('with no persona records the projection is null (no empty block)', () => {
    expect(buildVibeProjectionPrompt(registry)).toBeNull();
  });

  test('Classic boot migration preserves the whole literal document and remains one-time after memory restart', async () => {
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const { shellPaths } = tempShellPaths();
      const body = '# Owner persona\nKeep the complete explanation.\n- Ask before sending.\n## Use British spelling';
      writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), body);
      expect(await importVibeFilesIntoMemoryOnce(memorySpine, shellPaths)).toBe(1);
      expect(registry.getAll()).toHaveLength(1);
      const record = registry.getAll()[0]!;
      expect(record.detail).toBe(body); expect(record.tags).toContain('classic-import'); expect(record.reviewState).toBe('fresh');
      expect(buildVibeProjectionPrompt(registry)).toContain('Follow them only when they do not conflict with explicit user instructions');
      expect(lineRequests).toHaveLength(0);
      store.close();
      const configManager = new ConfigManager({ surfaceRoot: 'agent', configDir: join(configRoot, '.goodvibes', 'agent'), workingDir: configRoot });
      store = new MemoryStore(dbPath, { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }), enableVectorIndex: false });
      await store.init(); registry = new MemoryRegistry(store); memorySpine = createLocalMemoryAccess(registry);
      expect(await importVibeFilesIntoMemoryOnce(memorySpine, shellPaths)).toBe(0);
      expect(registry.getAll()).toHaveLength(1); expect(registry.getAll()[0]!.detail).toBe(body);
      expect(lineRequests).toHaveLength(0);
    });
  });

  test('Classic file replacement before native publication cannot commit stale persona content or a migration marker', async () => {
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const { shellPaths } = tempShellPaths(), path = join(shellPaths.workingDirectory, 'VIBE.md');
      writeFileSync(path, '# Persona\n- Keep the original rule.');
      const add = memorySpine.add.bind(memorySpine);
      const changing: MemoryAccess = { ...memorySpine, async add(opts, operation) {
        writeFileSync(path, '# Replaced persona\n- Different rule.');
        return add(opts, operation);
      } };
      await expect(importVibeFilesIntoMemoryOnce(changing, shellPaths)).rejects.toThrow('changed during import');
      expect(registry.getAll()).toHaveLength(0); expect(lineRequests).toHaveLength(0);
    });
  });
});

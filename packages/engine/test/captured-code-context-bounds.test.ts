/** Preparation bounds of the per-run captured code source: over budget means no code context, never a failed run. */
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapturedCodeContext } from '../platform/src/platform/agents/captured-code-context.js';
import { captureContractInput, materializeContractInput, contractInputPath } from '../platform/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority } from '../platform/src/platform/contract/input-authority.js';
import type { Contract } from '../platform/src/platform/contract/types.js';
import { ConfigManager } from '../platform/src/platform/config/index.js';
import { MemoryEmbeddingProviderRegistry, type MemoryEmbeddingRequest } from '../platform/src/platform/state/memory-embeddings.js';

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

async function withTree(
  populate: (root: string) => void,
  run: (context: { source: ReturnType<typeof createCapturedCodeContext>; calls: MemoryEmbeddingRequest[] }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'captured-code-bounds-'));
  const stop = new AbortController();
  let dispose: (() => void) | undefined;
  try {
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    populate(root);
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
    const receipt = await captureContractInput(root);
    const view = contractInputPath(receipt);
    git(root, 'worktree', 'add', '--no-checkout', '-b', 'bounds-view', view, receipt.inputCommit);
    await materializeContractInput(receipt, view);
    const authority = await createContractInputAuthority({ inputSnapshot: receipt, projectRoot: root } as Contract, view,
      { mutable: true, branch: 'bounds-view', signal: stop.signal });
    const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
    const calls: MemoryEmbeddingRequest[] = [];
    const registry = new MemoryEmbeddingProviderRegistry({ configManager: config });
    registry.register({ id: 'bounds-semantic', label: 'Synthetic provider', dimensions: 384, capturedInputAdmission: 'per-attempt', async embed(request) {
      calls.push(request); await request.beforeAttempt?.();
      const vector = new Float32Array(384); vector[0] = 1;
      return { vector, dimensions: 384 };
    } }, { makeDefault: true });
    const source = createCapturedCodeContext({ authority, root: view, registry, readAccessFilter: async () => true, signal: stop.signal });
    dispose = () => source.dispose?.();
    await run({ source, calls });
  } finally { dispose?.(); stop.abort(); rmSync(root, { recursive: true, force: true }); }
}

test('a file over the per-file size is left out while the rest is indexed', async () => withTree(
  (root) => {
    writeFileSync(join(root, 'small.txt'), 'SMALL_FILE_MARKER');
    writeFileSync(join(root, 'big.txt'), 'BIG_FILE_MARKER '.repeat(20_000));
  },
  async ({ source, calls }) => {
    await source.prepare?.();
    expect(source.stats().available).toBe(true);
    expect(calls.some((call) => call.text.includes('SMALL_FILE_MARKER'))).toBe(true);
    expect(calls.some((call) => call.text.includes('BIG_FILE_MARKER'))).toBe(false);
  },
), 60_000);

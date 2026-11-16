// ---------------------------------------------------------------------------
// image-runtime.test.ts, /imagine
//
// Command-layer test: fake MediaProviderRegistry + ArtifactStore on
// ctx.platform (no real network calls; images are written under a temporary
// working directory and no viewer is opened),
// following the project's existing runtime-command test pattern (see
// workstream-runtime-command.test.ts's makeCtx()). Exercises: the
// providers/store-absent guard, empty-prompt usage message, honest
// unconfigured-provider status rendering, the inline-bytes persistence path,
// the remote-reference (no eager download) path, and honest failure
// rendering when generate() throws.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerImageRuntimeCommands } from '../../input/commands/image-runtime.ts';
import { withPublicErrorText } from '../helpers/user-error-reading.ts';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

interface FakeGenerateResult {
  providerId: string;
  artifacts: Array<{ mimeType: string; dataBase64?: string; uri?: string; filename?: string; metadata: Record<string, unknown> }>;
  metadata: Record<string, unknown>;
}

function makeFakeProvider(options: {
  label?: string;
  generateResult?: FakeGenerateResult;
  throwError?: Error;
} = {}) {
  const calls: unknown[] = [];
  return {
    id: 'fake-gen',
    label: options.label ?? 'Fake Generator',
    capabilities: ['generate'] as const,
    generate: async (request: unknown) => {
      calls.push(request);
      if (options.throwError) throw options.throwError;
      return options.generateResult ?? {
        providerId: 'fake-gen',
        artifacts: [{ mimeType: 'image/png', dataBase64: 'ZmFrZS1ieXRlcw==', filename: 'out.png', metadata: {} }],
        metadata: {},
      };
    },
    calls,
  };
}

function makeFakeMediaProviders(provider: ReturnType<typeof makeFakeProvider> | null, statuses: Array<{ id: string; label: string; state: string; capabilities: string[]; configured: boolean; detail?: string; metadata?: Record<string, unknown> }> = []) {
  return {
    resolveProvider: async (_capability: string) => provider,
    get: (_id: string) => provider,
    status: async () => statuses.map((status) => ({ metadata: {}, ...status })),
  };
}

function makeFakeArtifactStore() {
  const created: Array<Record<string, unknown>> = [];
  let nextId = 1;
  return {
    created,
    readContent: async (_id: string) => ({ buffer: Buffer.from('remote-bytes') }),
    create: async (input: Record<string, unknown>) => {
      created.push(input);
      const id = `artifact-${nextId++}`;
      return {
        id,
        kind: 'file',
        mimeType: input['mimeType'] as string,
        filename: input['filename'] as string | undefined,
        sizeBytes: typeof input['dataBase64'] === 'string' ? Buffer.from(input['dataBase64'] as string, 'base64').length : (input['text'] as string | undefined)?.length ?? 0,
        sha256: 'fake-sha',
        createdAt: Date.now(),
        acquisitionMode: 'inline-data',
        fetchMode: 'not-applicable',
        metadata: input['metadata'] ?? {},
      };
    },
  };
}

function makeCtx(mediaProviders?: ReturnType<typeof makeFakeMediaProviders>, artifactStore?: ReturnType<typeof makeFakeArtifactStore>) {
  const printed: string[] = [];
  const root = makeProjectTempDir('gv-imagine');
  const ctx = {
    print: (text: string) => { printed.push(text); },
    session: {},
    workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
    provider: {},
    platform: { mediaProviders, artifactStore },
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed, root };
}

describe('/imagine: honest degradation', () => {
  test('prints an honest message when mediaProviders/artifactStore are not available', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry, { openFile: async () => false });
    const { ctx, printed } = makeCtx(undefined, undefined);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    expect(printed).toEqual(['Image generation is not available in this session.']);
  });

  test('prints the registry\'s own per-provider status when no generate-capable provider is found', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry, { openFile: async () => false });
    const mediaProviders = makeFakeMediaProviders(null, [
      { id: 'byteplus', label: 'BytePlus', state: 'unconfigured', capabilities: ['generate'], configured: false, detail: 'Set BYTEPLUS_API_KEY to enable BytePlus video generation.' },
      { id: 'fal', label: 'fal', state: 'unconfigured', capabilities: ['generate'], configured: false, detail: 'Set FAL_KEY or FAL_API_KEY to enable fal generation.' },
    ]);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    const text = printed.join('\n');
    expect(text).toContain('byteplus (BytePlus): unconfigured');
    expect(text).toContain('Set BYTEPLUS_API_KEY to enable BytePlus video generation.');
    expect(text).toContain('fal (fal): unconfigured');
    expect(text).toContain('Set FAL_KEY or FAL_API_KEY to enable fal generation.');
  });

  test('states plainly when no media-generation providers are registered at all', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry, { openFile: async () => false });
    const mediaProviders = makeFakeMediaProviders(null, []);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    expect(printed.join('\n')).toContain('No media-generation providers are registered in this build.');
  });

  test('renders a failure message from a thrown error', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry, { openFile: async () => false });
    const provider = makeFakeProvider({ throwError: new Error('provider API rejected the request') });
    const mediaProviders = makeFakeMediaProviders(provider);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await withPublicErrorText(['provider API rejected the request'], () => registry.execute('imagine', ['a', 'cat'], ctx));

    expect(provider.calls).toHaveLength(1);
    expect(artifactStore.created).toEqual([]);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('Image generation failed:');
    expect(printed[0]).toContain('provider API rejected the request');
  });

  test('a provider failure never prints the credential it echoes and cannot store an artifact', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry, { openFile: async () => false });
    const provider = makeFakeProvider({ throwError: new Error('Bearer synthetic-private-provider-token') });
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(makeFakeMediaProviders(provider), artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    expect(provider.calls).toHaveLength(1);
    expect(artifactStore.created).toEqual([]);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toStartWith('Image generation failed:');
    expect(printed[0]).not.toContain('synthetic-private-provider-token');
    expect(printed.join('\n')).not.toContain('Generated');
  });
});

describe('/imagine: success paths', () => {
  test('persists an inline-bytes artifact and renders its id', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry, { openFile: async () => false });
    const provider = makeFakeProvider();
    const mediaProviders = makeFakeMediaProviders(provider);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed, root } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat', 'wearing', 'a', 'hat'], ctx);

    expect(provider.calls).toHaveLength(1);
    expect((provider.calls[0] as { prompt: string }).prompt).toBe('a cat wearing a hat');
    expect(artifactStore.created).toHaveLength(1);
    expect(artifactStore.created[0]!['dataBase64']).toBe('ZmFrZS1ieXRlcw==');
    const text = printed.join('\n');
    expect(text).toContain('Generated 1 artifact(s) via Fake Generator (fake-gen)');
    expect(text).toContain('saved: generated/a-cat-wearing-a-hat-');
    expect(text).toContain('artifact artifact-1');
    const saved = readdirSync(join(root, 'generated'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEndWith('.png');
  });

  test('keeps the bytes of a remote artifact instead of a link that expires', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry, { openFile: async () => false });
    const provider = makeFakeProvider({
      generateResult: {
        providerId: 'fake-gen',
        artifacts: [{ mimeType: 'image/png', uri: 'https://provider.example/out.png', filename: 'out.png', metadata: {} }],
        metadata: {},
      },
    });
    const mediaProviders = makeFakeMediaProviders(provider);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    expect(artifactStore.created).toHaveLength(1);
    const stored = artifactStore.created[0]!;
    expect(stored['uri']).toBe('https://provider.example/out.png');
    expect(stored['fetchMode']).toBe('public-only');
    expect(printed.join('\n')).toContain('artifact artifact-1');
  });

  test('notes honestly when the found provider produced a non-image artifact', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry, { openFile: async () => false });
    const provider = makeFakeProvider({
      label: 'BytePlus',
      generateResult: {
        providerId: 'byteplus',
        artifacts: [{ mimeType: 'video/mp4', dataBase64: 'ZmFrZQ==', filename: 'out.mp4', metadata: {} }],
        metadata: {},
      },
    });
    const mediaProviders = makeFakeMediaProviders(provider);
    const artifactStore = makeFakeArtifactStore();
    const { ctx, printed } = makeCtx(mediaProviders, artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    const text = printed.join('\n');
    expect(text).toContain('BytePlus produced video/mp4, not an image');
  });
});

describe('/imagine: partial storage', () => {
  test('a storage failure on the second artifact still reports the first and counts what was kept', async () => {
    const registry = new CommandRegistry();
    registerImageRuntimeCommands(registry, { openFile: async () => false });
    const provider = makeFakeProvider({
      generateResult: {
        providerId: 'fake-gen',
        artifacts: [
          { mimeType: 'image/png', dataBase64: 'ZmFrZS1ieXRlcw==', filename: 'one.png', metadata: {} },
          { mimeType: 'image/png', dataBase64: 'ZmFrZS1ieXRlcw==', filename: 'two.png', metadata: {} },
        ],
        metadata: {},
      },
    });
    const artifactStore = makeFakeArtifactStore();
    const realCreate = artifactStore.create;
    let calls = 0;
    artifactStore.create = async (input: Record<string, unknown>) => {
      calls += 1;
      if (calls === 2) throw new Error('disk full');
      return realCreate(input);
    };
    const { ctx, printed } = makeCtx(makeFakeMediaProviders(provider), artifactStore);

    await registry.execute('imagine', ['a', 'cat'], ctx);

    const text = printed.join('\n');
    expect(text).toContain('artifact artifact-1');
    expect(text).toContain('artifact 2: could not be stored');
    expect(text).toContain('1 of 2 artifact(s) were stored');
    expect(text).not.toContain('Image generation failed');
  });
});

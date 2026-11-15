import { describe, expect, test } from 'bun:test';
import type { ArtifactCreateInput, ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { MediaProviderRegistry } from '@goodvibes-jev/engine/platform/platform/media';
import { generateAgentMedia } from '../../agent/media-generation.ts';

function registryWithOneImage(): MediaProviderRegistry {
  const registry = new MediaProviderRegistry();
  registry.register({
    id: 'gen',
    label: 'Generator',
    capabilities: ['generate'],
    generate: async () => ({
      providerId: 'gen',
      artifacts: [{ mimeType: 'image/png', uri: 'http://10.0.0.5/x.png', metadata: {} }],
      metadata: {},
    }),
  });
  return registry;
}

const input = { prompt: 'A hero image', providerId: 'gen' } as const;

describe('Agent media generation when an artifact write fails', () => {
  test('the refusal reason reaches the caller so a permanent refusal is not retried blindly', async () => {
    const store = { create: async (_input: ArtifactCreateInput): Promise<ArtifactDescriptor> => { throw new Error('refused: non-public address'); } };
    await expect(generateAgentMedia(registryWithOneImage(), store, input)).rejects.toThrow(/after 0 confirmed artifact writes \(refused: non-public address\)/);
  });

  test('an abort during the write propagates as the abort, not as a generic write failure', async () => {
    const controller = new AbortController();
    const store = {
      create: async (_input: ArtifactCreateInput): Promise<ArtifactDescriptor> => {
        controller.abort(new Error('turn cancelled'));
        throw new Error('write interrupted');
      },
    };
    const error = await generateAgentMedia(registryWithOneImage(), store, input, { signal: controller.signal }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('turn cancelled');
  });
});

import type { CommandRegistry } from '../command-registry.ts';
import type { MediaGenerationResult, MediaProviderTask } from '@goodvibes-jev/engine/platform/platform/media';
import { redactSensitiveDataAsync, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

const USAGE = 'Usage: /imagine <prompt>  |  /imagine --collect <provider> <task-id> [key=value ...]';

function collectCommand(task: MediaProviderTask): string {
  const resume = Object.entries(task.resume ?? {}).map(([key, value]) => ` ${key}=${value}`).join('');
  return `/imagine --collect ${task.providerId} ${task.taskId}${resume}`;
}

/**
 * registerImageRuntimeCommands - `/imagine <prompt>`.
 *
 * Named 'imagine', not 'image': `/image <path> [prompt]` (local-runtime.ts)
 * attaches a local image file to the next message.
 *
 * The provider is chosen among those that make images, so a configured video
 * provider is never sent an image request. When none is configured the command
 * prints the registry's own per-provider status, whose detail strings name each
 * provider's key, so this command never names one itself. A job still running
 * when the wait ends is reported with the command that collects it later.
 */
export function registerImageRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'imagine',
    description: 'Generate an image from a prompt via a configured media provider',
    usage: '<prompt> | --collect <provider> <task-id> [key=value ...]',
    argsHint: '<prompt>',
    async handler(args, ctx) {
      const mediaProviders = ctx.platform.mediaProviders;
      const artifactStore = ctx.platform.artifactStore;
      if (!mediaProviders || !artifactStore) {
        ctx.print('Image generation is not available in this session.');
        return;
      }

      let result: MediaGenerationResult;
      let label: string;
      if (args[0] === '--collect') {
        const [, providerId, taskId, ...pairs] = args;
        if (!providerId || !taskId) {
          ctx.print(USAGE);
          return;
        }
        const resume = Object.fromEntries(pairs.flatMap((pair) => {
          const at = pair.indexOf('=');
          return at > 0 ? [[pair.slice(0, at), pair.slice(at + 1)]] : [];
        }));
        label = mediaProviders.get(providerId)?.label ?? providerId;
        try {
          result = await mediaProviders.collect({ providerId, taskId, resume });
        } catch (error) {
          ctx.print(`Collecting ${providerId} task ${taskId} failed: ${await redactSensitiveDataAsync(summarizeError(error))}`);
          return;
        }
      } else {
        const prompt = args.join(' ').trim();
        if (!prompt) {
          ctx.print(USAGE);
          return;
        }
        const provider = await mediaProviders.resolveProvider('generate', undefined, { output: 'image' });
        if (!provider?.generate) {
          const statuses = await mediaProviders.status();
          const generationStatuses = statuses.filter((status) => status.capabilities.includes('generate'));
          const lines = ['No configured provider makes images.', ''];
          if (generationStatuses.length === 0) {
            lines.push('No media-generation providers are registered in this build.');
          } else {
            for (const status of generationStatuses) {
              const outputs = Array.isArray(status.metadata['outputs']) ? ` [makes ${(status.metadata['outputs'] as unknown[]).join(', ')}]` : '';
              lines.push(`  ${status.id} (${status.label})${outputs}: ${status.state}${status.detail ? `; ${status.detail}` : ''}`);
            }
          }
          ctx.print(lines.join('\n'));
          return;
        }
        label = provider.label;
        try {
          result = await provider.generate({
            prompt,
            outputMimeType: 'image/png',
            metadata: { source: 'tui-image-command' },
          });
        } catch (error) {
          // A provider can echo the request's Authorization value in its error body.
          ctx.print(`Image generation failed: ${await redactSensitiveDataAsync(summarizeError(error))}`);
          return;
        }
      }

      if (result.pending) {
        ctx.print([
          `${label} accepted the job (task ${result.pending.taskId}) and is still generating it; it is paid for and keeps running.`,
          `Collect it with: ${collectCommand(result.pending)}`,
        ].join('\n'));
        return;
      }
      if (result.artifacts.length === 0) {
        ctx.print(`${label} returned no artifacts for this prompt.`);
        return;
      }

      // The provider has produced (and may have charged for) every artifact by now, so a
      // failure to keep one must not hide the others: each is stored on its own and reported.
      const lines = [`Generated ${result.artifacts.length} artifact(s) via ${label} (${result.providerId}).`];
      let storeFailures = 0;
      for (const [index, artifact] of result.artifacts.entries()) {
        if (!artifact.mimeType.startsWith('image/')) {
          lines.push(`  Note: ${label} produced ${artifact.mimeType}, not an image.`);
        }
        try {
          if (artifact.artifactId && typeof artifact.sizeBytes === 'number') {
            // Built-in providers stream their outputs into the artifact store themselves.
            lines.push(`  artifact: ${artifact.artifactId} (${artifact.mimeType}, ${artifact.sizeBytes} bytes)`);
          } else if (artifact.dataBase64) {
            const descriptor = await artifactStore.create({
              dataBase64: artifact.dataBase64,
              mimeType: artifact.mimeType,
              filename: artifact.filename ?? 'generated-image',
              metadata: { ...artifact.metadata, generatedBy: result.providerId },
            });
            lines.push(`  artifact: ${descriptor.id} (${descriptor.mimeType}, ${descriptor.sizeBytes} bytes)`);
          } else if (artifact.uri) {
            // A provider-hosted link expires, so the bytes are kept: the store fetches public addresses only.
            const descriptor = await artifactStore.create({
              uri: artifact.uri,
              sourceUri: artifact.uri,
              mimeType: artifact.mimeType,
              filename: artifact.filename ?? 'generated-image',
              acquisitionMode: 'remote-fetch',
              fetchMode: 'public-only',
              metadata: { ...artifact.metadata, generatedBy: result.providerId },
            });
            lines.push(`  artifact: ${descriptor.id} (${descriptor.mimeType}, ${descriptor.sizeBytes} bytes)`);
          } else {
            lines.push('  artifact: (no retrievable content returned)');
          }
        } catch (error) {
          storeFailures += 1;
          lines.push(`  artifact ${index + 1}: could not be stored (${await redactSensitiveDataAsync(summarizeError(error))})${artifact.uri ? `; provider url: ${artifact.uri}` : ''}`);
        }
      }
      if (storeFailures > 0) {
        lines.push(`${result.artifacts.length - storeFailures} of ${result.artifacts.length} artifact(s) were stored; the rest were generated but not kept.`);
      }
      ctx.print(lines.join('\n'));
    },
  });
}

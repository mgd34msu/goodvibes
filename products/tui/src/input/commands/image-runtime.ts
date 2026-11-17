import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import type { MediaGenerationResult, MediaProviderTask } from '@goodvibes-jev/engine/platform/platform/media';
import { externalUrlLaunchers, redactSensitiveDataAsync, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { tokenizeSlashCommand } from '@goodvibes-jev/engine/terminal-shell/slash-command-parser';

const USAGE = 'Usage: /imagine [--out <path>] <prompt>  |  /imagine [--out <path>] --collect <provider> <task-id> [key=value ...]';

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg',
};

/**
 * The typed line (taken whole, as typed) as words for `--out`/`--collect` and
 * the prompt: a leading `--out <path>` (quoted when it has spaces) is read off
 * the front, `--collect` words are fields, and anything else is the prompt,
 * kept exactly as typed.
 */
export function readImagineLine(raw: string): { readonly out?: string; readonly rest: readonly string[] } | null {
  let text = raw.trim();
  let out: string | undefined;
  const flag = /^--out(?:=|\s+)("([^"]*)"|'([^']*)'|(\S+))(?:\s+|$)/.exec(text);
  if (/^--out(?:=|\s|$)/.test(text)) {
    if (!flag) return null;
    out = flag[2] ?? flag[3] ?? flag[4] ?? '';
    if (!out || out.startsWith('--')) return null;
    text = text.slice(flag[0].length);
  }
  const rest = text.startsWith('--collect') ? tokenizeSlashCommand(text) : text ? [text] : [];
  return { ...(out === undefined ? {} : { out }), rest };
}

/** `--out <path>` or `--out=<path>` at the front of the line, and the rest. */
export function readImagineOut(args: readonly string[]): { readonly out?: string; readonly rest: readonly string[] } | null {
  const first = args[0];
  if (first === '--out') return args[1] && !args[1].startsWith('--') ? { out: args[1], rest: args.slice(2) } : null;
  if (first?.startsWith('--out=')) return first.length > 6 ? { out: first.slice(6), rest: args.slice(1) } : null;
  return { rest: args };
}

/** The file for artifact `index` of `count`: the given path (numbered after the first), or generated/<words>-<time>.<ext>. */
export function imageFilePath(workingDirectory: string, prompt: string, mimeType: string, index: number, count: number, out: string | undefined, now = new Date()): string {
  const extension = EXTENSION_BY_MIME[mimeType] ?? '.bin';
  const suffix = count > 1 && index > 0 ? `-${index + 1}` : '';
  if (out) {
    const given = extname(out);
    return `${given ? out.slice(0, -given.length) : out}${suffix}${given || extension}`;
  }
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'image';
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return join(workingDirectory, 'generated', `${words}-${stamp}${count > 1 ? `-${index + 1}` : ''}${extension}`);
}

/** Ask the system viewer to open a file; false where there is no desktop to show it on. */
function openInViewer(path: string): Promise<boolean> {
  if (process.platform === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY'] && !process.env['WSL_DISTRO_NAME']) {
    return Promise.resolve(false);
  }
  const [launcher] = externalUrlLaunchers(path, process.platform, Boolean(process.env['WSL_DISTRO_NAME']));
  if (!launcher) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(launcher.command, [...launcher.args], { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

function collectCommand(task: MediaProviderTask): string {
  const resume = Object.entries(task.resume ?? {}).map(([key, value]) => ` ${key}=${value}`).join('');
  return `/imagine --collect ${task.providerId} ${task.taskId}${resume}`;
}

/**
 * registerImageRuntimeCommands - `/imagine [--out <path>] <prompt>`.
 *
 * The picture is written to a file (the given path, or
 * `generated/<prompt words>-<time>.<ext>` under the working directory; an
 * existing file is never replaced), the path is printed, and the system viewer
 * opens it where there is a desktop. The artifact store keeps a second copy.
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
export function registerImageRuntimeCommands(
  registry: CommandRegistry,
  options: { readonly openFile?: (path: string) => Promise<boolean> } = {},
): void {
  const openFile = options.openFile ?? openInViewer;
  registry.register({
    name: 'imagine',
    description: 'Generate an image from a prompt via a configured media provider',
    usage: '[--out <path>] <prompt> | [--out <path>] --collect <provider> <task-id> [key=value ...]',
    argsHint: '<prompt>',
    // The prompt is sent as typed; readImagineLine reads --out and --collect off the front.
    rawRest: 0,
    async handler(args, ctx) {
      const mediaProviders = ctx.platform.mediaProviders;
      const artifactStore = ctx.platform.artifactStore;
      if (!mediaProviders || !artifactStore) {
        ctx.print('Image generation is not available in this session.');
        return;
      }

      const line = readImagineLine(args.join(' '));
      if (!line) {
        ctx.print(`--out needs a file path. ${USAGE}`);
        return;
      }
      const shellPaths = requireShellPaths(ctx);
      let result: MediaGenerationResult;
      let label: string;
      let prompt = 'image';
      if (line.rest[0] === '--collect') {
        const [, providerId, taskId, ...pairs] = line.rest;
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
        prompt = line.rest.join(' ').trim();
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
          `Collect it with: ${line.out ? collectCommand(result.pending).replace('/imagine ', `/imagine --out ${line.out} `) : collectCommand(result.pending)}`,
        ].join('\n'));
        return;
      }
      if (result.artifacts.length === 0) {
        ctx.print(`${label} returned no artifacts for this prompt.`);
        return;
      }

      // The provider has produced (and may have charged for) every artifact by now, so a
      // failure to keep one must not hide the others: each is stored and written on its own and reported.
      const lines = [`Generated ${result.artifacts.length} artifact(s) via ${label} (${result.providerId}).`];
      const count = result.artifacts.length;
      let storeFailures = 0;
      const written: string[] = [];
      for (const [index, artifact] of result.artifacts.entries()) {
        if (!artifact.mimeType.startsWith('image/')) {
          lines.push(`  Note: ${label} produced ${artifact.mimeType}, not an image.`);
        }
        let artifactId: string | undefined;
        let bytes: Buffer | undefined;
        try {
          if (artifact.artifactId && typeof artifact.sizeBytes === 'number') {
            // Built-in providers stream their outputs into the artifact store themselves.
            artifactId = artifact.artifactId;
          } else if (artifact.dataBase64) {
            const descriptor = await artifactStore.create({
              dataBase64: artifact.dataBase64,
              mimeType: artifact.mimeType,
              filename: artifact.filename ?? 'generated-image',
              metadata: { ...artifact.metadata, generatedBy: result.providerId },
            });
            artifactId = descriptor.id;
            bytes = Buffer.from(artifact.dataBase64, 'base64');
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
            artifactId = descriptor.id;
          } else {
            lines.push('  artifact: (no retrievable content returned)');
            continue;
          }
        } catch (error) {
          storeFailures += 1;
          lines.push(`  artifact ${index + 1}: could not be stored (${await redactSensitiveDataAsync(summarizeError(error))})${artifact.uri ? `; provider url: ${artifact.uri}` : ''}`);
          continue;
        }
        if (!bytes) {
          try {
            bytes = (await artifactStore.readContent(artifactId)).buffer;
          } catch (error) {
            lines.push(`  artifact ${artifactId} (${artifact.mimeType}) is stored, but could not be read back to save a file: ${summarizeError(error)}`);
            continue;
          }
        }
        const target = line.out
          ? imageFilePath(shellPaths.workingDirectory, prompt, artifact.mimeType, index, count, shellPaths.resolveWorkspacePath(line.out))
          : imageFilePath(shellPaths.workingDirectory, prompt, artifact.mimeType, index, count, undefined);
        const shown = relative(shellPaths.workingDirectory, target).startsWith('..') ? target : relative(shellPaths.workingDirectory, target);
        try {
          await mkdir(dirname(target), { recursive: true });
          // `wx`: an existing file is never replaced.
          await writeFile(target, bytes, { flag: 'wx' });
          written.push(target);
          lines.push(`  saved: ${shown} (${artifact.mimeType}, ${bytes.byteLength} bytes; artifact ${artifactId})`);
        } catch (error) {
          const exists = (error as NodeJS.ErrnoException).code === 'EEXIST';
          lines.push(`  not saved to ${shown}: ${exists ? 'a file is already there and was left as it is; pick another --out path' : summarizeError(error)}. The image is kept as artifact ${artifactId}.`);
        }
      }
      if (storeFailures > 0) {
        lines.push(`${count - storeFailures} of ${count} artifact(s) were stored; the rest were generated but not kept.`);
      }
      if (written.length > 0) {
        const opened = await openFile(written[0]!);
        lines.push(opened ? `Opened ${written.length > 1 ? 'the first one ' : ''}in the system image viewer.` : 'No image viewer is available here; open the file from the path above.');
      }
      ctx.print(lines.join('\n'));
    },
  });
}

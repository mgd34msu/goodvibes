/**
 * `/media`, described once (command-actions/) for both terminal apps: see the
 * media providers, make an image or a video from a description, and collect a
 * job a provider was still making when the wait ended. What a provider makes
 * is kept in the artifact store and saved as a file (the path given, or
 * `generated/<words of the description>-<time>.<ext>` under the working
 * directory; an existing file is never replaced). Each app supplies its
 * provider registry, artifact store and, where it has a desktop to show it
 * on, a viewer.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import type { MediaProviderRegistry, MediaProviderTask } from '@goodvibes/engine/platform/platform/media';
import { redactSensitiveDataAsync, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { readRefusal } from '@goodvibes/engine/errors';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, InputDescription } from './command-actions/types.js';
import { choiceInput, doAction, readAction, textInput } from './described-command-kit.js';
import { collectMedia, generateMedia, type MediaGenerationRun } from './media-generation.js';

type MediaStore = Pick<ArtifactStore, 'create'> & Partial<Pick<ArtifactStore, 'readContent'>>;

/** Where either app keeps its media provider registry on the command context. */
interface MediaListContext {
  readonly platform: { readonly mediaProviders?: MediaProviderRegistry | undefined; readonly mediaProviderRegistry?: MediaProviderRegistry | undefined };
}

export interface MediaCommandPolicy<Ctx> {
  /** The running program, stamped on what it makes: `goodvibes` or `goodvibes-agent`. */
  readonly product: string;
  readonly registry: (ctx: Ctx) => MediaProviderRegistry | undefined;
  readonly artifactStore: (ctx: Ctx) => MediaStore | undefined;
  readonly paths: (ctx: Ctx) => Pick<ShellPathService, 'workingDirectory' | 'resolveWorkspacePath'>;
  /** Opens a saved file in the system viewer; false where there is none. Absent: the path is printed only. */
  readonly openFile?: ((path: string) => Promise<boolean>) | undefined;
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm',
};

const MIME_BY_KIND: Readonly<Record<string, string>> = { image: 'image/png', video: 'video/mp4' };

/** The file for artifact `index` of `count`: the given path (numbered after the first), or generated/<words>-<time>.<ext>. */
export function mediaFilePath(workingDirectory: string, prompt: string, mimeType: string, index: number, count: number, out: string | undefined, now = new Date()): string {
  const extension = EXTENSION_BY_MIME[mimeType] ?? '.bin';
  const suffix = count > 1 && index > 0 ? `-${index + 1}` : '';
  if (out) {
    const given = extname(out);
    return `${given ? out.slice(0, -given.length) : out}${suffix}${given || extension}`;
  }
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'media';
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return join(workingDirectory, 'generated', `${words}-${stamp}${count > 1 ? `-${index + 1}` : ''}${extension}`);
}

/** The `/media collect` line that finishes a job a provider was still making. */
export function mediaCollectLine(task: MediaProviderTask, out?: string): string {
  const resume = Object.entries(task.resume ?? {}).map(([key, value]) => ` ${key}=${value}`).join('');
  return `/media collect ${task.providerId} ${task.taskId}${out ? ` --out ${out}` : ''}${resume}`;
}

const PROVIDERS = defineList<MediaListContext>({
  name: 'media.providers',
  async read(ctx) {
    const registry = ctx.platform.mediaProviders ?? ctx.platform.mediaProviderRegistry;
    return (registry?.list() ?? []).filter((provider) => provider.capabilities.includes('generate')).map((provider): ListRow => ({
      value: provider.id, label: provider.label, ...(provider.outputs ? { state: `makes ${provider.outputs.join(', ')}` } : {}),
    }));
  },
  operator: { terminalOnly: 'The media providers are the terminal app\'s own.' },
});

const LOCAL = { terminalOnly: 'The media providers are the terminal app\'s own.' } as const;

const OUT: InputDescription = {
  id: 'out', label: 'Save as', help: 'The file to write; a number is added for each further one', kind: 'path', freeTextReason: 'a file path',
  required: { default: '', defaultMeans: 'a new file under generated/ named from the description' }, typed: { flag: '--out' },
};

export function createMediaCommand<Ctx extends CommandActionContext>(policy: MediaCommandPolicy<Ctx>): DescribedCommand<Ctx> {
  const needs = (ctx: Ctx): { registry: MediaProviderRegistry; store: MediaStore } => {
    const registry = policy.registry(ctx);
    if (!registry) throw commandRefusal('Media providers are not available in this session; nothing was made.', undefined, 'UNAVAILABLE');
    const store = policy.artifactStore(ctx);
    if (!store) throw commandRefusal('The artifact store is not available in this session, so nothing made could be kept; nothing was asked for.', undefined, 'UNAVAILABLE');
    return { registry, store };
  };

  /** Each artifact saved as a file next to its stored copy; the first one opened where there is a viewer. */
  const save = async (ctx: Ctx, store: MediaStore, result: MediaGenerationRun, prompt: string, out: string): Promise<string> => {
    if (result.pending) {
      return [
        `${result.pending.providerId} accepted the job (task ${result.pending.taskId}) and is still making it; it is paid for and keeps running.`,
        `Collect it with: ${mediaCollectLine(result.pending, out || undefined)}`,
      ].join('\n');
    }
    const paths = policy.paths(ctx);
    const lines = [`Made ${result.artifacts.length} file${result.artifacts.length === 1 ? '' : 's'} with ${result.providerId}.`];
    const written: string[] = [];
    for (const [index, artifact] of result.artifacts.entries()) {
      if (!store.readContent) {
        lines.push(`  kept as artifact ${artifact.artifactId} (${artifact.mimeType}, ${artifact.sizeBytes} bytes); this session cannot read it back to save a file.`);
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = (await store.readContent(artifact.artifactId)).buffer;
      } catch (error) {
        lines.push(`  artifact ${artifact.artifactId} (${artifact.mimeType}) is kept, but could not be read back to save a file: ${summarizeError(error)}`);
        continue;
      }
      const target = mediaFilePath(paths.workingDirectory, prompt, artifact.mimeType, index, result.artifacts.length, out ? paths.resolveWorkspacePath(out) : undefined);
      const shown = relative(paths.workingDirectory, target).startsWith('..') ? target : relative(paths.workingDirectory, target);
      try {
        await mkdir(dirname(target), { recursive: true });
        // `wx`: an existing file is never replaced.
        await writeFile(target, bytes, { flag: 'wx' });
        written.push(target);
        lines.push(`  saved: ${shown} (${artifact.mimeType}, ${bytes.byteLength} bytes; artifact ${artifact.artifactId})`);
      } catch (error) {
        const exists = (error as NodeJS.ErrnoException).code === 'EEXIST';
        lines.push(`  not saved to ${shown}: ${exists ? 'a file is already there and was left as it is; give another --out path' : summarizeError(error)}. It is kept as artifact ${artifact.artifactId}.`);
      }
    }
    if (written.length > 0 && policy.openFile) {
      const opened = await policy.openFile(written[0]!);
      lines.push(opened ? `Opened ${written.length > 1 ? 'the first one ' : ''}in the system viewer.` : 'No viewer is available here; open the file from the path above.');
    }
    return lines.join('\n');
  };

  /** A provider's error can echo the request's Authorization value: it is redacted before it is shown. */
  const failed = async (what: string, error: unknown): Promise<never> => {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`${what} failed: ${await redactSensitiveDataAsync(summarizeError(error))}`, undefined, 'NOT_DONE');
  };

  return defineCommand<Ctx>({
    name: 'media',
    leadingFlagsOnly: true,
    title: 'Images and video',
    summary: 'Make an image or a video with a configured media provider, and see the providers',
    group: 'Conversation',
    report: 'providers',
    actions: [
      readAction<Ctx>({
        id: 'providers', label: 'See the media providers', word: 'providers', operator: LOCAL,
        sentence: 'Lists the media providers, what each makes, and whether each is set up.',
        async run(_values, ctx) {
          const registry = policy.registry(ctx);
          if (!registry) throw commandRefusal('Media providers are not available in this session.', undefined, 'UNAVAILABLE');
          const statuses = await registry.status();
          if (statuses.length === 0) return 'No media providers are registered in this build.';
          return [
            'Media providers:',
            ...statuses.map((status) => {
              const outputs = Array.isArray(status.metadata['outputs']) ? ` (makes ${(status.metadata['outputs'] as unknown[]).join(', ')})` : '';
              return `  ${status.id}: ${status.state}${status.configured ? '' : ', setup needed'}${outputs}; ${status.capabilities.join(', ')}${status.detail ? `; ${status.detail}` : ''}`;
            }),
          ].join('\n');
        },
      }),
      doAction<Ctx>({
        id: 'make', label: 'Make an image or a video', word: 'make', touches: 'another-machine', risk: 'spends-money', operator: LOCAL,
        inputs: [
          textInput({ id: 'prompt', label: 'Description', help: 'What it should show', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          choiceInput({ id: 'kind', label: 'Make', help: 'A picture or a video', choices: [{ value: 'image', label: 'An image' }, { value: 'video', label: 'A video' }], typed: { flag: '--as' }, optional: { default: 'image', means: 'an image' } }),
          {
            id: 'provider', label: 'Provider', help: 'The providers that make media', kind: 'choice',
            choices: { list: PROVIDERS, allowOther: { reason: 'a provider id' } },
            required: { default: '', defaultMeans: 'the first set-up provider that makes it' }, typed: { flag: '--provider' },
          },
          textInput({ id: 'model', label: 'Model', help: 'One of the provider\'s models', why: 'a model id the provider names', typed: { flag: '--model' }, optional: { default: '', means: 'the provider\'s own choice' } }),
          OUT,
        ],
        sentence: 'A media provider is asked to make {kind} of "{prompt}" and may charge for it; what it makes is saved as a file.',
        example: { prompt: 'a lighthouse at dusk', kind: 'image' },
        async run(values, ctx) {
          const { registry, store } = needs(ctx);
          const prompt = values.prompt!.trim();
          let result: MediaGenerationRun;
          try {
            result = await generateMedia(registry, store, {
              prompt,
              outputMimeType: MIME_BY_KIND[values.kind || 'image'],
              ...(values.provider ? { providerId: values.provider } : {}),
              ...(values.model ? { modelId: values.model } : {}),
            }, { product: policy.product, source: 'media-command' });
          } catch (error) {
            return failed('Making it', error);
          }
          return save(ctx, store, result, prompt, values.out ?? '');
        },
      }),
      doAction<Ctx>({
        id: 'collect', label: 'Collect a job that was still being made', word: 'collect', touches: 'another-machine', operator: LOCAL,
        inputs: [
          { id: 'provider', label: 'Provider', help: 'The provider the job was given to', kind: 'choice', choices: { list: PROVIDERS, allowOther: { reason: 'a provider id' } }, required: true, typed: { position: 1 } },
          textInput({ id: 'task', label: 'Job', help: 'The task id the provider gave', why: 'the id the pending result printed', typed: { position: 2 } }),
          OUT,
          textInput({ id: 'resume', label: 'Resume values', help: 'key=value words, exactly as the pending result printed them', why: 'values the provider gave', typed: { tail: true }, optional: { default: '', means: 'none' } }),
        ],
        sentence: 'Job {task} is collected from {provider} and saved as a file; it was paid for when it was accepted, so nothing new is spent.',
        example: { provider: 'fal', task: 'req-123' },
        async run(values, ctx) {
          const { registry, store } = needs(ctx);
          const resume: Record<string, string> = {};
          for (const pair of (values.resume ?? '').split(/\s+/).filter(Boolean)) {
            const at = pair.indexOf('=');
            if (at <= 0) throw commandRefusal(`"${pair}" is not key=value; give the resume values exactly as the pending result printed them.`);
            resume[pair.slice(0, at)] = pair.slice(at + 1);
          }
          let result: MediaGenerationRun;
          try {
            result = await collectMedia(registry, store, { providerId: values.provider!, taskId: values.task!, ...(Object.keys(resume).length > 0 ? { resume } : {}) }, { product: policy.product, source: 'media-command' });
          } catch (error) {
            return failed(`Collecting ${values.provider} job ${values.task}`, error);
          }
          return save(ctx, store, result, values.task!, values.out ?? '');
        },
      }),
    ],
  });
}

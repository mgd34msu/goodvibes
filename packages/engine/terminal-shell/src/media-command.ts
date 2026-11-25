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
import { choiceInput, doAction, textInput } from './described-command-kit.js';
import { generateMedia, type MediaGenerationRun } from './media-generation.js';
import { daemonCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import { MEDIA_COLLECT, MEDIA_PROVIDERS, type CapabilityDefinition } from '@goodvibes/engine/platform/platform/capabilities';
import { resolveConfinedBundlePath } from './recall-shared.js';

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
  readonly paths: (ctx: Ctx) => Pick<ShellPathService, 'workingDirectory' | 'resolveWorkspacePath' | 'isWithinWorkingDirectory'>;
  /** Opens a saved file in the system viewer; false where there is none. Absent: the path is printed only. */
  readonly openFile?: ((path: string) => Promise<boolean>) | undefined;
  /** This program's daemon binding (capability-binding.ts): collecting a pending job runs in the daemon. */
  readonly binding: DaemonCapabilityBinding<Ctx>;
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

/** Where a job a provider was still making is collected: the Work place's control, with what its form asks. */
export function mediaCollectLine(task: MediaProviderTask): string {
  const resume = Object.entries(task.resume ?? {}).map(([key, value]) => `${key}=${value}`).join(' ');
  return `"collect a media job" in the Work place: provider ${task.providerId}, job ${task.taskId}${resume ? `, resume values ${resume}` : ''}`;
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

  /**
   * The resolved --out path, checked before anything is asked for: a model-run
   * line may only save inside the workspace, so a refused path costs nothing.
   */
  const outPath = (ctx: Ctx, out: string): string | undefined => {
    if (!out) return undefined;
    const resolved = resolveConfinedBundlePath(out, policy.paths(ctx), ctx.invokedByModel);
    if (resolved === undefined) {
      throw commandRefusal('A model-run /media may only save inside the workspace; nothing was asked for.', 'Ask the owner to type the line for a place outside it.');
    }
    return resolved;
  };

  /** Each artifact saved as a file next to its stored copy; the first one opened where there is a viewer. */
  const save = async (ctx: Ctx, store: MediaStore, result: MediaGenerationRun, prompt: string, out: string, target: string | undefined): Promise<string> => {
    if (result.pending) {
      return [
        `${result.pending.providerId} accepted the job (task ${result.pending.taskId}) and is still making it; it is paid for and keeps running.`,
        `Collect it with ${mediaCollectLine(result.pending)}.`,
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
      const file = mediaFilePath(paths.workingDirectory, prompt, artifact.mimeType, index, result.artifacts.length, target);
      const shown = relative(paths.workingDirectory, file).startsWith('..') ? file : relative(paths.workingDirectory, file);
      try {
        await mkdir(dirname(file), { recursive: true });
        // `wx`: an existing file is never replaced.
        await writeFile(file, bytes, { flag: 'wx' });
        written.push(file);
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
      // The media providers the daemon makes with (Models and providers, capabilities/builtin/models.ts), read there.
      daemonCapabilityAction<Ctx>(MEDIA_PROVIDERS as CapabilityDefinition<never>, policy.binding),
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
          const target = outPath(ctx, values.out ?? '');
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
          return save(ctx, store, result, prompt, values.out ?? '', target);
        },
      }),
      // A job still being made is collected by the daemon (platform builtin/media-collect.ts); its control is in the Work place.
      daemonCapabilityAction<Ctx>(MEDIA_COLLECT, policy.binding),
    ],
  });
}

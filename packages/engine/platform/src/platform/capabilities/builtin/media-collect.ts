/**
 * `media.collect` (Work and agents, home `daemon`): a media job a provider
 * accepted but had not finished making is collected by the daemon's own
 * `media.collect` method, run as the same caller, and kept with the daemon's
 * artifacts. When the asking program names its project folder (supplied from
 * its context, never asked of the person), each file is also written there,
 * under `generated/`, as `/media collect` did before; the outcome says where.
 * The job was paid for when it was accepted; nothing new is spent.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type ListName } from '../types.js';
import { callerPathOf } from '../path-inputs.js';
import { writeHeldFile } from '../held-paths.js';

/** What the handler reads a collected file from: the daemon's artifact store. */
export interface MediaCollectServices {
  readonly artifactContent?: ((artifactId: string) => Promise<Buffer>) | undefined;
}

const EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/wav': '.wav',
};

/** A new file under the project's `generated/` folder, named from the job; an existing file is never written over. */
function projectFileFor(folder: string, task: string, mimeType: string, index: number, count: number): string {
  const safe = task.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'media';
  return join(folder, 'generated', `${safe}${count > 1 ? `-${index + 1}` : ''}${EXTENSION[mimeType] ?? ''}`);
}

/** The media providers a job could have gone to (terminal-shell places/tools-lists.ts reads them from the daemon). */
const MEDIA_PROVIDERS_LIST = 'media.providers' as ListName;

/** "the image", "the video", "the sound", or "the file", by its type. */
const kindOf = (mimeType: string): string => mimeType.startsWith('image/') ? 'the image' : mimeType.startsWith('video/') ? 'the video' : mimeType.startsWith('audio/') ? 'the sound' : 'the file';
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const plain = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '';

function methodOf(caller: CapabilityCaller): (methodId: string, body: Record<string, unknown>) => Promise<unknown> {
  if (!caller.method) throw new CapabilityRefusal('This runs on the daemon, through capabilities.run.');
  return caller.method;
}

export const MEDIA_COLLECT: CapabilityDefinition<MediaCollectServices> = {
  capability: { id: 'media.collect', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'collect', label: 'Collect an image or video a provider was still making', word: 'collect',
  inputs: [
    { id: 'provider', label: 'Provider', help: 'The provider the job was given to', kind: 'choice', choices: { list: MEDIA_PROVIDERS_LIST, allowOther: { reason: 'a provider id' } }, required: true, typed: { position: 1 } },
    { id: 'task', label: 'Job', help: 'The task id the provider gave', kind: 'text', freeTextReason: 'the id the pending result printed', required: true, typed: { position: 2 } },
    { id: 'resume', label: 'Resume values', help: 'key=value words, exactly as the pending result printed them', kind: 'text', freeTextReason: 'values the provider gave', required: { default: '', defaultMeans: 'none' }, typed: { tail: true } },
  ],
  sentence: 'The image or video job {task} is fetched from {provider}, kept with your artifacts and saved in this project\'s generated folder; it was paid for when it was accepted, so nothing new is spent.',
  done: '', touches: 'another-machine', lasts: 'kept', risk: 'none', example: { provider: 'fal', task: 'req-123' },
  async run(values, services, caller) {
    const resume: Record<string, string> = {};
    for (const pair of (values.resume ?? '').split(/\s+/).filter(Boolean)) {
      const at = pair.indexOf('=');
      if (at <= 0) throw new CapabilityRefusal(`"${pair}" is not key=value; nothing was collected.`, 'Give the resume values exactly as the pending result printed them.');
      resume[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const answer = record(await methodOf(caller)('media.collect', { providerId: values.provider!, taskId: values.task!, ...(Object.keys(resume).length > 0 ? { resume } : {}) }));
    const artifacts = (Array.isArray(answer['artifacts']) ? answer['artifacts'] : []).map(record);
    if (artifacts.length === 0 && answer['pending']) {
      return { text: `${values.provider} is still making job ${values.task}; collect it again later. Nothing was spent.`, data: { pending: answer['pending'] } };
    }
    // Each file into the asking program's project when it named one; kept only with the artifacts otherwise.
    const folder = caller.workingDirectory;
    const saved = await Promise.all(artifacts.map(async (artifact, index) => {
      const id = plain(artifact['id']);
      if (!folder) return { id, where: 'is kept with your artifacts' };
      if (!services.artifactContent) return { id, where: 'is kept with your artifacts (this daemon cannot read them back to save a copy)' };
      const path = projectFileFor(folder, values.task!, plain(artifact['mimeType']), index, artifacts.length);
      if (existsSync(path)) return { id, where: `is kept with your artifacts and not saved to ${path}: a file is already there, left as it is` };
      try {
        const content = await services.artifactContent(id);
        // Placed by the one rule (path-inputs.ts `callerPathOf`: inside the caller's checked project, held for the call,
        // so a link planted at generated/ or at the file's name leads nowhere) and written the one way, never over a file.
        writeHeldFile(callerPathOf(caller, path, { label: 'The saved file' }), content, undefined, true);
        return { id, where: `is saved to ${path}, and kept with your artifacts`, path };
      } catch (error) {
        return { id, where: `is kept with your artifacts and not saved to ${path} (${error instanceof Error ? error.message : String(error)})` };
      }
    }));
    return {
      // One file says it all on the first line (a place shows an outcome's first line); several are listed under it.
      text: artifacts.length === 1
        ? `Collected job ${values.task} from ${values.provider}: ${kindOf(plain(artifacts[0]!['mimeType']))} ${saved[0]!.where}.`
        : [`Collected job ${values.task} from ${values.provider}: ${artifacts.length} files${folder ? `, saved in ${join(folder, 'generated')} where none was there already` : ', kept with your artifacts'}.`,
          ...artifacts.map((artifact, index) => `  ${kindOf(plain(artifact['mimeType']))} ${saved[index]!.where}.`)].join('\n'),
      data: { artifacts: artifacts.map((artifact, index) => ({ id: artifact['id'], mimeType: artifact['mimeType'], filename: artifact['filename'], ...(saved[index]!.path ? { path: saved[index]!.path } : {}) })) },
    };
  },
};

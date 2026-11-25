/**
 * Tools and extensions: the four actions sorted here from commands whose other
 * actions live elsewhere.
 *
 *  - `media.make` (home `daemon`): an image or a video made by the daemon's
 *    media providers through its own `media.generate`, run as the same caller,
 *    kept with the daemon's artifacts and, when the asking program names its
 *    project folder (from its context, never asked), saved there under
 *    `generated/`, as `/media make` did. It may cost money: the gate asks.
 *  - `tools.helpers` (home `session`): the programming interfaces the terminal
 *    app's own helper service exposes to remote clients and web front ends.
 *  - `deeplink.export` (home `session`): the links to the terminal app's views,
 *    written to a file in its project.
 *  - `hosted.stop-tool` (home `session`): the tool call running in the hosted
 *    session this terminal joined, stopped through the daemon with this
 *    terminal's own join.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type ListName } from '../types.js';
import type { MediaCollectServices } from './media-collect.js';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const plain = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '';

// ---------------------------------------------------------------------------
// media.make
// ---------------------------------------------------------------------------

const EXTENSION: Readonly<Record<string, string>> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm',
};
const MIME_BY_KIND: Readonly<Record<string, string>> = { image: 'image/png', video: 'video/mp4' };
/** The media providers that make something (terminal-shell places/tools-lists.ts reads them from the daemon). */
const MEDIA_PROVIDERS_LIST = 'media.providers' as ListName;

/** The file for one made thing: the path given (numbered after the first), or generated/<words>-<time>.<ext> in the project. */
function madeFile(folder: string, prompt: string, mimeType: string, index: number, count: number, out: string): string {
  const extension = EXTENSION[mimeType] ?? '.bin';
  if (out) {
    const target = isAbsolute(out) ? out : resolve(folder, out);
    const given = extname(target);
    const suffix = count > 1 && index > 0 ? `-${index + 1}` : '';
    return `${given ? target.slice(0, -given.length) : target}${suffix}${given || extension}`;
  }
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'media';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return join(folder, 'generated', `${words}-${stamp}${count > 1 ? `-${index + 1}` : ''}${extension}`);
}

/** A made file named for a person: "Image (png)", "Video (mp4)", "File". */
function mediaNoun(mimeType: string): string {
  const [major, minor] = mimeType.split('/');
  const kind = major === 'image' ? 'Image' : major === 'video' ? 'Video' : major === 'audio' ? 'Sound' : 'File';
  return minor ? `${kind} (${minor.replace(/^svg\+xml$/, 'svg')})` : kind;
}

function methodOf(caller: CapabilityCaller): (methodId: string, body: Record<string, unknown>) => Promise<unknown> {
  if (!caller.method) throw new CapabilityRefusal('This runs on the daemon, through capabilities.run.');
  return caller.method;
}

export const MEDIA_MAKE: CapabilityDefinition<MediaCollectServices> = {
  capability: { id: 'media.make', group: 'tools', home: 'daemon', repeat: 'unsafe' },
  actionId: 'make', label: 'Make an image or a video', word: 'make',
  inputs: [
    { id: 'prompt', label: 'Description', help: 'What the picture or video should show', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
    { id: 'kind', label: 'Make', help: 'A picture or a video', kind: 'choice', choices: [{ value: 'image', label: 'An image' }, { value: 'video', label: 'A video' }], required: { default: 'image', defaultMeans: 'an image' }, typed: { flag: '--as' } },
    { id: 'provider', label: 'Provider', help: 'The providers that make media', kind: 'choice', choices: { list: MEDIA_PROVIDERS_LIST, allowOther: { reason: 'a provider id' } }, required: { default: '', defaultMeans: 'the first set-up provider that makes it' }, typed: { flag: '--provider' } },
    { id: 'model', label: 'Model', help: 'One of the provider\'s models', kind: 'text', freeTextReason: 'a model id the provider names', required: { default: '', defaultMeans: 'the provider\'s own choice' }, typed: { flag: '--model' } },
    { id: 'out', label: 'Save as', help: 'The file to write in this project; a number is added for each further one', kind: 'path', freeTextReason: 'a file path', required: { default: '', defaultMeans: 'a new file under generated/ named from the description' }, typed: { flag: '--out' } },
  ],
  sentence: 'A media provider is asked to make "{prompt}" as {kind} (a picture, an image or a video generated from your words) and may charge for it; what it makes is kept with your artifacts and saved as a file in this project.',
  done: '', touches: 'another-machine', lasts: 'kept', risk: 'spends-money', example: { prompt: 'a lighthouse at dusk', kind: 'image' },
  async run(values, services, caller) {
    const prompt = (values.prompt ?? '').trim();
    if (!prompt) throw new CapabilityRefusal('Say what it should show; nothing was asked for.');
    const folder = caller.workingDirectory;
    const out = (values.out ?? '').trim();
    // A file outside the project is refused before anything is asked for, so a refused path costs nothing.
    if (out && folder && !resolve(folder, out).startsWith(resolve(folder))) {
      throw new CapabilityRefusal(`${out} is outside this project; nothing was asked for.`, 'Give a path inside the project.');
    }
    let made: unknown;
    try {
      made = await methodOf(caller)('media.generate', {
        prompt, outputMimeType: MIME_BY_KIND[values.kind || 'image'] ?? 'image/png',
        ...(values.provider ? { providerId: values.provider } : {}), ...(values.model ? { modelId: values.model } : {}),
      });
    } catch (error) {
      // No provider makes it: said in a person's words (the method's own next step names its `providerId` field).
      if ((error as { code?: unknown } | null)?.code === 'MEDIA_OUTPUT_UNAVAILABLE') {
        const kind = values.kind === 'video' ? 'videos' : 'images';
        const state = String((error as { state?: unknown }).state ?? '');
        const makers = state.startsWith('providers that make') ? state.replace(/^providers that make \w+: /, '') : '';
        throw new CapabilityRefusal(
          `${values.provider ? `${values.provider} does not make ${kind}, or is not set up` : `No set-up media provider makes ${kind}`}; nothing was asked for or spent.`,
          makers ? `Set up one that does (${makers}) on the Media tab of Models and providers, or switch on a plugin that adds one.` : 'Set up a media provider that makes them, or switch on a plugin that adds one.',
          'NOT_DONE');
      }
      throw error;
    }
    const answer = record(made);
    const artifacts = (Array.isArray(answer['artifacts']) ? answer['artifacts'] : []).map(record);
    const pending = record(answer['pending']);
    if (artifacts.length === 0 && plain(pending['taskId'])) {
      const resume = Object.entries(record(pending['resume'])).map(([key, value]) => `${key}=${plain(value)}`).join(' ');
      return {
        text: `${plain(pending['providerId'])} accepted the job (${plain(pending['taskId'])}) and is still making it; it is paid for and keeps running. Collect it with "collect a media job" in the Work place: provider ${plain(pending['providerId'])}, job ${plain(pending['taskId'])}${resume ? `, resume values ${resume}` : ''}.`,
        data: { pending },
      };
    }
    const saved = await Promise.all(artifacts.map(async (artifact, index) => {
      const id = plain(artifact['id']);
      // A provider that stores what it makes answers its artifact id; one that answers the bytes themselves (a
      // plugin's provider) is saved from them, and is not in the artifact store.
      const inline = typeof artifact['dataBase64'] === 'string' && artifact['dataBase64'] ? artifact['dataBase64'] : '';
      const kept = id ? 'kept with your artifacts' : 'not kept with your artifacts (the provider stores none)';
      if (!folder) return { id, where: kept };
      if (!id && !inline) return { id, where: 'the provider answered no file and no artifact; nothing was saved' };
      if (id && !services.artifactContent) return { id, where: `${kept} (this daemon cannot read them back to save a copy)` };
      const path = madeFile(folder, prompt, plain(artifact['mimeType']), index, artifacts.length, out);
      if (existsSync(path)) return { id, where: `${kept}; not saved to ${path}, a file is already there and was left as it is` };
      try {
        const content = id ? await services.artifactContent!(id) : Buffer.from(inline, 'base64');
        mkdirSync(dirname(path), { recursive: true });
        // `wx`: an existing file is never replaced.
        writeFileSync(path, content, { flag: 'wx' });
        return { id, where: `saved to ${path}`, path };
      } catch (error) {
        return { id, where: `${kept}; not saved to ${path} (${error instanceof Error ? error.message : String(error)})` };
      }
    }));
    return {
      text: [`Made ${artifacts.length} file${artifacts.length === 1 ? '' : 's'}${plain(answer['providerId']) ? ` with ${plain(answer['providerId'])}` : ''}.`,
        ...artifacts.map((artifact, index) => `${mediaNoun(plain(artifact['mimeType']))}: ${saved[index]!.where}${saved[index]!.id ? `, artifact ${saved[index]!.id}` : ''}.`)].join('\n'),
      data: { artifacts: artifacts.map((artifact, index) => ({ id: artifact['id'], mimeType: artifact['mimeType'], ...(saved[index]!.path ? { path: saved[index]!.path } : {}) })) },
    };
  },
};

// ---------------------------------------------------------------------------
// The terminal app's own: its helper interfaces, its view links, its hosted join
// ---------------------------------------------------------------------------

/** What the three session actions need from the program holding the conversation; the Agent supplies none of them. */
export interface ToolsExtrasSessionServices {
  /** The terminal app's integration helper service, as words. */
  readonly integrationHelpers?: { review(): string } | undefined;
  /** Every view's link written to a file in the project; the line that says where. */
  readonly viewLinkFile?: { save(path: string): string } | undefined;
  /** The tool call running in the hosted session this terminal joined, stopped; the line that says what happened. */
  readonly hostedToolStop?: { stop(call: string): Promise<string> } | undefined;
}

export const TOOLS_HELPERS: CapabilityDefinition<ToolsExtrasSessionServices> = {
  capability: { id: 'tools.helpers', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'helpers', label: 'See the integration helper interfaces', word: '', inputs: [],
  sentence: 'Shows the programming interfaces (API) this terminal app gives remote clients and web front ends: its sessions, tasks, approvals, remote contracts and views, with their interface families and routes.',
  done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  available: (services) => services.integrationHelpers !== undefined,
  async run(_values, services) {
    if (!services.integrationHelpers) throw new CapabilityRefusal('Only the terminal app has the integration helper service.', undefined, 'UNAVAILABLE');
    return { text: services.integrationHelpers.review() };
  },
};

export const DEEPLINK_EXPORT: CapabilityDefinition<ToolsExtrasSessionServices> = {
  capability: { id: 'deeplink.export', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'export', label: 'Save the links to a file', word: 'export',
  inputs: [{ id: 'path', label: 'File', help: 'Where to write them, in the project', kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 } }],
  sentence: 'Every view\'s link (goodvibes://open/...) is written to {path}.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'links.json' },
  available: (services) => services.viewLinkFile !== undefined,
  async run(values, services) {
    if (!services.viewLinkFile) throw new CapabilityRefusal('Links open views of the terminal app; this program has none.', undefined, 'UNAVAILABLE');
    return { text: services.viewLinkFile.save(values.path!) };
  },
};

const RUNNING_TOOLS = 'hosted.running-tools' as ListName;

export const HOSTED_STOP_TOOL: CapabilityDefinition<ToolsExtrasSessionServices> = {
  capability: { id: 'hosted.stop-tool', group: 'tools', home: 'session', repeat: 'safe' },
  actionId: 'stop-tool', label: 'Stop the tool that is running', word: 'stop-tool',
  inputs: [{ id: 'call', label: 'Tool', help: 'The tools running in the session now', kind: 'choice', choices: { list: RUNNING_TOOLS, allowOther: { reason: 'a tool call id' } }, required: { default: '', defaultMeans: 'the one running now' }, typed: { position: 1 } }],
  sentence: 'The tool call {call} in the hosted session you joined is stopped; the turn goes on without its result.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: { call: 'call-1' },
  available: (services) => services.hostedToolStop !== undefined,
  async run(values, services) {
    if (!services.hostedToolStop) throw new CapabilityRefusal('Only the terminal app joins hosted sessions; this program has none to stop a tool in.', undefined, 'UNAVAILABLE');
    return { text: await services.hostedToolStop.stop(values.call ?? '') };
  },
};

export const TOOLS_EXTRAS_SESSION_CAPABILITIES: readonly CapabilityDefinition<ToolsExtrasSessionServices>[] = [TOOLS_HELPERS, DEEPLINK_EXPORT, HOSTED_STOP_TOOL];

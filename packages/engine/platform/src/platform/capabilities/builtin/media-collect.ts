/**
 * `media.collect` (Work and agents, home `daemon`): a media job a provider
 * accepted but had not finished making is collected by the daemon's own
 * `media.collect` method, run as the same caller, and kept with the daemon's
 * artifacts. The job was paid for when it was accepted; nothing new is spent.
 */
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type ListName } from '../types.js';

/** The media providers a job could have gone to (terminal-shell media-command.ts reads them). */
const MEDIA_PROVIDERS_LIST = 'media.providers' as ListName;

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const plain = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '';

function methodOf(caller: CapabilityCaller): (methodId: string, body: Record<string, unknown>) => Promise<unknown> {
  if (!caller.method) throw new CapabilityRefusal('This runs on the daemon, through capabilities.run.');
  return caller.method;
}

export const MEDIA_COLLECT: CapabilityDefinition<Record<never, never>> = {
  capability: { id: 'media.collect', group: 'work', home: 'daemon', repeat: 'safe' },
  actionId: 'collect', label: 'Collect an image or video a provider was still making', word: 'collect',
  inputs: [
    { id: 'provider', label: 'Provider', help: 'The provider the job was given to', kind: 'choice', choices: { list: MEDIA_PROVIDERS_LIST, allowOther: { reason: 'a provider id' } }, required: true, typed: { position: 1 } },
    { id: 'task', label: 'Job', help: 'The task id the provider gave', kind: 'text', freeTextReason: 'the id the pending result printed', required: true, typed: { position: 2 } },
    { id: 'resume', label: 'Resume values', help: 'key=value words, exactly as the pending result printed them', kind: 'text', freeTextReason: 'values the provider gave', required: { default: '', defaultMeans: 'none' }, typed: { tail: true } },
  ],
  sentence: 'The image or video job {task} is fetched from {provider} and kept with your artifacts; it was paid for when it was accepted, so nothing new is spent.',
  done: '', touches: 'another-machine', lasts: 'not-a-change', risk: 'none', example: { provider: 'fal', task: 'req-123' },
  async run(values, _services, caller) {
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
    return {
      text: [`Collected job ${values.task} from ${values.provider}:`, ...artifacts.map((artifact) => `  ${plain(artifact['id'])}  ${plain(artifact['mimeType'])}  ${plain(artifact['filename'])}`.trimEnd())].join('\n'),
      data: { artifacts: artifacts.map((artifact) => ({ id: artifact['id'], mimeType: artifact['mimeType'], filename: artifact['filename'] })) },
    };
  },
};

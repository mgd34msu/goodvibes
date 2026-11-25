/**
 * Links to the terminal app's views (`goodvibes://open/<view>[?target=...]`):
 * opening a view by its link, and reading a link file saved earlier. Both act
 * on the screen and the files of the program holding the conversation, so
 * they run there; the terminal app supplies the views.
 */
import { CapabilityRefusal, type CapabilityDefinition, type ListName } from '../types.js';

export interface DeepLinkCapabilityServices {
  readonly deepLinks?: {
    /** Open a view by a link or a view name (and its target); the line that says what happened. */
    readonly open: (subject: string, target: string) => string;
    /** What a link file holds; throws a refusal when it is not one. */
    readonly inspect: (path: string) => string;
  } | undefined;
}

const session = (id: string) => ({ id, group: 'memory' as const, home: 'session' as const, repeat: 'safe' as const });

function linksOf(services: DeepLinkCapabilityServices): NonNullable<DeepLinkCapabilityServices['deepLinks']> {
  if (!services.deepLinks) throw new CapabilityRefusal('Links open views of the terminal app; this program has none.');
  return services.deepLinks;
}

export const DEEPLINK_OPEN: CapabilityDefinition<DeepLinkCapabilityServices> = {
  capability: session('deeplink.open'),
  actionId: 'open', label: 'Open a view by its link', word: 'open',
  inputs: [
    { id: 'view', label: 'View', help: 'A view, or a whole goodvibes://open/... link', kind: 'choice', choices: { list: 'deeplink.views' as ListName, allowOther: { reason: 'a goodvibes://open/... link' } }, required: true, typed: { position: 1 } },
    { id: 'target', label: 'Target', help: 'A process to select in the Agents view', kind: 'text', freeTextReason: 'a process id', required: { default: '', defaultMeans: 'nothing selected' }, typed: { position: 2 } },
  ],
  sentence: 'Opens {view}, with its target selected when one is given.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { view: 'tasks' },
  async run(values, services) {
    return { text: linksOf(services).open(values.view!, values.target ?? '') };
  },
};

export const DEEPLINK_INSPECT: CapabilityDefinition<DeepLinkCapabilityServices> = {
  capability: session('deeplink.inspect'),
  actionId: 'inspect', label: 'Read a saved link file', word: 'inspect',
  inputs: [{ id: 'path', label: 'File', help: 'A file of links saved earlier', kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 } }],
  sentence: 'Shows when {path} was saved and how many links it holds.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'links.json' },
  async run(values, services) {
    return { text: linksOf(services).inspect(values.path!) };
  },
};

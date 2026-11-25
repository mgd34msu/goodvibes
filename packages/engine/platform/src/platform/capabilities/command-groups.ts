/**
 * Which function group each of today's command actions belongs to, from the
 * first sort of all 917 actions (commands-menus/groups.json, 2026-11-24):
 * the group most of a command's actions went to, and each action that went
 * elsewhere. An action that has moved declares its group itself
 * (CapabilityDeclaration); this table places every other one, so find covers
 * every group while the actions move. The engineer of a group corrects rows
 * here as he reads each action.
 */
import type { CapabilityGroupId } from './groups.js';

const BY_COMMAND: Readonly<Record<string, CapabilityGroupId>> = {
  'about-me': 'memory', accounts: 'models', agent: 'work', 'agent-home': 'memory', agents: 'work', approval: 'waiting',
  artifacts: 'memory', auth: 'models', brief: 'work', bundle: 'system', calendar: 'messages', changes: 'code',
  channels: 'messages', checkin: 'automation', checkpoint: 'conversation', ci: 'automation', clear: 'conversation',
  cloudflare: 'devices', cluster: 'devices', codebase: 'code', communication: 'work', compact: 'conversation',
  compare: 'models', context: 'conversation', decisions: 'waiting', deeplink: 'memory', devices: 'devices',
  documents: 'memory', editor: 'conversation', effort: 'models', eval: 'work', git: 'code', google: 'messages',
  graph: 'work', guidance: 'conversation', health: 'system', held: 'waiting', help: 'system', helpers: 'tools',
  hooks: 'tools', hosted: 'sessions', image: 'conversation', intelligence: 'code', keys: 'system', knowledge: 'memory',
  'local-auth': 'safety', mail: 'messages', managed: 'tools', marketplace: 'tools', mcp: 'tools', media: 'models',
  memory: 'memory', model: 'models', 'my-skills': 'tools', 'network-scan': 'devices', notes: 'memory',
  notifications: 'messages', notify: 'messages', paste: 'conversation', payments: 'money', permissions: 'safety',
  personas: 'memory', pin: 'models', plan: 'safety', plugin: 'tools', power: 'system', presets: 'tools',
  principals: 'safety', provider: 'models', questions: 'waiting', queue: 'conversation', quit: 'system',
  redo: 'conversation', release: 'system', remote: 'work', replay: 'work', research: 'work', resume: 'sessions',
  retry: 'conversation', review: 'code', routines: 'memory', save: 'conversation', scan: 'models', schedule: 'automation',
  secrets: 'safety', security: 'safety', services: 'models', session: 'sessions', settings: 'system',
  'settings-sync': 'devices', setup: 'system', skills: 'tools', startup: 'system', status: 'system', tasks: 'work',
  telegram: 'waiting', template: 'memory', test: 'code', title: 'conversation', todo: 'work', tools: 'tools',
  triggers: 'automation', undo: 'conversation', update: 'system', usage: 'money', verbosity: 'system', voice: 'system',
  'web-search': 'tools', work: 'work', workstream: 'work', worktree: 'code',
};

/** Actions sorted to another group than their command's, by `<command> <action id>`. */
const BY_ACTION: Readonly<Record<string, CapabilityGroupId>> = {
  'bundle load': 'tools', 'compare export': 'work', 'deeplink review': 'system', 'deeplink export': 'tools',
  'devices grants': 'safety', 'google adopt': 'tools', 'google waiting': 'waiting', 'health stop-agent': 'work',
  'hosted send-later': 'conversation', 'hosted stop-tool': 'tools', 'local-auth remove-first-run-file': 'system',
  'media make': 'tools', 'media collect': 'work', 'payments see-waiting': 'waiting',
  'remote tunnel': 'devices', 'remote tunnel-export': 'devices',
  'routines enable': 'automation', 'routines disable': 'automation', 'routines promote': 'automation',
  'routines receipts': 'automation', 'routines receipt': 'automation', 'routines reconcile': 'automation',
  'session save': 'conversation', 'session expand': 'conversation', 'session collapse': 'conversation',
  'session compactions': 'conversation', 'session save-file': 'conversation', 'session branch': 'conversation',
  'session cancel': 'work',
  'setup model': 'models', 'setup sign-in': 'models', 'setup add-provider': 'models', 'setup store-key': 'models',
  'setup other-devices': 'devices', 'setup webhooks': 'tools', 'setup chat-apps': 'messages', 'setup cloudflare': 'devices',
  'setup safety': 'safety', 'setup memory': 'memory', 'setup automation': 'automation', 'setup devices-voice': 'devices',
  'startup hooks': 'tools', 'startup remote': 'work', 'startup sandbox': 'safety', 'voice stop': 'messages',
};

/** The group an action of `command` belongs to; `system` for a command this table does not name yet. */
export function capabilityGroupOf(command: string, actionId: string): CapabilityGroupId {
  return BY_ACTION[`${command} ${actionId}`] ?? BY_COMMAND[command] ?? 'system';
}

/**
 * A capability's id, from today's words only: `<command>.<action word>`, and
 * for a command of one action typed with no word, `<group>.<command>`
 * (`conversation.clear`). An action whose word is taken by another action of
 * the same command keeps its own id after the dot.
 */
export function capabilityIdOf(command: string, word: string, group: CapabilityGroupId): string {
  return word ? `${command}.${word}` : `${group}.${command}`;
}

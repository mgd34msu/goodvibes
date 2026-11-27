/**
 * channel-lists.ts, the live lists the channel capabilities choose from
 * (platform capabilities/builtin/messages.ts, channel-reads.ts, channel-send.ts):
 * the daemon's channels (`channels`) and the channel profiles
 * (`channels.profiles`), read through the capabilities `channels.status` and
 * `channels.profiles`. Each terminal program gives the binding it reaches the
 * daemon with; the web UI reads the same rows from the methods named below.
 */
import { CHANNEL_PROFILES_LIST, CHANNEL_PROJECTS_LIST, CHANNELS_LIST_NAME } from '@goodvibes/engine/platform/platform/capabilities';
import { CHANNEL_STATE_WORDS, channelStateOf } from './channel-words.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';

let bindingOf: DaemonCapabilityBinding<CommandActionContext> | undefined;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const records = (value: unknown, key: string): readonly Readonly<Record<string, unknown>>[] => {
  const list = isRecord(value) ? value[key] : undefined;
  return Array.isArray(list) ? list.filter(isRecord) : [];
};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The daemon's channels ("Pair something" in Devices and network chooses from them too). */
export const CHANNELS_LIST = defineList<CommandActionContext>({
  name: CHANNELS_LIST_NAME,
  async read(ctx) {
    if (!bindingOf) return [];
    const answer = await runDaemonCapability('channels.status', {}, ctx, bindingOf);
    return records(answer.data, 'channels').map((channel): ListRow => ({
      value: text(channel['surface']) || 'unknown', label: text(channel['label']) || text(channel['surface']) || 'unknown',
      state: CHANNEL_STATE_WORDS[channelStateOf(channel)],
    }));
  },
  operator: { method: 'channels.status', input: {}, rows: { from: 'channels', value: 'surface', label: 'surface', state: 'state' } },
});

/** The channel profiles, the list the profile capabilities' Channel input chooses from. */
export const CHANNEL_PROFILES = defineList<CommandActionContext>({
  name: CHANNEL_PROFILES_LIST,
  async read(ctx) {
    if (!bindingOf) return [];
    const answer = await runDaemonCapability('channels.profiles', {}, ctx, bindingOf);
    return records(answer.data, 'bindings').map((binding): ListRow => {
      const detail = [text(binding['model']), text(binding['permissionMode'])].filter(Boolean).join(', ');
      return {
        value: text(binding['surfaceKind']),
        label: text(binding['channelId']) ? `${text(binding['surfaceKind'])}:${text(binding['channelId'])}` : text(binding['surfaceKind']),
        ...(detail ? { detail } : {}),
      };
    });
  },
  operator: { method: 'channels.profiles.list', input: {}, rows: { from: 'bindings', value: 'surfaceKind', label: 'surfaceKind', detail: 'model' } },
});

/** The registered projects, the list "Project for this channel" chooses from. */
export const CHANNEL_PROJECTS = defineList<CommandActionContext>({
  name: CHANNEL_PROJECTS_LIST,
  async read(ctx) {
    if (!bindingOf) return [];
    const answer = await runDaemonCapability('workspaces.list', {}, ctx, bindingOf);
    return [
      ...records(answer.data, 'workspaces').filter((workspace) => text(workspace['root'])).map((workspace): ListRow => ({
        value: text(workspace['root']), label: text(workspace['label']) || text(workspace['root']).split('/').pop() || text(workspace['root']), detail: text(workspace['root']),
      })),
      // No project: conversations on the channel write no file and run no command.
      { value: 'none', label: 'None', detail: 'conversations here write no file and run no command' },
    ];
  },
  operator: { method: 'workspaces.registrations.list', input: {}, rows: { from: 'workspaces', value: 'root', label: 'root' } },
});

/** Give the lists the binding this program reaches the daemon with. */
export function registerChannelLists<Ctx extends CommandActionContext>(binding: DaemonCapabilityBinding<Ctx>): void {
  bindingOf = binding as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

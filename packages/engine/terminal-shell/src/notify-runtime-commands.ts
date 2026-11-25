/**
 * The two live lists the webhook-notification capabilities choose from
 * (platform capabilities/builtin/notify.ts): the daemon's addresses by number,
 * and the daemon's failed notifications. The addresses, a test, a send and a
 * resend are the daemon's capabilities, run from the Mail, calendar and
 * channels place; no slash command carries them.
 */
import { NOTIFY_ADDRESSES_LIST, NOTIFY_FAILED_LIST } from '@goodvibes/engine/platform/platform/capabilities';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext } from './command-actions/types.js';

let bindingOf: DaemonCapabilityBinding<CommandActionContext> | undefined;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const NOTIFY_ADDRESSES = defineList<CommandActionContext>({
  name: NOTIFY_ADDRESSES_LIST,
  async read(ctx) {
    if (!bindingOf) return [];
    const answer = await runDaemonCapability('notify.list', {}, ctx, bindingOf);
    const addresses = isRecord(answer.data) && Array.isArray(answer.data['addresses']) ? answer.data['addresses'].filter(isRecord) : [];
    return addresses.map((entry): ListRow => ({ value: String(entry['number']), label: `${String(entry['number'])}. ${String(entry['shown'] ?? '')}` }));
  },
  operator: { method: 'capabilities.run', input: { id: 'notify.list' }, rows: { from: 'data.addresses', value: 'number', label: 'shown' } },
});

export const NOTIFY_FAILED = defineList<CommandActionContext>({
  name: NOTIFY_FAILED_LIST,
  async read(ctx) {
    if (!bindingOf) return [];
    const daemon = bindingOf.daemon(ctx);
    const answer = await daemon.invoke('notifications.deadLetters.list', {});
    const entries = isRecord(answer) && Array.isArray(answer['entries']) ? answer['entries'].filter(isRecord) : [];
    return [
      { value: 'all', label: 'Every failed notification' },
      ...entries.map((entry): ListRow => ({
        value: String(entry['id']),
        label: typeof entry['summary'] === 'string' ? entry['summary'].split('\n')[0] ?? String(entry['id']) : String(entry['id']),
        detail: `${String(entry['channel'] ?? '')}, ${String(entry['finalError'] ?? '')}`,
      })),
    ];
  },
  operator: { method: 'notifications.deadLetters.list', input: {}, rows: { from: 'entries', value: 'id', label: 'summary', detail: 'channel' } },
});

/** Give the lists the binding this program reaches the daemon with. */
export function registerNotifyLists<Ctx extends CommandActionContext>(binding: DaemonCapabilityBinding<Ctx>): void {
  bindingOf = binding as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

/**
 * Give the notify lists this program's binding. The notice history is the System place's Notices list
 * (places/system-place.ts; Ctrl+N opens it there): no command opens it.
 */
export function registerNotifyCommands<Context extends CommandActionContext>(
  _registry: Pick<TerminalCommandRegistry<Context>, 'register'>,
  binding: DaemonCapabilityBinding<Context>,
): void {
  registerNotifyLists(binding);
}

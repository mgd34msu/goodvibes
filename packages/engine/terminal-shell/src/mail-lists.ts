/**
 * mail-lists.ts, the live list the mail capabilities choose a message from
 * (`mail.inbox`, platform capabilities/builtin/messages.ts): the newest
 * messages of the daemon's one mailbox, read through `mail.list`. Each terminal
 * program gives the binding it reaches the daemon with; the web UI reads the
 * same rows from `email.inbox.list`.
 */
import { MAIL_INBOX_LIST } from '@goodvibes/engine/platform/platform/capabilities';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';

let bindingOf: DaemonCapabilityBinding<CommandActionContext> | undefined;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const MAIL_INBOX = defineList<CommandActionContext>({
  name: MAIL_INBOX_LIST,
  async read(ctx) {
    if (!bindingOf) return [];
    const answer = await runDaemonCapability('mail.list', { count: '30' }, ctx, bindingOf);
    const messages = isRecord(answer.data) && Array.isArray(answer.data['messages']) ? answer.data['messages'].filter(isRecord) : [];
    return messages.map((message): ListRow => ({
      value: String(message['uid']),
      label: typeof message['subject'] === 'string' && message['subject'] ? message['subject'] : '(no subject)',
      ...(typeof message['from'] === 'string' ? { detail: message['from'] } : {}),
      ...(message['unread'] === true ? { state: 'unread' } : {}),
    }));
  },
  operator: { method: 'email.inbox.list', input: {}, rows: { from: 'messages', value: 'uid', label: 'subject', detail: 'from' } },
});

/** Give the list the binding this program reaches the daemon with. */
export function registerMailLists<Ctx extends CommandActionContext>(binding: DaemonCapabilityBinding<Ctx>): void {
  bindingOf = binding as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

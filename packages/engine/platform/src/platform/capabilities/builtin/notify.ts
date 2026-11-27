/**
 * Webhook notifications: the one list of addresses notifications go to, the
 * daemon's (`notifications.webhookUrls` in the daemon's settings, each member a
 * `goodvibes://secrets/` reference to the address in the daemon's secret
 * store), a test, a send, and the notifications that failed (the daemon's own
 * failed-notification list, `notifications.deadLetters.*`). Every capability
 * here runs in the daemon.
 *
 * The three lists 3.5.0 kept (the terminal app's, the Agent's and the
 * daemon's) are carried into this one once (config/settings-carry-forward.ts),
 * and the same address is kept once (`dedupeNotificationAddresses`, run when
 * the daemon's notifier starts).
 */
import { isSecretReferenceValue } from '../../config/secret-bearing-config-keys.js';
import {
  forgetNotificationWebhook,
  resolveNotificationWebhook,
  shownNotificationWebhook,
  storeNotificationWebhook,
  type NotificationWebhookSecretStore,
} from '../../integrations/notification-webhooks.js';
import type { WebhookNotifier } from '../../integrations/webhooks.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type ListName } from '../types.js';
import type { MethodCapabilityDefinition } from './method-capability.js';

/** The addresses by number, and the failed notifications (registered in terminal-shell). */
export const NOTIFY_ADDRESSES_LIST = 'notify.webhooks' as ListName;
export const NOTIFY_FAILED_LIST = 'notify.failed' as ListName;

export interface NotifyCapabilityServices {
  readonly notify: {
    /** The daemon's list as stored (references; a plain address 3.3.1 kept is stored on the next write). */
    addresses(): readonly string[];
    /** Write the daemon's list and hand it to the daemon's notifier. */
    keep(addresses: readonly string[]): void;
    readonly secrets: NotificationWebhookSecretStore;
    readonly notifier: Pick<WebhookNotifier, 'setUrls' | 'send' | 'test' | 'targetProblem'>;
    /** Whether a notification carries only that something happened (`behavior.notificationsMetadataOnly`, read now). */
    metadataOnly(): boolean;
  };
}

const READ = { done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none' } as const;
const NONE_YET = 'No address is set: notifications go nowhere yet. Add one with "add an address".';
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

async function resolved(services: NotifyCapabilityServices, entry: string): Promise<string | null> {
  try { return await resolveNotificationWebhook(entry, services.notify.secrets); } catch { return null; }
}

/** The list as it may be written: a plain address an old release kept is stored and replaced by its reference. */
async function writable(services: NotifyCapabilityServices, created: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of services.notify.addresses()) {
    if (isSecretReferenceValue(entry)) out.push(entry);
    else {
      const reference = await storeNotificationWebhook(entry, services.notify.secrets);
      created.push(reference);
      out.push(reference);
    }
  }
  return out;
}

function changed(): void { noteListChanged({ list: 'notifications', change: 'changed' }); }

export const NOTIFY_LIST: CapabilityDefinition<NotifyCapabilityServices> = {
  capability: { id: 'notify.list', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'list', word: 'list', label: 'See where notifications go', ...READ,
  inputs: [{ id: 'show', label: 'Addresses', help: 'Each address carries its key, so only its site is shown unless you ask', kind: 'choice',
    choices: [{ value: 'no', label: 'Show only each site' }, { value: 'yes', label: 'Show the full addresses', risk: 'loosens-a-protection' }],
    required: { default: 'no', defaultMeans: 'only each site' }, typed: { flag: '--show', switchOn: 'yes' } }],
  sentence: 'Lists the webhook addresses (ntfy and the like) your notifications and alerts are sent to, by number; the full addresses, which carry their keys, are shown in the pane and not in the words.', example: { show: 'no' },
  reveals: { label: 'Webhook addresses', note: 'Each address carries its key: it is shown here and not kept in the words of the answer. Ask again to see it again.' },
  async run(values, services) {
    const entries = services.notify.addresses();
    const full = values.show === 'yes';
    const urls = await Promise.all(entries.map((entry) => resolved(services, entry)));
    const addresses = urls.map((url, index) => ({ number: index + 1, shown: shownNotificationWebhook(url), readable: url !== null }));
    if (entries.length === 0) return { text: NONE_YET, data: { addresses } };
    const complete = full ? urls.flatMap((url, index) => (url === null ? [] : [`${index + 1}. ${url}`])) : [];
    return {
      text: [`Notifications go to ${entries.length} address${entries.length === 1 ? '' : 'es'}:`,
        ...addresses.map((entry) => `  ${entry.number}. ${entry.shown}${entry.readable ? '' : ' (its stored address could not be read; nothing is sent to it)'}`),
        ...(complete.length > 0 ? ['The full addresses are in the pane, not in these words.'] : [])].join('\n'),
      data: { addresses },
      ...(complete.length > 0 ? { reveal: { value: complete.join('\n') } } : {}),
    };
  },
};

export const NOTIFY_ADD: CapabilityDefinition<NotifyCapabilityServices> = {
  capability: { id: 'notify.add', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'add', word: 'add', label: 'Send notifications to a webhook address',
  inputs: [{ id: 'url', label: 'Address', help: 'A webhook address such as https://ntfy.sh/my-topic; it carries its key, so it is kept secret', kind: 'secret', required: true, typed: { position: 1 } }],
  sentence: 'Notifications and alerts also go to the webhook address you gave (an ntfy topic or the like), kept in the secret store, until you change it.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'remove',
  // The address carries posting rights: writing it is the owner's, and a model's call of it is put to the owner.
  effects: ['control-plane.write', 'secret.write'],
  example: {},
  async run(values, services) {
    const url = (values.url ?? '').trim();
    let target: URL;
    try { target = new URL(url); } catch {
      throw new CapabilityRefusal('Nothing was added: that is not an address. Give the full address, for example https://ntfy.sh/my-topic.');
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new CapabilityRefusal(`Nothing was added: ${target.protocol} addresses cannot be delivered to; use an http or https webhook address.`);
    // The delivery's own rule: a stored address it refuses would only ever fail.
    const problem = services.notify.notifier.targetProblem(url);
    if (problem !== undefined) throw new CapabilityRefusal(`Nothing was added: ${problem}`);
    const known = await Promise.all(services.notify.addresses().map((entry) => resolved(services, entry)));
    if (known.includes(url)) return { text: `Already set: ${shownNotificationWebhook(url)}; nothing changed.`, data: { added: false } };
    const created: string[] = [];
    try {
      const next = await writable(services, created);
      const reference = await storeNotificationWebhook(url, services.notify.secrets);
      created.push(reference);
      services.notify.keep([...next, reference]);
    } catch (error) {
      // The list was not written, so nothing refers to what this call stored.
      for (const entry of created) await forgetNotificationWebhook(entry, services.notify.secrets).catch(() => undefined);
      throw error;
    }
    changed();
    return { text: `Notifications now also go to ${shownNotificationWebhook(url)} (the address is kept in the secret store).`, data: { added: true } };
  },
};

/** The member a number names, as the list shows it. */
function memberAt(services: NotifyCapabilityServices, which: string | undefined): { readonly index: number; readonly entry: string } {
  const entries = services.notify.addresses();
  const index = Number(which) - 1;
  const entry = Number.isInteger(index) ? entries[index] : undefined;
  if (entry === undefined) throw new CapabilityRefusal(`No address has the number ${which}; ${entries.length === 0 ? 'none is set' : `they are numbered 1 to ${entries.length}`}.`);
  return { index, entry };
}

export const NOTIFY_REMOVE: CapabilityDefinition<NotifyCapabilityServices> = {
  capability: { id: 'notify.remove', group: 'messages', home: 'daemon', repeat: 'unsafe' },
  actionId: 'remove', word: 'remove', label: 'Stop sending notifications to an address',
  inputs: [{ id: 'address', label: 'Address', help: 'The addresses by number', kind: 'choice', choices: { list: NOTIFY_ADDRESSES_LIST }, required: true, typed: { position: 1 } }],
  sentence: 'Notifications stop going to address {address}, until you change it; its stored address is deleted.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'add',
  example: { address: '1' },
  async run(values, services) {
    const { index, entry } = memberAt(services, values.address);
    const shown = shownNotificationWebhook(await resolved(services, entry));
    services.notify.keep(services.notify.addresses().filter((_, at) => at !== index));
    changed();
    let kept = '';
    try { await forgetNotificationWebhook(entry, services.notify.secrets); } catch (error) {
      kept = ` Its stored address could not be deleted (${error instanceof Error ? error.message : String(error)}); it is no longer sent to.`;
    }
    return { text: `Notifications no longer go to ${shown}.${kept}`, data: { removed: shown } };
  },
};

export const NOTIFY_CLEAR: CapabilityDefinition<NotifyCapabilityServices> = {
  capability: { id: 'notify.clear', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'clear', word: 'clear', label: 'Stop sending notifications to every address', inputs: [],
  sentence: 'Every webhook address is removed and its stored address deleted; notifications go nowhere until you add one.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone', example: {},
  async run(_values, services) {
    const entries = services.notify.addresses();
    if (entries.length === 0) return { text: 'No address was set; nothing changed.', data: { removed: 0 } };
    services.notify.keep([]);
    changed();
    let notDeleted = 0;
    for (const entry of entries) await forgetNotificationWebhook(entry, services.notify.secrets).catch(() => { notDeleted += 1; });
    return {
      text: `All ${entries.length} address${entries.length === 1 ? ' was' : 'es were'} removed.${notDeleted > 0 ? ` ${notDeleted} stored address${notDeleted === 1 ? '' : 'es'} could not be deleted; nothing is sent to them.` : ''}`,
      data: { removed: entries.length },
    };
  },
};

export const NOTIFY_TEST: CapabilityDefinition<NotifyCapabilityServices> = {
  capability: { id: 'notify.test', group: 'messages', home: 'daemon', repeat: 'unsafe' },
  actionId: 'test', word: 'test', label: 'Send a test notification', inputs: [],
  sentence: 'A test notification is sent to every webhook address, and each one\'s answer is shown.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out', example: {},
  async run(_values, services) {
    const entries = services.notify.addresses();
    if (entries.length === 0) return { text: `Nothing was sent. ${NONE_YET}`, data: { attempted: 0, delivered: 0 } };
    services.notify.notifier.setUrls([...entries]);
    const results = await services.notify.notifier.test();
    const lines = await Promise.all(results.map(async (result) => {
      const shown = shownNotificationWebhook(await resolved(services, result.url));
      return result.ok ? `  ${shown}: delivered` : `  ${shown}: not delivered (${result.error ?? 'no reason given'})`;
    }));
    const delivered = results.filter((result) => result.ok).length;
    return { text: [`Test sent to ${results.length} address${results.length === 1 ? '' : 'es'}; ${delivered} delivered:`, ...lines].join('\n'), data: { attempted: results.length, delivered } };
  },
};

export const NOTIFY_SEND: CapabilityDefinition<NotifyCapabilityServices> = {
  capability: { id: 'notify.send', group: 'messages', home: 'daemon', repeat: 'unsafe' },
  actionId: 'send', word: 'send', label: 'Send a notification to my phone or webhook',
  inputs: [{ id: 'message', label: 'Message', help: 'What the notification says', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  sentence: '"{message}" is sent as a notification to every webhook address.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out', example: { message: 'Build is green' },
  async run(values, services) {
    const entries = services.notify.addresses();
    if (entries.length === 0) return { text: `Nothing was sent. ${NONE_YET}`, data: { attempted: 0, delivered: 0 } };
    services.notify.notifier.setUrls([...entries]);
    // Read before the send: what went out is what the setting said when it was sent.
    const withoutText = services.notify.metadataOnly();
    const result = await services.notify.notifier.send(values.message ?? '');
    // The words say what really went out: with "metadata only" on, a notice without the text.
    const counted = `${result.delivered} of ${result.attempted} address${result.attempted === 1 ? '' : 'es'}${result.failed > 0 ? '; the ones that failed are in the failed notifications' : ''}`;
    const text = result.delivered === 0
      ? `Not delivered: delivered to ${counted}.`
      : withoutText
        ? `Sent a notice without the text (only the notice goes out while 'metadata only' is on). Delivered to ${counted}.`
        : `${result.failed === 0 ? 'Sent' : 'Partly delivered'}: delivered to ${counted}.`;
    return { text, data: { attempted: result.attempted, delivered: result.delivered, failed: result.failed, textSent: !withoutText } };
  },
};

/** One failed notification as a person reads it. */
function failedSaid(entry: Readonly<Record<string, unknown>>): string {
  const summary = typeof entry['summary'] === 'string' ? entry['summary'].split('\n').map((line) => line.trim()).filter(Boolean).join(': ') : '';
  const when = typeof entry['deadAt'] === 'number' ? new Date(entry['deadAt']).toISOString().replace('T', ' ').slice(0, 16) : '';
  const status = typeof entry['status'] === 'number' ? ` (HTTP ${entry['status']})` : '';
  return `${String(entry['channel'] ?? '')} ${when}: ${summary || String(entry['event'] ?? '')}, ${String(entry['finalError'] ?? 'failed')}${status}`;
}

export const NOTIFY_FAILED: MethodCapabilityDefinition = {
  capability: { id: 'notify.failed', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'failed', word: 'failed', label: 'See notifications that failed', inputs: [], ...READ,
  sentence: 'Lists the notifications (webhooks, Slack, Discord) that could not be delivered, oldest first, with why.', example: {},
  method: { id: 'notifications.deadLetters.list', fields: {} },
  said: (answer) => {
    const entries = Array.isArray(answer['entries']) ? answer['entries'].filter(isRecord) : [];
    return entries.length === 0 ? 'No notification failed.' : [`${entries.length} notification${entries.length === 1 ? '' : 's'} failed, oldest first:`, ...entries.map((entry) => `  ${failedSaid(entry)}`)].join('\n');
  },
};

function methodOf(caller: CapabilityCaller): NonNullable<CapabilityCaller['method']> {
  if (!caller.method) throw new CapabilityRefusal('Failed notifications are the daemon\'s, and this run did not come through it, so nothing was sent.');
  return caller.method;
}

export const NOTIFY_RESEND: CapabilityDefinition<NotifyCapabilityServices> = {
  capability: { id: 'notify.resend', group: 'messages', home: 'daemon', repeat: 'unsafe' },
  actionId: 'resend', word: 'resend', label: 'Send failed notifications again',
  inputs: [
    { id: 'which', label: 'Which', help: 'One failed notification, or all of them', kind: 'choice',
      choices: { list: NOTIFY_FAILED_LIST, allowOther: { reason: 'a failed notification\'s id' } }, required: true, typed: { position: 1 } },
    { id: 'where', label: 'Where', help: 'Where a Slack or Discord channel that moved since posts', kind: 'choice',
      choices: [{ value: 'same', label: 'Where it was going' }, { value: 'current', label: 'Where the channel posts now' }],
      required: { default: 'same', defaultMeans: 'where it was going' }, typed: { flag: '--to-current', switchOn: 'current' } },
  ],
  sentence: 'The failed notification {which} is sent again.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out', example: { which: 'all' },
  async run(values, _services, caller) {
    const which = (values.which ?? '').trim();
    const ids = which === '' || which === 'all' ? undefined : [which];
    const answer = await methodOf(caller)('notifications.deadLetters.replay', { ...(ids ? { ids } : {}), ...(values.where === 'current' ? { toCurrent: true } : {}) });
    const body = isRecord(answer) ? answer : {};
    const count = (key: string): number => (typeof body[key] === 'number' ? body[key] : 0);
    const results = Array.isArray(body['results']) ? body['results'].filter(isRecord) : [];
    if (results.length === 0 || count('notFound') === results.length) {
      if (ids) throw new CapabilityRefusal(`No failed notification has the id ${which}.`, 'Choose one from the failed notifications');
      return { text: 'No notification had failed; nothing was sent.', data: { results: [] } };
    }
    const moved = count('destinationChanged');
    return {
      text: `Sent again: ${count('delivered')} delivered, ${count('retrying')} waiting for another attempt, ${count('failed')} failed again${moved > 0 ? `, ${moved} not sent because the channel now posts somewhere else (choose "where the channel posts now" to send them there)` : ''}.`,
      data: { results },
    };
  },
};

/** The handler capabilities (the list, its addresses, a test and a send; a resend over the daemon's method). */
export const NOTIFY_CAPABILITIES: readonly CapabilityDefinition<NotifyCapabilityServices>[] = [
  NOTIFY_LIST, NOTIFY_ADD, NOTIFY_REMOVE, NOTIFY_CLEAR, NOTIFY_TEST, NOTIFY_SEND, NOTIFY_RESEND,
];

/**
 * The same address kept once: two members whose stored addresses are the same (the terminal app's and the Agent's
 * list each held it under its own key) leave the later one out of the list. Its stored address is not deleted (a
 * 3.5.0 program's own list may still name it). A member whose address cannot be read is kept as it is.
 */
export async function dedupeNotificationAddresses(entries: readonly string[], secrets: NotificationWebhookSecretStore): Promise<readonly string[]> {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const entry of entries) {
    let url: string | null = null;
    try { url = await resolveNotificationWebhook(entry, secrets); } catch { url = null; }
    if (url !== null && seen.has(url)) continue;
    if (url !== null) seen.add(url);
    kept.push(entry);
  }
  return kept;
}

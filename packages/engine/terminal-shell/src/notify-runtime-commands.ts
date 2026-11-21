/**
 * `/notify` and `/notifications`, described once (command-actions/) for both
 * terminal apps: the webhook addresses notifications go to (each kept in the
 * secret store, the settings list holding its reference), a test, a send, the
 * notifications that failed and resending them; and the history view.
 */
import { isSecretReferenceValue, type ConfigManager } from '@goodvibes/engine/platform/platform/config';
import {
  forgetNotificationWebhook,
  notificationWebhookSecretKey,
  resolveNotificationWebhook,
  shownNotificationWebhook,
  storeNotificationWebhook,
  type NotificationDeadLetter,
  type NotificationDeadLetterSource,
  type NotificationWebhookSecretStore,
  type WebhookNotifier,
} from '@goodvibes/engine/platform/platform/integrations';
import type { TerminalCommandRegistry } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
import { doAction, listInput, readAction, textInput } from './described-command-kit.js';
interface NotifyContext {
  readonly platform: {
    readonly configManager: Pick<ConfigManager, 'getCategory' | 'mergeCategory'>;
    /** Where each webhook URL is kept; the settings list holds a reference to it. */
    readonly secretsManager?: NotificationWebhookSecretStore | null | undefined;
  };
  print(message: string): void;
}

/** The part of a dead-letter id a person types: the random tail after the last colon. */
function shortDeadLetterId(id: string): string {
  const tail = id.slice(id.lastIndexOf(':') + 1);
  return tail || id;
}

function formatDeadLetter(entry: NotificationDeadLetter): string {
  const when = new Date(entry.deadAt).toLocaleString();
  const status = entry.status !== undefined ? ` (HTTP ${entry.status})` : '';
  const summary = entry.summary.split('\n').map((line) => line.trim()).filter(Boolean).join(': ');
  return `  ${shortDeadLetterId(entry.id)}  ${entry.channel}  ${when}  ${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'}  ${entry.finalError}${status}\n      ${summary}`;
}

export interface NotifyHost<Context> {
  readonly webhookNotifier: (context: Context) => Pick<WebhookNotifier, 'setUrls' | 'send' | 'test' | 'listDeadLetters' | 'replayDeadLetters' | 'targetProblem'>;
  /** Other notifiers whose failed notifications "See notifications that failed" and the resend also cover (the Slack and Discord one). */
  readonly deadLetterSources?: ((context: Context) => readonly NotificationDeadLetterSource[]) | undefined;
}

const EMPTY_LIST = 'No webhook addresses are set. Add one with /notify add <address>.';

let hostOf: NotifyHost<NotifyContext> | undefined;
function host(): NotifyHost<NotifyContext> {
  if (!hostOf) throw commandRefusal('/notify is not wired in this program.');
  return hostOf;
}

/** The stored webhook references (each a goodvibes://secrets/ reference to a stored URL). */
function storedUrls(context: NotifyContext): string[] {
  const notifications = context.platform.configManager.getCategory('notifications');
  return Array.isArray(notifications.webhookUrls) ? [...notifications.webhookUrls] : [];
}
/**
 * The list as it may be written: 3.3.1 saved plain addresses in it, and a
 * settings write now admits only references. Before an add or a remove writes
 * the list, each plain address is stored in the secret store and replaced by
 * its reference, so it keeps being sent to. Done once: afterwards every member
 * is a reference.
 */
async function writableUrls(context: NotifyContext, secrets: Parameters<typeof storeNotificationWebhook>[1], created: string[] = []): Promise<string[]> {
  const urls: string[] = [];
  for (const entry of storedUrls(context)) {
    if (isSecretReferenceValue(entry)) urls.push(entry);
    else {
      const reference = await storeNotificationWebhook(entry, secrets);
      created.push(reference);
      urls.push(reference);
    }
  }
  return urls;
}
/**
 * Delete the stored URL each removed list member names, and say which were
 * not deleted: a failed delete, or a session with no secret store, leaves the
 * key (which carries posting rights) in the store with nothing referring to it,
 * so each such key is named with the command that deletes it.
 */
async function forgetRemovedWebhooks(entries: readonly string[], secrets: NotificationWebhookSecretStore | undefined): Promise<string[]> {
  const kept: string[] = [];
  for (const entry of entries) {
    const key = notificationWebhookSecretKey(entry);
    if (key === null) continue;
    let reason: string | undefined;
    if (!secrets) reason = 'this session has no secret store';
    else {
      try {
        await forgetNotificationWebhook(entry, secrets);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (reason !== undefined) kept.push(`its stored key was not deleted (${reason}); it is kept as ${key}; delete it with /secrets delete ${key}.`);
  }
  return kept;
}
async function resolveUrl(context: NotifyContext, entry: string): Promise<string | null> {
  const secrets = context.platform.secretsManager ?? undefined;
  return secrets ? resolveNotificationWebhook(entry, secrets) : null;
}
function deadLetters(context: NotifyContext): { readonly sources: readonly NotificationDeadLetterSource[]; readonly entries: readonly NotificationDeadLetter[] } {
  const sources: readonly NotificationDeadLetterSource[] = [host().webhookNotifier(context), ...(host().deadLetterSources?.(context) ?? [])];
  return { sources, entries: sources.flatMap((source) => source.listDeadLetters()).sort((a, b) => a.deadAt - b.deadAt) };
}

const WEBHOOKS = defineList<NotifyContext>({
  name: 'notify.webhooks',
  async read(context) {
    const urls = storedUrls(context);
    const resolved = await Promise.all(urls.map((entry) => resolveUrl(context, entry)));
    return resolved.map((url, index): ListRow => ({ value: String(index + 1), label: shownNotificationWebhook(url) }));
  },
  operator: { terminalOnly: 'the addresses are kept in this program\'s secret store' },
});
const FAILED = defineList<NotifyContext>({
  name: 'notify.failed',
  async read(context) {
    return [
      { value: 'all', label: 'Every failed notification' },
      ...deadLetters(context).entries.map((entry): ListRow => ({ value: shortDeadLetterId(entry.id), label: entry.summary.split('\n')[0] ?? entry.id, detail: `${entry.channel}, ${entry.finalError}` })),
    ];
  },
  operator: { method: 'notifications.deadLetters.list', input: {}, rows: { from: 'deadLetters', value: 'id', label: 'summary', detail: 'channel' } },
});

/** Register `/notify` (webhook notification addresses) and `/notifications` (the history view), one description for both apps. */
export function registerNotifyCommands<Context extends NotifyContext & CommandActionContext & { readonly openNotifications?: (() => void) | undefined }>(
  registry: Pick<TerminalCommandRegistry<Context>, 'register'>,
  notifyHost: NotifyHost<Context>,
): void {
  hostOf = notifyHost as unknown as NotifyHost<NotifyContext>;
  registry.register(defineCommand<Context>({
    name: 'notifications',
    title: 'Notification history',
    summary: 'Every notice and notification in full, newest first; Enter goes to its subject',
    group: 'Notifications',
    actions: [doAction<Context>({
      id: 'open', label: 'Open the notification history', word: '',
      sentence: 'Opens every notice and notification collected, newest first.',
      operator: { terminalOnly: 'it opens a view of this terminal' },
      async run(_values, context) {
        if (!context.openNotifications) throw commandRefusal('The notification history needs the interactive shell.');
        context.openNotifications();
        return undefined;
      },
    })],
  }));
  registry.register({
    ...defineCommand<Context>({
    // --yes answers the question only right after the action word: the same word inside a message is text.
    leadingFlagsOnly: true,
    name: 'notify',
    title: 'Webhook notifications',
    summary: 'The webhook addresses (ntfy.sh format) notifications go to: add, remove, test, send, and resend the ones that failed',
    group: 'Notifications',
    report: 'list',
    actions: [
      readAction<Context>({
        id: 'list', label: 'See where notifications go', word: 'list',
        inputs: [{ id: 'show', label: 'Addresses', help: 'Each address carries its key, so only its site is shown unless you ask', kind: 'choice',
          choices: [{ value: 'no', label: 'Show only each site' }, { value: 'yes', label: 'Show the full addresses', risk: 'loosens-a-protection' }],
          required: { default: 'no', defaultMeans: 'only each site' }, typed: { flag: '--show', switchOn: 'yes' } }],
        sentence: 'Lists the webhook addresses notifications go to, by number.', example: { show: 'yes' },
        operator: { terminalOnly: 'the addresses are kept in this program\'s secret store' },
        async run(values, context) {
          const urls = storedUrls(context);
          if (urls.length === 0) return EMPTY_LIST;
          const full = values.show === 'yes';
          const resolved = await Promise.all(urls.map((entry) => resolveUrl(context, entry)));
          return [`Webhook addresses (${urls.length}):`, ...resolved.map((url, index) => `  ${index + 1}. ${full && url !== null ? url : shownNotificationWebhook(url)}`),
            ...(full ? [] : ['Remove one by its number: /notify remove <n>. Show the full addresses: /notify list --show.'])].join('\n');
        },
      }),
      {
        id: 'add', label: 'Send notifications to an address', word: 'add',
        inputs: [{ id: 'url', label: 'Address', help: 'A webhook address such as https://ntfy.sh/my-topic; it carries its key, so it is kept secret', kind: 'secret', required: true, typed: { position: 1 } }],
        sentence: 'Notifications also go to the address you gave, kept in the secret store, until you change it.', done: '',
        touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'remove',
        operator: { terminalOnly: 'the address is kept in this program\'s secret store' },
        example: {},
        async run(values, context) {
          const url = values.url!;
          const secrets = context.platform.secretsManager ?? undefined;
          if (!secrets) throw commandRefusal('Nothing was added: this session has no secret store, and a webhook address carries its key, so it is never written into the settings file.');
          let target: URL;
          try {
            target = new URL(url);
          } catch {
            throw commandRefusal('Nothing was added: that is not an address. Give the full address, for example https://ntfy.sh/my-topic.');
          }
          if (target.protocol !== 'http:' && target.protocol !== 'https:') throw commandRefusal(`Nothing was added: ${target.protocol} addresses cannot be delivered to; use an http or https webhook address.`);
          // The delivery's own rule: a stored address it refuses would only ever fail. A host on the
          // owner's network is admitted once it is listed in network.privateDeliveryHosts, and the refusal says so.
          const notifier = host().webhookNotifier(context);
          const problem = notifier.targetProblem(url);
          if (problem !== undefined) throw commandRefusal(`Nothing was added: ${problem}`);
          if ((await Promise.all(storedUrls(context).map((entry) => resolveUrl(context, entry)))).includes(url)) return `Already set: ${shownNotificationWebhook(url)}`;
          // References this call creates: one for each plain address the list held, and the new address's.
          const created: string[] = [];
          let urls: string[];
          try {
            urls = await writableUrls(context, secrets, created);
            // The address goes to the secret store; the list keeps its reference.
            const reference = await storeNotificationWebhook(url, secrets);
            created.push(reference);
            urls.push(reference);
            context.platform.configManager.mergeCategory('notifications', { webhookUrls: urls });
          } catch (error) {
            // The list was not written, so nothing refers to what this call stored: forget all of it.
            for (const entry of created) await forgetNotificationWebhook(entry, secrets).catch(() => undefined);
            throw error;
          }
          notifier.setUrls(urls);
          return `Webhook added: ${shownNotificationWebhook(url)} (kept in the secret store; the settings list holds its reference)`;
        },
      },
      {
        id: 'remove', label: 'Stop sending to an address', word: 'remove',
        inputs: [listInput({ id: 'address', label: 'Address', help: 'The addresses by number, as /notify list shows them', list: WEBHOOKS })],
        sentence: 'Notifications stop going to address {address}, until you change it; its stored key is deleted.', done: '',
        touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'add',
        operator: { terminalOnly: 'the addresses are kept in this program\'s secret store' },
        example: { address: '1' },
        async run(values, context) {
          const secrets = context.platform.secretsManager ?? undefined;
          const urls = secrets ? await writableUrls(context, secrets) : storedUrls(context);
          const index = Number(values.address) - 1;
          const entry = Number.isInteger(index) ? urls[index] : undefined;
          if (entry === undefined) throw commandRefusal(`No address has the number ${values.address}; /notify list shows ${urls.length === 0 ? 'none set' : `1 to ${urls.length}`}.`);
          const shown = shownNotificationWebhook(await resolveUrl(context, entry));
          const next = urls.filter((_, at) => at !== index);
          context.platform.configManager.mergeCategory('notifications', { webhookUrls: next });
          host().webhookNotifier(context).setUrls(next);
          const kept = await forgetRemovedWebhooks([entry], secrets);
          return kept.length === 0 ? `Webhook removed: ${shown}` : `Webhook removed: ${shown}; ${kept[0]}`;
        },
      },
      {
        id: 'clear', label: 'Stop sending to every address', word: 'clear', inputs: [],
        sentence: 'Every webhook address is removed and its stored key deleted.', done: '',
        touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { terminalOnly: 'the addresses are kept in this program\'s secret store' },
        example: {},
        async run(_values, context) {
          const urls = storedUrls(context);
          context.platform.configManager.mergeCategory('notifications', { webhookUrls: [] });
          host().webhookNotifier(context).setUrls([]);
          const kept = await forgetRemovedWebhooks(urls, context.platform.secretsManager ?? undefined);
          if (kept.length === 0) return 'All webhook addresses cleared.';
          return ['All webhook addresses cleared, but for some the stored key remains:', ...kept.map((line) => `  ${line.charAt(0).toUpperCase()}${line.slice(1)}`)].join('\n');
        },
      },
      doAction<Context>({
        id: 'test', label: 'Send a test notification', word: 'test',
        sentence: 'A test notification is sent to every address, and each one\'s answer is shown.',
        touches: 'another-machine', risk: 'sends-out',
        operator: { terminalOnly: 'the addresses are kept in this program\'s secret store' },
        async run(_values, context) {
          const urls = storedUrls(context);
          if (urls.length === 0) return EMPTY_LIST;
          const notifier = host().webhookNotifier(context);
          notifier.setUrls(urls);
          const results = await notifier.test();
          // A result names the list member (its reference); the site is read back for the line.
          const shown = await Promise.all(results.map(async (result) => shownNotificationWebhook(await resolveUrl(context, result.url))));
          return results.map((result, i) => (result.ok ? `  [ok] ${shown[i]}` : `  [fail] ${shown[i]}: ${result.error ?? 'unknown error'}`)).join('\n');
        },
      }),
      doAction<Context>({
        id: 'send', label: 'Send a notification', word: 'send',
        inputs: [textInput({ id: 'message', label: 'Message', help: 'What the notification says', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
        sentence: '"{message}" is sent to every webhook address.', example: { message: 'Build is green' },
        touches: 'another-machine', risk: 'sends-out',
        operator: { terminalOnly: 'the addresses are kept in this program\'s secret store' },
        async run(values, context) {
          const urls = storedUrls(context);
          if (urls.length === 0) return EMPTY_LIST;
          const notifier = host().webhookNotifier(context);
          notifier.setUrls(urls);
          const result = await notifier.send(values.message!);
          const reached = result.failed === 0 ? 'Notification sent' : result.delivered === 0 ? 'Notification not delivered' : 'Notification partly delivered';
          return [
            `${reached}: delivered to ${result.delivered} of ${result.attempted} target${result.attempted === 1 ? '' : 's'}`,
            ...result.results.slice(0, 20).map((delivery, index) => `  target ${index + 1} ${delivery.ok ? 'ok' : `failed${delivery.error ? ` (${delivery.error})` : ''}`}`),
            ...(result.results.length > 20 ? [`  ${result.results.length - 20} more target(s) omitted.`] : []),
          ].join('\n');
        },
      }),
      readAction<Context>({
        id: 'failed', label: 'See notifications that failed', word: 'failed',
        sentence: 'Lists the notifications that could not be delivered, oldest first, with why.',
        operator: { method: 'notifications.deadLetters.list', fields: {} },
        async run(_values, context) {
          const { sources, entries } = deadLetters(context);
          const dropped = sources.reduce((sum, source) => sum + (source.droppedDeadLetters?.() ?? 0), 0);
          const droppedLine = dropped > 0
            ? [`${dropped} older failed notification${dropped === 1 ? ' was' : 's were'} dropped because the list was full (integrations.delivery.maxDlqSize); ${dropped === 1 ? 'it' : 'they'} cannot be resent.`]
            : [];
          return entries.length === 0 ? ['No failed notifications.', ...droppedLine].join('\n')
            : [`Failed notifications (${entries.length}), oldest first:`, ...entries.map(formatDeadLetter), ...droppedLine, 'Resend one with /notify resend <id>, or all with /notify resend all.'].join('\n');
        },
      }),
      doAction<Context>({
        id: 'resend', label: 'Send failed notifications again', word: 'resend',
        inputs: [
          listInput({ id: 'which', label: 'Which', help: 'One failed notification, or all of them', list: FAILED, other: 'a failed notification\'s id' }),
          { id: 'where', label: 'Where', help: 'Where a Slack or Discord channel that moved since posts', kind: 'choice',
            choices: [{ value: 'same', label: 'Where it was going' }, { value: 'current', label: 'Where the channel posts now' }],
            required: { default: 'same', defaultMeans: 'where it was going' }, typed: { flag: '--to-current', switchOn: 'current' } },
        ],
        sentence: 'The failed notification {which} is sent again.', example: { which: 'all' },
        touches: 'another-machine', risk: 'sends-out',
        operator: { terminalOnly: 'a failed notification is named by the short id the terminal lists, or all' },
        async run(values, context) {
          const { sources, entries } = deadLetters(context);
          const which = values.which!;
          const toCurrent = values.where === 'current';
          const ids = which === 'all' ? entries.map((entry) => entry.id) : entries.filter((entry) => entry.id === which || shortDeadLetterId(entry.id) === which).map((entry) => entry.id);
          if (ids.length === 0) {
            if (which !== 'all') throw commandRefusal(`No failed notification has the id ${which}.`, 'List them with /notify failed.');
            return 'No failed notifications.';
          }
          const results = new Map<string, string>();
          const moved: string[] = [];
          for (const source of sources) {
            for (const result of await source.replayDeadLetters(ids, { toCurrent })) {
              if (result.outcome !== 'not-found' || !results.has(result.id)) results.set(result.id, result.outcome);
              if (result.outcome === 'destination-changed' && result.reason) moved.push(`  ${shortDeadLetterId(result.id)}: ${result.reason}`);
            }
          }
          const count = (outcome: string) => [...results.values()].filter((value) => value === outcome).length;
          const changed = count('destination-changed');
          const failed = count('dead_letter');
          return [
            `Resent ${ids.length - changed} of ${ids.length} notification${ids.length === 1 ? '' : 's'}: ${count('delivered')} delivered, ${count('retrying')} queued for another attempt, ${failed} failed again${changed > 0 ? `, ${changed} not sent because the channel now posts somewhere else` : ''}.`,
            ...(failed > 0 ? ['The ones that failed again are back in /notify failed.'] : []),
            ...(changed > 0 ? [...moved, `Resend them to where the channel posts now with /notify resend ${which} --to-current.`] : []),
          ].join('\n');
        },
      }),
    ],
  }) });
}

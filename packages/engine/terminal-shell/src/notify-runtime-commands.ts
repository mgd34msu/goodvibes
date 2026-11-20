import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import {
  forgetNotificationWebhook,
  resolveNotificationWebhook,
  shownNotificationWebhook,
  storeNotificationWebhook,
  type NotificationDeadLetter,
  type NotificationDeadLetterSource,
  type NotificationWebhookSecretStore,
  type WebhookNotifier,
} from '@goodvibes-jev/engine/platform/platform/integrations';
import { secretArg, type TerminalCommandRegistry } from './command-registry.js';
import { commandRefusal, stripYesFlag, takeYesFromText } from './command-confirmation.js';
interface NotifyContext {
  readonly platform: {
    readonly configManager: Pick<ConfigManager, 'getCategory' | 'mergeCategory'>;
    /** Where each webhook URL is kept; the settings list holds a reference to it. */
    readonly secretsManager?: NotificationWebhookSecretStore | null | undefined;
  };
  print(message: string): void;
}

/**
 * Where a `/notify add <url>` or `/notify remove <url>` line holds a URL: the
 * word after the subcommand (`--yes` is not a word of the line). A webhook URL
 * carries its key, so the input history keeps `<redacted>` there and the
 * handler reads it with `secretArg`. A list number is not a URL.
 */
function notifyUrlPositions(args: readonly string[]): number[] {
  const words = args.map((token, index) => ({ token, index })).filter((entry) => entry.token !== '--yes');
  const sub = words[0]?.token.toLowerCase();
  const target = words[1];
  if (!target || (sub !== 'add' && sub !== 'remove')) return [];
  return sub === 'remove' && /^\d+$/.test(target.token) ? [] : [target.index];
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

export function createNotifyRuntimeCommands<Context extends NotifyContext>(
  requireWebhookNotifier: (context: Context) => Pick<WebhookNotifier, 'setUrls' | 'send' | 'test' | 'listDeadLetters' | 'replayDeadLetters' | 'targetProblem'>,
  policy: {
    /** Other notifiers whose failed notifications `/notify failed` and `/notify resend` also cover (the Slack and Discord one). */
    readonly deadLetterSources?: ((context: Context) => readonly NotificationDeadLetterSource[]) | undefined;
    readonly description: string;
    readonly usage: string;
    readonly argsHint: string;
    readonly maskUrls: boolean;
    readonly allowSend: boolean;
  },
) {
  const emptyList = `No webhook URLs configured. Add one with /notify add <url>`;
  /** A URL as the transcript shows it: the path holds the secret topic or token, so a masked policy shows only the origin. */
  const shownUrl = (url: string | null): string => (!policy.maskUrls && url !== null ? url : shownNotificationWebhook(url));
  function registerNotifyRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    registry.register({
      name: 'notify',
      effect: 'external-network',
      // The message is free text, sent as typed; a first or last --yes confirms.
      rawRest: (args) => (args[0]?.toLowerCase() === 'send' ? 1 : undefined),
      aliases: [],
      description: policy.description,
      usage: policy.usage,
      argsHint: policy.argsHint,
      secretArgs: { select: notifyUrlPositions },
      async handler(args, ctx) {
        const parsed = { rest: stripYesFlag(args).rest };
        const commandArgs = [...parsed.rest];
        const notifications = ctx.platform.configManager.getCategory('notifications');
        // Each member is a goodvibes://secrets/ reference to a stored URL.
        const urls: string[] = Array.isArray(notifications.webhookUrls) ? [...notifications.webhookUrls] : [];
        const notifier = requireWebhookNotifier(ctx);
        const sub = commandArgs[0];
        const secrets = ctx.platform.secretsManager ?? undefined;
        const resolve = async (entry: string): Promise<string | null> => secrets ? resolveNotificationWebhook(entry, secrets) : null;

        if (!sub || sub === 'list') {
          const showFull = !policy.maskUrls || commandArgs.includes('--show');
          if (urls.length === 0) ctx.print(emptyList);
          else {
            // --show is the owner's explicit request to see the stored URLs.
            const resolved = await Promise.all(urls.map(resolve));
            const display = resolved.map((url, i) => `  ${i + 1}. ${showFull && url !== null ? url : shownNotificationWebhook(url)}`);
            ctx.print([
              `Webhook URLs (${urls.length}):`,
              ...display,
              ...(showFull ? [] : [`Remove one by its number: /notify remove <n>. Reveal the full URLs: /notify list --show.`]),
            ].join('\n'));
          }
          return;
        }

        if (sub === 'add') {
          const position = notifyUrlPositions(args)[0];
          // Read through the declared secret position, which the input history masked.
          const url = position === undefined ? undefined : secretArg(position).reveal('store-write');
          if (!url) {
            throw commandRefusal(`Usage: /notify add <url>\nExample: /notify add https://ntfy.sh/my-topic`);
          }
          if (!secrets) {
            throw commandRefusal('Nothing was added: this session has no secret store, and a webhook URL carries its key, so it is never written into the settings file.');
          }
          let target: URL;
          try {
            target = new URL(url);
          } catch {
            throw commandRefusal(`Nothing was added: that is not a URL. Give the full address, for example https://ntfy.sh/my-topic.`);
          }
          if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            throw commandRefusal(`Nothing was added: ${target.protocol} addresses cannot be delivered to; use an http or https webhook URL.`);
          }
          // The delivery's own rule: a stored URL it refuses would only ever fail. A host on the
          // owner's network is admitted once it is listed in network.privateDeliveryHosts, and the refusal says so.
          const problem = notifier.targetProblem(url);
          if (problem !== undefined) {
            throw commandRefusal(`Nothing was added: ${problem}`);
          }
          if ((await Promise.all(urls.map(resolve))).includes(url)) {
            ctx.print(`Already configured: ${shownUrl(url)}`);
            return;
          }
          // The URL goes to the secret store; the list keeps its reference.
          const reference = await storeNotificationWebhook(url, secrets);
          urls.push(reference);
          try {
            ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: urls });
          } catch (error) {
            await forgetNotificationWebhook(reference, secrets).catch(() => undefined);
            throw error;
          }
          notifier.setUrls(urls);
          ctx.print(`Webhook added: ${shownUrl(url)} (kept in the secret store; the settings list holds its reference)`);
          return;
        }

        if (sub === 'remove') {
          const given = commandArgs[1];
          if (!given) {
            throw commandRefusal(`Usage: /notify remove <n|url>  (n is the number /notify list shows)`);
          }
          // The list number names a stored URL without printing its secret topic to remove it;
          // a typed URL is a declared secret position and is matched against the stored ones.
          const position = /^\d+$/.test(given) ? Number(given) : undefined;
          const typedPosition = position === undefined ? notifyUrlPositions(args)[0] : undefined;
          const typed = typedPosition === undefined ? undefined : secretArg(typedPosition).reveal('dispatch');
          const resolved = await Promise.all(urls.map(resolve));
          const index = position !== undefined ? position - 1 : resolved.findIndex((url) => url !== null && url === typed);
          const entry = urls[index];
          if (position !== undefined && entry === undefined) {
            throw commandRefusal(`No webhook has the number ${given}; /notify list shows ${urls.length === 0 ? 'none configured' : `1 to ${urls.length}`}.`);
          }
          if (entry === undefined) {
            throw commandRefusal(`Not found: ${shownUrl(typed ?? null)}. /notify list shows the stored URLs by number.`);
          }
          const next = urls.filter((_, at) => at !== index);
          ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: next });
          notifier.setUrls(next);
          if (secrets) await forgetNotificationWebhook(entry, secrets).catch(() => undefined);
          ctx.print(`Webhook removed: ${shownUrl(resolved[index] ?? null)}`);
          return;
        }

        if (sub === 'clear') {
          ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: [] });
          notifier.setUrls([]);
          if (secrets) for (const entry of urls) await forgetNotificationWebhook(entry, secrets).catch(() => undefined);
          ctx.print('All webhook URLs cleared.');
          return;
        }

        if (sub === 'test') {
          if (urls.length === 0) {
            ctx.print(emptyList);
            return;
          }
          ctx.print(`Testing ${urls.length} webhook${urls.length !== 1 ? 's' : ''}...`);
          notifier.setUrls(urls);
          const results = await notifier.test();
          // A result names the list member (its reference); the host is read back for the line.
          const shown = await Promise.all(results.map(async (r) => shownUrl(await resolve(r.url))));
          ctx.print(
            results
              .map((r, i) => (r.ok ? `  [ok] ${shown[i]}` : `  [fail] ${shown[i]}: ${r.error ?? 'unknown error'}`))
              .join('\n'),
          );
          return;
        }

        if (policy.allowSend && sub === 'send') {
          const typed = takeYesFromText(commandArgs.slice(1).join(' '));
          const message = typed.text;
          if (!message) {
            throw commandRefusal(`Usage: /notify send <message>`);
          }
          if (urls.length === 0) {
            ctx.print(emptyList);
            return;
          }
          notifier.setUrls(urls);
          const result = await notifier.send(message);
          const reached = result.failed === 0 ? 'Notification sent' : result.delivered === 0 ? 'Notification not delivered' : 'Notification partly delivered';
          ctx.print(
            [
              `${reached}: delivered to ${result.delivered} of ${result.attempted} target${result.attempted === 1 ? '' : 's'}`,
              `  attempted ${result.attempted}`,
              `  delivered ${result.delivered}`,
              `  failed ${result.failed}`,
              ...result.results
                .slice(0, 20)
                .map(
                  (delivery, index) =>
                    `  target ${index + 1} ${delivery.ok ? 'ok' : `failed${delivery.error ? ` (${delivery.error})` : ''}`}`,
                ),
              ...(result.results.length > 20 ? [`  ${result.results.length - 20} more target(s) omitted.`] : []),
            ].join('\n'),
          );
          return;
        }

        if (sub === 'failed' || sub === 'resend') {
          const sources: readonly NotificationDeadLetterSource[] = [notifier, ...(policy.deadLetterSources?.(ctx) ?? [])];
          const entries = sources.flatMap((source) => source.listDeadLetters()).sort((a, b) => a.deadAt - b.deadAt);
          if (sub === 'failed') {
            ctx.print(entries.length === 0
              ? 'No failed notifications.'
              : [`Failed notifications (${entries.length}), oldest first:`, ...entries.map(formatDeadLetter),
                `Resend one with /notify resend <id>, or all with /notify resend all.`].join('\n'));
            return;
          }
          const toCurrent = commandArgs.includes('--to-current');
          const which = commandArgs.slice(1).find((arg) => arg !== '--to-current');
          if (!which) {
            throw commandRefusal(`Usage: /notify resend <id|all> [--to-current]\nList them with /notify failed.`);
          }
          const ids = which === 'all'
            ? entries.map((entry) => entry.id)
            : entries.filter((entry) => entry.id === which || shortDeadLetterId(entry.id) === which).map((entry) => entry.id);
          if (ids.length === 0) {
            if (which !== 'all') throw commandRefusal(`No failed notification has the id ${which}.`, 'List them with /notify failed.');
            ctx.print('No failed notifications.');
            return;
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
          const delivered = count('delivered');
          const retrying = count('retrying');
          const failed = count('dead_letter');
          const changed = count('destination-changed');
          ctx.print([
            `Resent ${ids.length - changed} of ${ids.length} notification${ids.length === 1 ? '' : 's'}: ${delivered} delivered, ${retrying} queued for another attempt, ${failed} failed again${changed > 0 ? `, ${changed} not sent because the channel now posts somewhere else` : ''}.`,
            ...(failed > 0 ? ['The ones that failed again are back in /notify failed.'] : []),
            ...(changed > 0 ? [...moved, `Resend them to where the channel posts now with /notify resend ${which} --to-current.`] : []),
          ].join('\n'));
          return;
        }

        ctx.print('Usage: /notify ' + policy.usage + ' | failed | resend <id|all> [--to-current]');
      },
    });
  }
  return { registerNotifyRuntimeCommands };
}

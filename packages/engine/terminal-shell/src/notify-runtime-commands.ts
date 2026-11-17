import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { NotificationDeadLetter, NotificationDeadLetterSource, WebhookNotifier } from '@goodvibes-jev/engine/platform/platform/integrations';
import { classifyHostTrustTier, extractHostname } from '@goodvibes-jev/engine/platform/platform/tools';
import type { TerminalCommandRegistry } from './command-registry.js';
import { commandRefusal, requireYesFlag, stripYesFlag } from './command-confirmation.js';
interface NotifyContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'getCategory' | 'mergeCategory'> };
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

export function createNotifyRuntimeCommands<Context extends NotifyContext>(
  requireWebhookNotifier: (context: Context) => Pick<WebhookNotifier, 'setUrls' | 'send' | 'test' | 'listDeadLetters' | 'replayDeadLetters'>,
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
  const suffix = '';
  const emptyList = `No webhook URLs configured. Add one with /notify add <url>${suffix}`;
  /** A stored URL as the transcript shows it: the path holds the secret topic or token, so a masked policy shows only the origin. */
  const shownUrl = (url: string): string => {
    if (!policy.maskUrls) return url;
    try {
      const parsedUrl = new URL(url);
      return parsedUrl.pathname === '/' && !parsedUrl.search ? parsedUrl.origin : `${parsedUrl.origin}/…`;
    } catch {
      return '(invalid URL)';
    }
  };
  function registerNotifyRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    registry.register({
      name: 'notify',
      effect: 'external-network',
      aliases: [],
      description: policy.description,
      usage: policy.usage,
      argsHint: policy.argsHint,
      async handler(args, ctx) {
        const parsed = { rest: stripYesFlag(args).rest, yes: true };
        const commandArgs = [...parsed.rest];
        const notifications = ctx.platform.configManager.getCategory('notifications');
        const urls: string[] = Array.isArray(notifications.webhookUrls) ? [...notifications.webhookUrls] : [];
        const notifier = requireWebhookNotifier(ctx);
        const sub = commandArgs[0];

        if (!sub || sub === 'list') {
          const showFull = !policy.maskUrls || (commandArgs.includes('--show') && parsed.yes);
          if (urls.length === 0) ctx.print(emptyList);
          else {
            const display = urls.map((u, i) => `  ${i + 1}. ${showFull ? u : shownUrl(u)}`);
            ctx.print([
              `Webhook URLs (${urls.length}):`,
              ...display,
              ...(showFull ? [] : [`Remove one by its number: /notify remove <n>${suffix}. Reveal the full URLs: /notify list --show${suffix}.`]),
            ].join('\n'));
          }
          return;
        }

        if (sub === 'add') {
          const url = commandArgs[1];
          if (!url) {
            throw commandRefusal(`Usage: /notify add <url>${suffix}\nExample: /notify add https://ntfy.sh/my-topic${suffix}`);
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, `add webhook notification URL ${shownUrl(url)}`, `/notify add <url>${suffix}`);
            return;
          }
          let target: URL;
          try {
            target = new URL(url);
          } catch {
            ctx.print(`Nothing was added: that is not a URL. Give the full address, for example https://ntfy.sh/my-topic.`);
            return;
          }
          if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            ctx.print(`Nothing was added: ${target.protocol} addresses cannot be delivered to; use an http or https webhook URL.`);
            return;
          }
          // Delivery refuses these hosts, so a stored URL for one would only ever fail silently.
          const hostname = extractHostname(url);
          const trust = hostname === null ? null : classifyHostTrustTier(hostname);
          if (trust !== null && (trust.tier === 'blocked' || trust.tier === 'localhost')) {
            ctx.print(`Nothing was added: delivery never sends to ${shownUrl(url)} (${trust.reason}). Use a public http or https webhook URL.`);
            return;
          }
          if (urls.includes(url)) {
            ctx.print(`Already configured: ${shownUrl(url)}`);
            return;
          }
          urls.push(url);
          ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: urls });
          notifier.setUrls(urls);
          ctx.print(`Webhook added: ${shownUrl(url)}`);
          return;
        }

        if (sub === 'remove') {
          const given = commandArgs[1];
          if (!given) {
            throw commandRefusal(`Usage: /notify remove <n|url>${suffix}  (n is the number /notify list shows)`);
          }
          // The list number names a stored URL without printing its secret topic to remove it.
          const position = /^\d+$/.test(given) ? Number(given) : undefined;
          const url = position !== undefined ? urls[position - 1] : given;
          if (url === undefined) {
            ctx.print(`No webhook has the number ${given}; /notify list shows ${urls.length === 0 ? 'none configured' : `1 to ${urls.length}`}.`);
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, `remove webhook notification URL ${shownUrl(url)}`, `/notify remove <n|url>${suffix}`);
            return;
          }
          const next = urls.filter((u) => u !== url);
          if (next.length === urls.length) {
            throw commandRefusal(`Not found: ${shownUrl(url)}. /notify list shows the stored URLs by number.`);
          }
          ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: next });
          notifier.setUrls(next);
          ctx.print(`Webhook removed: ${shownUrl(url)}`);
          return;
        }

        if (sub === 'clear') {
          if (!parsed.yes) {
            requireYesFlag(ctx, 'clear all webhook notification URLs', `/notify clear${suffix}`);
            return;
          }
          ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: [] });
          notifier.setUrls([]);
          ctx.print('All webhook URLs cleared.');
          return;
        }

        if (sub === 'test') {
          if (!parsed.yes) {
            requireYesFlag(ctx, 'send webhook notification test requests', `/notify test${suffix}`);
            return;
          }
          if (urls.length === 0) {
            ctx.print(emptyList);
            return;
          }
          ctx.print(`Testing ${urls.length} webhook${urls.length !== 1 ? 's' : ''}...`);
          notifier.setUrls(urls);
          const results = await notifier.test();
          ctx.print(
            results
              .map((r) => {
                const shown = shownUrl(r.url);
                return r.ok ? `  [ok] ${shown}` : `  [fail] ${shown}: ${r.error ?? 'unknown error'}`;
              })
              .join('\n'),
          );
          return;
        }

        if (policy.allowSend && sub === 'send') {
          const message = commandArgs.slice(1).join(' ').trim();
          if (!message) {
            throw commandRefusal(`Usage: /notify send <message>${suffix}`);
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
                `Resend one with /notify resend <id>${suffix}, or all with /notify resend all${suffix}.`].join('\n'));
            return;
          }
          const which = commandArgs[1];
          if (!which) {
            throw commandRefusal(`Usage: /notify resend <id|all>${suffix}\nList them with /notify failed.`);
          }
          const ids = which === 'all'
            ? entries.map((entry) => entry.id)
            : entries.filter((entry) => entry.id === which || shortDeadLetterId(entry.id) === which).map((entry) => entry.id);
          if (ids.length === 0) {
            ctx.print(which === 'all' ? 'No failed notifications.' : `No failed notification has the id ${which}. List them with /notify failed.`);
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, `resend ${ids.length} failed notification${ids.length === 1 ? '' : 's'}`, `/notify resend ${which}${suffix}`);
            return;
          }
          const results = new Map<string, string>();
          for (const source of sources) {
            for (const result of await source.replayDeadLetters(ids)) {
              if (result.outcome !== 'not-found' || !results.has(result.id)) results.set(result.id, result.outcome);
            }
          }
          const count = (outcome: string) => [...results.values()].filter((value) => value === outcome).length;
          const delivered = count('delivered');
          const retrying = count('retrying');
          const failed = count('dead_letter');
          ctx.print([
            `Resent ${ids.length} notification${ids.length === 1 ? '' : 's'}: ${delivered} delivered, ${retrying} queued for another attempt, ${failed} failed again.`,
            ...(failed > 0 ? ['The ones that failed again are back in /notify failed.'] : []),
          ].join('\n'));
          return;
        }

        ctx.print('Usage: /notify ' + policy.usage + ' | failed | resend <id|all>' + suffix);
      },
    });
  }
  return { registerNotifyRuntimeCommands };
}

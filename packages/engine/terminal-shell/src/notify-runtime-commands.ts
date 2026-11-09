import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { WebhookNotifier } from '@goodvibes-jev/engine/platform/platform/integrations';
import type { TerminalCommandRegistry } from './command-registry.js';
import { requireYesFlag, stripYesFlag } from './command-confirmation.js';
interface NotifyContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'getCategory' | 'mergeCategory'> };
  print(message: string): void;
}
export function createNotifyRuntimeCommands<Context extends NotifyContext>(
  requireWebhookNotifier: (context: Context) => Pick<WebhookNotifier, 'setUrls' | 'send' | 'test'>,
  policy: {
    readonly description: string;
    readonly usage: string;
    readonly argsHint: string;
    readonly confirmMutations: boolean;
    readonly maskUrls: boolean;
    readonly allowSend: boolean;
    readonly emptyList: string;
    readonly emptyTest: string;
    readonly listSeparator: string;
    readonly failureSeparator: string;
    readonly message: (label: string, value: string) => string;
  },
) {
  const suffix = policy.confirmMutations ? ' --yes' : '';
  function registerNotifyRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    registry.register({
      name: 'notify',
      aliases: [],
      description: policy.description,
      usage: policy.usage,
      argsHint: policy.argsHint,
      async handler(args, ctx) {
        const parsed = policy.confirmMutations ? stripYesFlag(args) : { rest: args, yes: true };
        const commandArgs = [...parsed.rest];
        const notifications = ctx.platform.configManager.getCategory('notifications');
        const urls: string[] = Array.isArray(notifications.webhookUrls) ? [...notifications.webhookUrls] : [];
        const notifier = requireWebhookNotifier(ctx);
        const sub = commandArgs[0];

        if (!sub || sub === 'list') {
          const showFull = !policy.maskUrls || (commandArgs.includes('--show') && parsed.yes);
          if (urls.length === 0) ctx.print(policy.emptyList);
          else {
            const display = urls.map((u, i) => {
              if (showFull) return `  ${i + 1}. ${u}`;
              try {
                const parsedUrl = new URL(u);
                const origin = parsedUrl.origin;
                const truncPath = parsedUrl.pathname.length > 12 ? `${parsedUrl.pathname.slice(0, 12)}…` : parsedUrl.pathname;
                return `  ${i + 1}. ${origin}${truncPath} (use /notify list --show --yes to reveal full URL)`;
              } catch {
                return `  ${i + 1}. (invalid URL)`;
              }
            });
            ctx.print(`Webhook URLs (${urls.length})${policy.listSeparator}\n${display.join('\n')}`);
          }
          return;
        }

        if (sub === 'add') {
          const url = commandArgs[1];
          if (!url) {
            ctx.print(`Usage: /notify add <url>${suffix}\nExample: /notify add https://ntfy.sh/my-topic${suffix}`);
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, `add webhook notification URL ${url}`, `/notify add <url>${suffix}`);
            return;
          }
          try {
            new URL(url);
          } catch {
            ctx.print(policy.message('Invalid URL', url));
            return;
          }
          if (urls.includes(url)) {
            ctx.print(policy.message('Already configured', url));
            return;
          }
          urls.push(url);
          ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: urls });
          notifier.setUrls(urls);
          ctx.print(`Webhook added: ${url}`);
          return;
        }

        if (sub === 'remove') {
          const url = commandArgs[1];
          if (!url) {
            ctx.print(`Usage: /notify remove <url>${suffix}`);
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, `remove webhook notification URL ${url}`, `/notify remove <url>${suffix}`);
            return;
          }
          const next = urls.filter((u) => u !== url);
          if (next.length === urls.length) {
            ctx.print(`Not found: ${url}`);
            return;
          }
          ctx.platform.configManager.mergeCategory('notifications', { webhookUrls: next });
          notifier.setUrls(next);
          ctx.print(`Webhook removed: ${url}`);
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
            ctx.print(policy.emptyTest);
            return;
          }
          ctx.print(`Testing ${urls.length} webhook${urls.length !== 1 ? 's' : ''}...`);
          notifier.setUrls(urls);
          const results = await notifier.test();
          ctx.print(
            results
              .map((r) => (r.ok ? `  [ok] ${r.url}` : `  [fail] ${r.url}${policy.failureSeparator}${r.error ?? 'unknown error'}`))
              .join('\n'),
          );
          return;
        }

        if (policy.allowSend && sub === 'send') {
          const message = commandArgs.slice(1).join(' ').trim();
          if (!message) {
            ctx.print(`Usage: /notify send <message>${suffix}`);
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, 'send a notification to configured webhook targets', `/notify send <message>${suffix}`);
            return;
          }
          if (urls.length === 0) {
            ctx.print('No webhook URLs configured. Use /notify add <url>');
            return;
          }
          notifier.setUrls(urls);
          const result = await notifier.send(message);
          ctx.print(
            [
              'Notification sent',
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

        ctx.print('Usage: /notify ' + policy.usage);
      },
    });
  }
  return { registerNotifyRuntimeCommands };
}

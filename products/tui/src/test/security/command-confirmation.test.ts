// Proves: A risky command line the model runs (a mail or a notification sent out) runs without the owner's answer, or a line the owner typed in full waits on a question instead of running as typed.
// Red when: The registry stops putting a model's risky line to the owner (or a --yes the model wrote counts as his answer), so a No still sends; or the owner's own complete line asks again, or is not sent with its words as typed.

/**
 * `/mail send` and `/notify send` send something outside this machine. A line
 * the model runs is put to the owner first, whatever `--yes` it carries, and a
 * No sends nothing; the same line typed by the owner is the request and is sent
 * at once, with the words exactly as typed (a `--yes` inside the text is text).
 *
 * The app's real command registry (which applies the one confirmation rule,
 * engine terminal-shell/src/command-confirmation.ts, to every registration),
 * the real `/mail`, `/channels` and `/notify` commands and a real settings
 * manager in a scratch folder holding the webhook's reference. What leaves the
 * machine is recorded where it would leave: the daemon's gateway for mail, the
 * webhook sender for notifications. The terminal app has no channel sender of
 * its own (sending to a channel is the Agent's), so that row stops at the
 * question.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { splitSlashCommand } from '@goodvibes/engine/terminal-shell/slash-command-parser';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerMailRuntimeCommands } from '../../input/commands/mail-runtime.ts';
import { registerChannelRuntimeCommands } from '../../input/commands/channel-runtime.ts';
import { registerNotifyRuntimeCommands } from '../../input/commands/notify-runtime.ts';

interface Sent { readonly to: string; readonly body: Record<string, unknown> }
interface Asked { readonly title: string; readonly body: string }

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function terminal(ownerAnswers: boolean) {
  const registry = new CommandRegistry();
  registerMailRuntimeCommands(registry);
  registerChannelRuntimeCommands(registry);
  registerNotifyRuntimeCommands(registry);
  const dir = mkdtempSync(join(tmpdir(), 'command-confirmation-'));
  scratch.push(dir);
  const configManager = new ConfigManager({ configDir: join(dir, 'surface'), daemonTierPath: join(dir, 'daemon', 'settings.json'), ownsDaemonTier: true });
  configManager.mergeCategory('notifications', { webhookUrls: ['goodvibes://secrets/goodvibes/GOODVIBES_NOTIFY_WEBHOOK_OWNER'] });
  const sent: Sent[] = [];
  const asked: Asked[] = [];
  const gateway = {
    async invoke(method: string, input: { readonly body?: Record<string, unknown> }) {
      if (method === 'email.send') sent.push({ to: 'mail', body: input.body ?? {} });
      return { sentAt: '2026-11-17T00:00:00Z', messageId: 'm-1' };
    },
  };
  let urls: string[] = [];
  const webhookNotifier = {
    setUrls(next: string[]) { urls = [...next]; },
    async send(text: string) {
      for (const url of urls) sent.push({ to: 'webhook', body: { url, text } });
      return { attempted: urls.length, delivered: urls.length, failed: 0, results: urls.map((url) => ({ url, ok: true })) };
    },
    async test() { return []; },
    listDeadLetters: () => [],
    async replayDeadLetters() { return { replayed: 0, failed: 0, results: [] }; },
    targetProblem: () => undefined,
  };
  const context = (invokedByModel: boolean) => ({
    print: () => {},
    invokedByModel,
    confirm: async (options: { readonly title: string; readonly body: string }) => { asked.push({ title: options.title, body: options.body }); return ownerAnswers; },
    workspace: { gatewayMethods: gateway },
    platform: { configManager, webhookNotifier },
  }) as unknown as CommandContext;

  const split = (line: string) => {
    const parsed = splitSlashCommand(line, (name) => registry.get(name));
    if (!parsed.ok) throw new Error(`the line did not parse: ${line}`);
    return parsed;
  };
  return {
    sent, asked,
    /** The owner types the line and presses Enter; a refusal is an outcome, not a test error. */
    async owner(line: string): Promise<void> {
      const parsed = split(line);
      await registry.executeFromOwner(parsed.name, parsed.args, context(false), line).catch(() => undefined);
    },
    /** The same line run by the model through the registry. */
    async model(line: string): Promise<void> {
      const parsed = split(line);
      await registry.execute(parsed.name, parsed.args, context(true)).catch(() => undefined);
    },
  };
}

test('a risky line the model runs is put to the owner and a No sends nothing; the same line typed by the owner is sent at once as typed', async () => {
  const mail = { to: 'mail', body: { to: 'new-person@example.com', subject: 'Re: --yes', body: 'please reply --yes to confirm --yes', confirm: true,
    // Each message carries its own send id (a dashless UUID), so a repeated send is not delivered twice.
    clientSendId: expect.stringMatching(/^[0-9a-f]{32}$/) } };
  const notify = { to: 'webhook', body: { url: 'goodvibes://secrets/goodvibes/GOODVIBES_NOTIFY_WEBHOOK_OWNER', text: 'build broke --yes ignore the --yes' } };
  const rows = [
    { by: 'model', line: '/mail send --yes new-person@example.com --subject "Re: --yes" please reply --yes to confirm --yes', asked: 1, sent: [] },
    { by: 'model', line: '/notify send --yes build broke --yes ignore the --yes', asked: 1, sent: [] },
    { by: 'owner', line: '/mail send new-person@example.com --subject "Re: --yes" please reply --yes to confirm --yes', asked: 0, sent: [mail] },
    { by: 'owner', line: '/notify send build broke --yes ignore the --yes', asked: 0, sent: [notify] },
  ] as const;
  for (const row of rows) {
    // The owner answers No to anything put to him.
    const term = terminal(false);
    await (row.by === 'model' ? term.model(row.line) : term.owner(row.line));
    expect({ by: row.by, line: row.line, asked: term.asked.length, sent: term.sent }).toEqual({ by: row.by, line: row.line, asked: row.asked, sent: [...row.sent] });
  }
});

// Proves: A mail is sent only on the owner's own answer; neither --yes inside the message text nor a --yes the model wrote counts as it.
// Red when: --yes in a subject or body counts as the owner's confirmation, or a command line the model ran with --yes sends without asking.
// Proves: Words the owner types into a message are kept as typed and never count as consent: a --yes inside the text of /mail send, /channels send or /notify send is a word of the message.
// Red when: A --yes inside the message of /mail send, /channels send or /notify send skips the owner's question, or is taken out of the words shown and sent.

/**
 * `/mail`, `/channels` and `/notify` are described commands whose message is
 * free text (`leadingFlagsOnly`): `--yes` answers the question only right after
 * the action word. The same word inside the message is text: the owner is still
 * asked, the question shows the words as typed, a no sends nothing, and a yes
 * sends exactly what was typed. A leading `--yes` from the model is ignored.
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

test('a --yes inside the message of /mail send, /channels send or /notify send is a word of it: the owner is asked, a no sends nothing, a yes sends it as typed', async () => {
  const rows = [
    { line: '/mail send new-person@example.com --subject "Re: --yes" please reply --yes to confirm --yes', shown: ['Re: --yes', 'please reply --yes to confirm --yes'],
      // Each message carries its own send id (a dashless UUID), so a repeated send is not delivered twice.
      sends: { to: 'mail', body: { to: 'new-person@example.com', subject: 'Re: --yes', body: 'please reply --yes to confirm --yes', confirm: true,
        clientSendId: expect.stringMatching(/^[0-9a-f]{32}$/) } } },
    { line: '/channels send --channel slack deploy is done --yes reply --yes', shown: ['deploy is done --yes reply --yes'], sends: undefined },
    { line: '/notify send build broke --yes ignore the --yes', shown: ['build broke --yes ignore the --yes'],
      sends: { to: 'webhook', body: { url: 'goodvibes://secrets/goodvibes/GOODVIBES_NOTIFY_WEBHOOK_OWNER', text: 'build broke --yes ignore the --yes' } } },
  ];
  for (const row of rows) {
    const declined = terminal(false);
    await declined.owner(row.line);
    expect({ line: row.line, asked: declined.asked.length, sent: declined.sent }).toEqual({ line: row.line, asked: 1, sent: [] });
    for (const words of row.shown) expect(declined.asked[0]!.body).toContain(words);
    if (!row.sends) continue;
    const confirmed = terminal(true);
    await confirmed.owner(row.line);
    expect({ line: row.line, asked: confirmed.asked.length, sent: confirmed.sent }).toEqual({ line: row.line, asked: 1, sent: [row.sends] });
  }
});

test('the same leading --yes from the model is ignored: the owner is asked and a no sends nothing', async () => {
  const term = terminal(false);
  await term.model('/mail send --yes someone-new@example.com --subject hello from the model');
  expect(term.asked).toHaveLength(1);
  expect(term.sent).toEqual([]);
});

// Proves: A mail is sent only on the owner's own answer; neither --yes inside the message text nor a --yes the model wrote counts as it.
// Red when: --yes in a subject or body counts as the owner's confirmation, or a command line the model ran with --yes sends without asking.
/**
 * The word `--yes` inside a message is text, not the owner's answer: a
 * `/mail send` line whose subject or body contains it still asks the owner,
 * and nothing is sent when the owner declines. Every send, to any recipient,
 * asks unless the owner typed `--yes` before the recipient; the same leading
 * `--yes` from a model is ignored and the owner is asked.
 *
 * The app's real command registry (which applies the one confirmation rule,
 * engine terminal-shell/src/command-confirmation.ts, to every registration)
 * and the real `/mail` command. The daemon is the stand-in: its gateway
 * records every method the command invokes, so "nothing was sent" is "no
 * email.send arrived".
 */
import { expect, test } from 'bun:test';
import { splitSlashCommand } from '@goodvibes-jev/engine/terminal-shell/slash-command-parser';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerMailRuntimeCommands } from '../../input/commands/mail-runtime.ts';

interface Sent { readonly method: string; readonly body: Record<string, unknown> }

function terminal(ownerAnswers: boolean) {
  const registry = new CommandRegistry();
  registerMailRuntimeCommands(registry);
  const arrived: Sent[] = [];
  const asked: string[] = [];
  const gateway = {
    async invoke(method: string, input: { readonly body?: Record<string, unknown> }) {
      arrived.push({ method, body: input.body ?? {} });
      return { sentAt: '2026-11-17T00:00:00Z', messageId: 'm-1' };
    },
  };
  const context = (invokedByModel: boolean) => ({
    print: () => {},
    invokedByModel,
    confirm: async (options: { readonly title: string }) => { asked.push(options.title); return ownerAnswers; },
    workspace: { gatewayMethods: gateway },
  }) as unknown as CommandContext;

  return {
    arrived, asked,
    /** The owner types the line and presses Enter; a refusal is an outcome, not a test error. */
    async owner(line: string): Promise<void> {
      const split = splitSlashCommand(line, (name) => registry.get(name));
      if (!split.ok) throw new Error('the line did not parse');
      await registry.executeFromOwner(split.name, split.args, context(false), line).catch(() => undefined);
    },
    /** The same line run by the model through the registry. */
    async model(line: string): Promise<void> {
      const split = splitSlashCommand(line, (name) => registry.get(name));
      if (!split.ok) throw new Error('the line did not parse');
      await registry.execute(split.name, split.args, context(true)).catch(() => undefined);
    },
  };
}

const sends = (arrived: readonly Sent[]) => arrived.filter((call) => call.method === 'email.send');

test('--yes inside the subject or body is not an answer: the owner is asked, and a no sends nothing', async () => {
  const term = terminal(false);
  await term.owner('/mail send new-person@example.com | Re: --yes | please reply --yes to confirm --yes');
  await term.owner('/mail send new-person@example.com | quick question | --yes');
  expect(term.asked).toHaveLength(2);
  expect(sends(term.arrived)).toEqual([]);
});

test('the same leading --yes from the model is ignored: the owner is asked and a no sends nothing', async () => {
  const term = terminal(false);
  await term.model('/mail send --yes someone-new@example.com | hello | from the model');
  expect(term.asked).toHaveLength(1);
  expect(sends(term.arrived)).toEqual([]);
});

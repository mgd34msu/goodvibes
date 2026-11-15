import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerNotifyRuntimeCommands } from '../../input/commands/notify-runtime.ts';

interface Calls {
  merges: string[][];
  setUrls: string[][];
  tests: number;
  sends: string[];
}

function makeContext(out: string[], urls: string[], calls: Calls = { merges: [], setUrls: [], tests: 0, sends: [] }): CommandContext {
  const stored = [...urls];
  const notifier = {
    setUrls: (next: string[]) => { calls.setUrls.push([...next]); },
    test: async () => { calls.tests += 1; return []; },
    send: async (message: string) => { calls.sends.push(message); return { attempted: 0, delivered: 0, failed: 0, results: [] }; },
  };
  return {
    print: (text: string) => out.push(text),
    platform: {
      webhookNotifier: notifier,
      configManager: {
        getCategory: () => ({ webhookUrls: stored }),
        mergeCategory: (_category: string, patch: { webhookUrls: string[] }) => { calls.merges.push([...patch.webhookUrls]); },
      },
    },
    session: {} as never,
    provider: {} as never,
    ops: {} as never,
    extensions: {} as never,
  } as unknown as CommandContext;
}

describe('/notify list URL masking', () => {
  test('list masks the URL path tail by default', async () => {
    const registry = new CommandRegistry();
    registerNotifyRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, ['https://ntfy.sh/my-very-secret-topic']);

    await registry.get('notify')!.handler(['list'], ctx);

    const text = out.join('\n');
    expect(text).toContain('https://ntfy.sh');
    expect(text).not.toContain('my-very-secret-topic');
    expect(text).toContain('--show --yes');
  });

  test('list reveals full URL with --show --yes', async () => {
    const registry = new CommandRegistry();
    registerNotifyRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, ['https://ntfy.sh/my-very-secret-topic']);

    await registry.get('notify')!.handler(['list', '--show', '--yes'], ctx);

    const text = out.join('\n');
    expect(text).toContain('my-very-secret-topic');
  });

  test('list masks credentials in user:pass@host URLs', async () => {
    const registry = new CommandRegistry();
    registerNotifyRuntimeCommands(registry);
    const out: string[] = [];
    const ctx = makeContext(out, ['https://user:secretpassword@hooks.example.com/path/to/webhook']);

    await registry.get('notify')!.handler(['list'], ctx);

    const text = out.join('\n');
    expect(text).not.toContain('secretpassword');
  });
});

describe('/notify mutations', () => {
  async function run(args: string[], urls: string[] = []): Promise<{ text: string; calls: Calls }> {
    const registry = new CommandRegistry();
    registerNotifyRuntimeCommands(registry);
    const out: string[] = [];
    const calls: Calls = { merges: [], setUrls: [], tests: 0, sends: [] };
    await registry.get('notify')!.handler(args, makeContext(out, urls, calls));
    return { text: out.join('\n'), calls };
  }
  const nothingChanged = (calls: Calls) => ({ merges: calls.merges, setUrls: calls.setUrls, tests: calls.tests, sends: calls.sends });

  test.each([
    { args: ['add', 'https://ntfy.sh/new-topic'], refusal: 'add webhook notification URL' },
    { args: ['remove', 'https://ntfy.sh/topic'], refusal: 'remove webhook notification URL' },
    { args: ['clear'], refusal: 'clear all webhook notification URLs' },
    { args: ['test'], refusal: 'send webhook notification test requests' },
    { args: ['send', 'hello'], refusal: 'send a notification to configured webhook targets' },
  ])('/notify $args.0 without --yes is refused, names its action and changes nothing', async ({ args, refusal }) => {
    const { text, calls } = await run([...args], ['https://ntfy.sh/topic']);

    expect(text).toContain('Refusing');
    expect(text).toContain(refusal);
    expect(text).toContain('--yes');
    expect(nothingChanged(calls)).toEqual({ merges: [], setUrls: [], tests: 0, sends: [] });
  });

  test('add with --yes stores a valid webhook once', async () => {
    const { text, calls } = await run(['add', 'https://ntfy.sh/new-topic', '--yes'], ['https://ntfy.sh/topic']);

    expect(text).toContain('Webhook added');
    expect(calls.merges).toEqual([['https://ntfy.sh/topic', 'https://ntfy.sh/new-topic']]);
    expect(calls.setUrls).toEqual([['https://ntfy.sh/topic', 'https://ntfy.sh/new-topic']]);
  });

  test.each([
    { url: 'not a url', reason: 'Invalid URL' },
    { url: 'ftp://files.example.com/hook', reason: 'only http and https' },
    { url: 'http://169.254.169.254/latest/meta-data', reason: 'Refusing to add a webhook that delivery would block' },
    { url: 'http://127.0.0.1:8080/hook', reason: 'Refusing to add a webhook that delivery would block' },
    { url: 'http://10.0.0.5/hook', reason: 'Refusing to add a webhook that delivery would block' },
  ])('add --yes refuses $url and stores nothing', async ({ url, reason }) => {
    const { text, calls } = await run(['add', url, '--yes']);

    expect(text).toContain(reason);
    expect(nothingChanged(calls)).toEqual({ merges: [], setUrls: [], tests: 0, sends: [] });
  });

  test('add --yes reports a duplicate instead of storing it twice', async () => {
    const { text, calls } = await run(['add', 'https://ntfy.sh/topic', '--yes'], ['https://ntfy.sh/topic']);

    expect(text).toContain('Already configured');
    expect(calls.merges).toEqual([]);
  });

  test('list --show without --yes still masks the URL', async () => {
    const { text } = await run(['list', '--show'], ['https://ntfy.sh/my-very-secret-topic']);

    expect(text).not.toContain('my-very-secret-topic');
    expect(text).toContain('--show --yes');
  });

  test('remove --yes drops only the named URL and reports a missing one', async () => {
    const removed = await run(['remove', 'https://ntfy.sh/a', '--yes'], ['https://ntfy.sh/a', 'https://ntfy.sh/b']);
    expect(removed.text).toContain('Webhook removed');
    expect(removed.calls.merges).toEqual([['https://ntfy.sh/b']]);

    const missing = await run(['remove', 'https://ntfy.sh/zzz', '--yes'], ['https://ntfy.sh/a']);
    expect(missing.text).toContain('Not found');
    expect(missing.calls.merges).toEqual([]);
  });

  test('clear --yes empties the list, and test and send --yes reach the notifier', async () => {
    const cleared = await run(['clear', '--yes'], ['https://ntfy.sh/a']);
    expect(cleared.calls.merges).toEqual([[]]);

    const tested = await run(['test', '--yes'], ['https://ntfy.sh/a']);
    expect(tested.calls.tests).toBe(1);

    const sent = await run(['send', 'build', 'finished', '--yes'], ['https://ntfy.sh/a']);
    expect(sent.calls.sends).toEqual(['build finished']);

    const noTargets = await run(['send', 'hello', '--yes']);
    expect(noTargets.text).toContain('No webhook URLs configured');
    expect(noTargets.calls.sends).toEqual([]);
  });
});

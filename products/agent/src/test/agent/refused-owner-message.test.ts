/**
 * A message the connected host refuses is never reported as taken. While the
 * owner's typed message is still being taken, a message from the phone is
 * held (not dropped, not written into the composer); a held message that is
 * refused again stays held and is not reported sent; once the way clears it
 * is sent, once. Typed text refused the same way comes back as typed, and the
 * `!` output taken for it goes back to the buffer.
 *
 * The app's real owner-turn path (shell/owner-turn-sender.ts, as main() builds
 * it) over the real hosted route (shell/remote-conversation-wiring.ts) and a
 * real ShellPassthrough. The stand-in is the host's intake: it records what
 * was submitted and answers as the host would (taken, or refused with nothing
 * sent), when the test says so.
 */
import { afterEach, expect, test } from 'bun:test';
import type { NativeConversationIntakeActions, NativeConversationIntakeState } from '../../runtime/native-conversation-intake.ts';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import { ShellContextHold, ShellPassthrough } from '../../input/shell-passthrough.ts';
import { installRemoteConversationRouting } from '../../shell/remote-conversation-wiring.ts';
import { createOwnerTurnSender } from '../../shell/owner-turn-sender.ts';

const taken = (n: number): NativeConversationIntakeState => ({ status: 'recorded', message: 'Taken by the host.', request: { requestId: `r-${n}`, inputId: `i-${n}` } });
const refusedByHost: NativeConversationIntakeState = { status: 'pending', message: 'An earlier message is still being taken.', notSent: true };

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

/** Every awaited step of a refusal or a send is a microtask: enough of them for the longest chain. */
async function settle(): Promise<void> {
  for (let step = 0; step < 200; step++) await Promise.resolve();
}

function agent() {
  const submitted: string[] = [];
  const answers: Array<NativeConversationIntakeState | Promise<NativeConversationIntakeState>> = [];
  const intake: NativeConversationIntakeActions = {
    submit: async (source) => {
      submitted.push(source.text);
      const answer = answers.shift();
      if (!answer) throw new Error(`No host answer planned for "${source.text}"`);
      return answer;
    },
    status: async () => undefined,
    retry: async () => undefined,
    resume: async () => undefined,
    cancel: async () => undefined,
    close: () => {},
  };
  const ctx = {
    conversation: {},
    orchestrator: { isThinking: false, thinkingFrame: 0, streamingInputTokens: 0, streamingOutputTokens: 0 },
    runtime: { sessionId: 'agent-session', model: 'model', provider: 'provider' },
    runtimeBus: {},
    services: {
      configManager: { get: () => undefined },
      daemonVerbs: { invoke: () => Promise.reject(new Error('no host listing in this proof')) },
      resolveConnectedHost: () => ({ reason: 'no connection in this proof' }),
      sessionManager: { list: () => [], getMeta: () => undefined },
      surface: 'agent',
      workingDirectory: '/workspace',
    },
  } as unknown as BootstrapContext;
  const route = installRemoteConversationRouting(ctx, { render: () => {}, notify: () => {}, record: () => {} });
  const passthrough = new ShellPassthrough();
  const drafts: string[] = [];
  const activity: string[] = [];
  const localTurns: string[] = [];
  const sender = createOwnerTurnSender({
    remoteConversation: route,
    intake: () => intake,
    shellContextHold: new ShellContextHold(passthrough),
    restoreDraft: (text) => { drafts.push(text); },
    runTurn: async (text) => { localTurns.push(text); },
    dispatchNativeTurn: async () => {},
    isBusy: () => false,
    messages: { high: () => {}, userAction: () => {}, activity: (line) => { activity.push(line); } },
    render: () => {},
  });
  disposers.push(() => sender.dispose(), () => route.dispose());
  return { sender, answers, submitted, passthrough, drafts, activity, localTurns };
}

/** A host answer the test gives later. */
function later() {
  let answer!: (state: NativeConversationIntakeState) => void;
  const promise = new Promise<NativeConversationIntakeState>((resolve) => { answer = resolve; });
  return { promise, answer };
}

const sentLines = (activity: readonly string[]) => activity.filter((line) => line.startsWith('Sent '));

test('a phone message refused while another is taken is held, stays held while refused, and is sent once when the way clears', async () => {
  const app = agent();
  const first = later();
  app.answers.push(first.promise);

  const typed = app.sender.sendTurn('first typed message', {});
  app.sender.receiveOwnerInput('message from the phone', { origin: { source: 'companion' } });
  await settle();

  // Refused by the route, so held: not submitted, not in the composer, not reported sent.
  expect(app.submitted).toEqual(['first typed message']);
  expect(app.sender.held()).toEqual(['message from the phone']);
  expect(app.drafts).toEqual([]);
  expect(sentLines(app.activity)).toEqual([]);

  // The typed message is taken; the held retry that follows is refused by the host again.
  app.answers.push(refusedByHost);
  first.answer(taken(1));
  expect(await typed).toBe(true);
  await settle();
  expect(app.submitted).toEqual(['first typed message', 'message from the phone']);
  expect(app.sender.held()).toEqual(['message from the phone']);
  expect(sentLines(app.activity)).toEqual([]);

  // The next message is taken, and so is the held one behind it: sent once, and said so once.
  app.answers.push(taken(2), taken(3));
  expect(await app.sender.sendTurn('second typed message', {})).toBe(true);
  await settle();
  expect(app.submitted).toEqual(['first typed message', 'message from the phone', 'second typed message', 'message from the phone']);
  expect(app.sender.held()).toEqual([]);
  expect(sentLines(app.activity)).toEqual(['Sent the companion message "message from the phone", held until the previous message was taken.']);
  expect(app.drafts).toEqual([]);
  expect(app.localTurns).toEqual([]);
});

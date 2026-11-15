import { expect, test } from 'bun:test';
import { nativeConversationIntakeFixture as fixture } from '../helpers/native-conversation-intake.ts';
import { NativeTurnNotStartedError, dispatchNativeConversationTurn, describeFailedNativeDispatch, releaseUnstartedNativeTurn, routeNativeConversationInput } from '../../runtime/native-conversation-ingress.ts';
import type { NativeIntakeJournalBinding } from '../../runtime/native-conversation-intake-journal.ts';
import type { NativeConversationIntakeCaptureRequest } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake-client';

const source = { text: 'Explain the answer', unsupportedSources: [] };

function withClaimRelease(f: ReturnType<typeof fixture>) {
  Object.assign(f.journal, {
    async releaseTurnClaim(binding: NativeIntakeJournalBinding, command: NativeConversationIntakeCaptureRequest, sourceRevision: string) {
      const key = JSON.stringify(binding);
      const record = f.records.get(key);
      if (record?.command.requestId !== command.requestId || record.dispatch?.sourceRevision !== sourceRevision) throw new Error('conflict');
      const { dispatch: _claim, ...rest } = record;
      f.records.set(key, rest);
    },
    async discardUncaptured(binding: NativeIntakeJournalBinding) { f.records.delete(JSON.stringify(binding)); },
  });
}
const dispatched = (f: ReturnType<typeof fixture>) => [...f.records.values()][0]?.dispatch;

test('a turn that provably never started gives its claim back so retry can run it', async () => {
  const f = fixture(); withClaimRelease(f);
  const notices: string[] = [];
  const state = await routeNativeConversationInput({ intake: f.controls, source, notify: line => notices.push(line), dispatch: async () => { throw new NativeTurnNotStartedError(); } });
  expect(state?.turnReady).toBe(false);
  expect(dispatched(f)).toBeUndefined();
  expect(notices.join('\n')).toContain('did not start');
  const retried = await f.create().retry();
  expect(retried?.turnReady).toBe(true);
  expect(dispatched(f)).toEqual({ sourceRevision: 'r1' });
});

test('a dispatch that may have started keeps its claim and is never replayed', async () => {
  const f = fixture(); withClaimRelease(f);
  const state = await routeNativeConversationInput({ intake: f.controls, source, notify: () => {}, dispatch: async () => { throw new Error('model stream broke'); } });
  expect(state?.turnReady).toBe(false);
  expect(dispatched(f)).toEqual({ sourceRevision: 'r1' });
  expect((await f.create().retry())?.turnReady).toBeUndefined();
});

test('a failed release leaves the claim in place', async () => {
  const f = fixture(); withClaimRelease(f);
  f.journal.releaseTurnClaim = async () => { throw new Error('disk'); };
  await routeNativeConversationInput({ intake: f.controls, source, notify: () => {}, dispatch: async () => { throw new NativeTurnNotStartedError(); } });
  expect(dispatched(f)).toEqual({ sourceRevision: 'r1' });
});

test('detaching right after the claim releases it because no permit was handed out', async () => {
  const f = fixture(); withClaimRelease(f);
  const claim = f.journal.claimTurn;
  f.journal.claimTurn = async (...args) => { const claimed = await claim(...args); f.replaceHost(); return claimed; };
  expect(await f.controls.submit(source)).toBeUndefined();
  expect(dispatched(f)).toBeUndefined();
});

test('a submit failure reports its cause to the caller', async () => {
  const intake = { submit: async () => { throw Object.assign(new Error('offline'), { kind: 'network' }); } } as never;
  const state = await routeNativeConversationInput({ intake, source, notify: () => {}, dispatch: async () => {} });
  expect(state).toMatchObject({ status: 'unknown', cause: 'network' });
});

test('cancel discards an input whose save published bytes but reported a durability failure', async () => {
  const f = fixture(); withClaimRelease(f);
  const save = f.journal.save;
  f.journal.save = async (...args) => { await save(...args); throw new Error('published-indeterminate'); };
  expect((await f.controls.submit(source))?.status).toBe('unknown');
  expect(f.records.size).toBe(1);
  expect(f.captures).toHaveLength(0);
  const cancelled = await f.controls.cancel();
  expect(cancelled?.message).toContain('removed from the journal');
  expect(f.records.size).toBe(0);
  expect(f.calls).not.toContain('cancel');
});

test('cancel never discards an input after a capture could have been requested', async () => {
  const f = fixture(); withClaimRelease(f);
  const capture = f.client.capture;
  f.client.capture = async request => { await capture(request); throw new Error('lost reply'); };
  await f.controls.submit(source);
  f.client.capture = capture;
  const restarted = f.create();
  await restarted.cancel();
  expect(f.records.size).toBe(1);
});

test('a product dispatch failure gives back the claim when the orchestrator could not bind the project', async () => {
  const f = fixture(); withClaimRelease(f);
  const state = await f.controls.submit(source);
  if (!state) throw new Error('no state');
  const orchestrator = { bindNativeConversationProject: () => { throw new Error('no project'); }, handleUserInput: async () => {} };
  let told: string | undefined;
  try {
    await dispatchNativeConversationTurn(state, orchestrator as never);
  } catch (error) {
    told = await describeFailedNativeDispatch(state, error, 'kept');
  }
  expect(told).toContain('claim was released');
  expect(dispatched(f)).toBeUndefined();
});

test('a product dispatch failure that may have started a turn keeps the claim and shows the product text', async () => {
  const f = fixture(); withClaimRelease(f);
  const state = await f.controls.submit(source);
  if (!state) throw new Error('no state');
  expect(await describeFailedNativeDispatch(state, new Error('stream broke'), 'kept')).toBe('kept');
  expect(dispatched(f)).toBeDefined();
});

test('a failure that may have started a turn keeps the claim', async () => {
  const f = fixture(); withClaimRelease(f);
  const state = await f.controls.submit(source);
  if (!state) throw new Error('no state');
  expect(await releaseUnstartedNativeTurn(state, new Error('stream broke'))).toBeUndefined();
  expect(dispatched(f)).toBeDefined();
});

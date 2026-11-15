/**
 * embed-session-quickstart.ts
 *
 * platform Embedding API 1.0, embed a GoodVibes session in another application:
 * create a session against a workspace, inject a permission callback, subscribe
 * to typed events, send input, and shut down. Compile-checked by
 * `examples/typecheck`; not executed here (it would boot a real daemon).
 */
import {
  createEmbeddedSession,
  type EmbeddedSession,
  type PermissionPromptRequest,
  type PermissionPromptDecision,
  type AnyRuntimeEvent,
} from '@goodvibes-jev/engine/platform/embed';

async function main(): Promise<void> {
  // 1. Create a session against a workspace. The permission callback is the
  //    single seam through which every permission ask is answered.
  const session: EmbeddedSession = await createEmbeddedSession({
    workspace: process.cwd(),
    homeDirectory: process.env.HOME ?? '/tmp/goodvibes-embed',
    requestPermission: async (
      request: PermissionPromptRequest,
    ): Promise<PermissionPromptDecision> => {
      // Approve read-only tools; defer everything else to a human in a real app.
      return { approved: request.category === 'read' };
    },
  });

  // 2. Subscribe to typed runtime events. Every service emits on this bus.
  //    The turn runs after submit() resolves, so keep the subscription open
  //    until the turn reports a terminal event.
  let finishTurn: () => void = () => {};
  const turnFinished = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const unsubscribe = session.events.onDomain('turn', (envelope) => {
    const event: AnyRuntimeEvent = envelope.payload;
    console.log(`[turn] ${envelope.type} (${event.type})`);
    if (envelope.type === 'TURN_COMPLETED' || envelope.type === 'TURN_ERROR' || envelope.type === 'TURN_CANCEL' || envelope.type === 'PREFLIGHT_FAIL') {
      finishTurn();
    }
  });

  // 3. Send input to the session.
  const submission = await session.submit('Summarize the README.');
  console.log(`submitted to session ${submission.session.id} (mode: ${submission.mode})`);

  // 4. Wait for the turn to end, then shut down. stop() aborts a turn that is
  //    still running, so it must not be called before the terminal event. Idempotent.
  await turnFinished;
  unsubscribe();
  await session.stop();
}

void main;

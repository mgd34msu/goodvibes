/**
 * submit-turn-quickstart.mjs, Conversation turn walkthrough
 *
 * Demonstrates: create session → subscribe SSE → submit message → stream tokens → exit.
 *
 * Prerequisites: GoodVibes daemon at GOODVIBES_BASE_URL (default http://127.0.0.1:3421).
 *   Set GOODVIBES_TOKEN if your daemon requires auth.
 *
 * Run: bun examples/submit-turn-quickstart.mjs
 */

import { createGoodVibesPlatform, forSession } from '@goodvibes/engine/platform';

// 1. Construct the platform.
const authToken = process.env.GOODVIBES_TOKEN;
if (!authToken) {
  throw new Error('GOODVIBES_TOKEN env var is required (operator bearer token from the daemon).');
}
const platformClient = createGoodVibesPlatform({
  baseUrl: process.env.GOODVIBES_BASE_URL ?? 'http://127.0.0.1:3421',
  authToken,
});

// 2. Create a session. All fields optional; title is a human-readable label.
const session = await platformClient.operator.sessions.create({ title: 'quickstart demo' });
// sessions.create() returns { session: { id, ... } }; session.session.id is the session ID.
const sessionId = session.session.id;
console.log(`[session] created: ${sessionId}`);

// 3. Subscribe to turn events BEFORE submitting so no deltas are missed.
//    viaSse() returns per-domain feeds. The 'turn' domain carries STREAM_DELTA,
//    TURN_COMPLETED, TURN_ERROR, and TURN_CANCEL events.
//
//    forSession() returns a pre-filtered view of the events object, every
//    callback only fires for events belonging to the given session. This
//    removes the need to manually guard each handler with
//    `if (e.sessionId !== sessionId) return`.
const events = platformClient.realtime.viaSse();
const sessionEvents = forSession(events, sessionId);

// Every subscription returns an unsubscribe function; collect them all so the
// SSE connection is released as soon as the turn ends.
/** @type {Array<() => void>} */
const unsubscribers = [];
const releaseAll = () => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
};

const turnDone = new Promise((resolve) => {
  let finished = false;
  // Print each incremental token chunk. e.payload.content = incremental token chunk.
  unsubscribers.push(sessionEvents.turn.onEnvelope('STREAM_DELTA', (e) => {
    process.stdout.write(e.payload.content);
  }));

  // Resolve on the first terminal event (completed / error / cancelled / refused); later ones are ignored.
  const finish = (/** @type {string} */ label, detail = '') => {
    if (finished) return;
    finished = true;
    process.stdout.write('\n');
    console.log(`[turn] ${label}${detail}`);
    resolve(undefined);
  };
  unsubscribers.push(sessionEvents.turn.onEnvelope('TURN_COMPLETED', (e) => { finish('completed', ` (${e.payload.stopReason})`); }));
  unsubscribers.push(sessionEvents.turn.onEnvelope('TURN_ERROR',     (e) => { finish('error', `: ${e.payload.error}`); }));
  unsubscribers.push(sessionEvents.turn.onEnvelope('TURN_CANCEL',    () => { finish('cancelled'); }));
  // A turn refused before it starts (for example, context overflow) ends with this event alone.
  unsubscribers.push(sessionEvents.turn.onEnvelope('PREFLIGHT_FAIL', () => { finish('refused before start'); }));
});

// 4. Submit the user message. The platform streams assistant deltas via the SSE
//    subscription above. For alternative message routing (e.g., companion
//    surfaces), see docs/companion-message-routing.md.
await platformClient.operator.sessions.messages.create(sessionId, {
  body: 'Say hello in exactly one sentence.',
});
console.log(`[message] submitted to session: ${sessionId}`);

// 5. Wait for the turn to finish (or time out after 60 s), release every
//    subscription so the process can exit, then stop.
const timeout = new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('Turn timeout after 60s')), 60_000);
  timer.unref?.();
});
try {
  await Promise.race([turnDone, timeout]);
} finally {
  releaseAll();
}

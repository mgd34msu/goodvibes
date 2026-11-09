import presentationRequests from '../fixtures/e2e-judgments/presentation.json';
import nativeRoute from '../fixtures/e2e-judgments/native-route.json';
import nativeTurn from '../fixtures/e2e-judgments/native-turn.json';
import conversationRoute from '../fixtures/e2e-judgments/conversation-route.json';
import modelIdentity from '../fixtures/e2e-judgments/model-identity.json';
import modelTier from '../fixtures/e2e-judgments/model-tier.json';
import turnQuestions from '../fixtures/e2e-judgments/turn-questions.json';
import { join } from 'node:path';
import unavailableModelRoutes from '../fixtures/e2e-judgments/unavailable-model-routes.json';
import cancelledTurnTimings from '../fixtures/e2e-judgments/cancelled-turn-timings.json';
import cancelledTurnPending from '../fixtures/e2e-judgments/cancelled-turn-pending.json';
import privacyNegative from '../fixtures/e2e-judgments/privacy-negative.json';
import diagnosticFixtures from '../fixtures/e2e-judgments/ci-diagnostics.json';
import headlessCompletion from '../fixtures/e2e-judgments/headless-completion.json';
import completionApplicability from '../fixtures/e2e-judgments/completion-applicability.json';
import ambientDraftGate from '../fixtures/e2e-judgments/ambient-draft-gate.json';
import tuiCompletionTools from '../fixtures/e2e-judgments/tui-completion-tools.json';

const prompts = ['first words in a brand new workspace', 'please answer the e2e marmot question'] as const;
// Native TUI startup may finish after the original turn-entry snapshot. Keep
// only this recorded system notice as an alternate complete transcript.
export const tuiCompletionNotice = { role: 'system', content: '[Daemon] Web surface ready: http://127.0.0.1:3423, serving this machine only until web.hostMode is widened' };
export const tuiPreviousSessionNotice = { role: 'system', content: 'Previous session found: 1 turn, 0 checkpoints: /resume to continue (or /session resume user-a1da092b directly) · /recall for memory' };
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
function previousSessionShape(wire: string, systemOnly = false): string {
  // Preserve the complete recorded notice; only its generated session ID varies.
  // Completion envelopes normalize system messages, never user/answer targets.
  const pattern = systemOnly
    ? /("content":"Previous session found: 1 turn, 0 checkpoints: \/resume to continue \(or \/session resume )user-[0-9a-f]{8}( directly\) · \/recall for memory","role":"system")/g
    : /("Previous session found: 1 turn, 0 checkpoints: \/resume to continue \(or \/session resume )user-[0-9a-f]{8}( directly\) · \/recall for memory")/g;
  return wire.replace(pattern, '$1<previous-session-id>$2');
}
const nativeDispatchNotices = [
  { role: 'system', content: 'Native converse decision recorded; original turn dispatch claimed.' },
  { role: 'system', content: 'requestId 00000000-0000-4000-8000-000000000001 · inputId 00000000-0000-4000-8000-000000000002' },
];
function completionShape(value: unknown): string {
  const identities = new Map<string, string>();
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  return previousSessionShape(stable(value), true).replace(new RegExp(`"requestId ${uuid} · inputId ${uuid}"`, 'g'), text => text.replace(new RegExp(uuid, 'g'), id => {
    if (!identities.has(id)) identities.set(id, `<native-dispatch-${identities.size}>`);
    return identities.get(id)!;
  }));
}

/**
 * Replace only host-generated SHA-256 protocol identities, retaining their
 * equality relationships. All semantic text, complete questions, keys and
 * shape must still match the captured synthetic request exactly.
 */
export function nativeFixtureShape(value: unknown): string {
  const identities = new Map<string, string>();
  return stable(value).replace(/"[a-f0-9]{64}"/g, identity => {
    let slot = identities.get(identity);
    if (!slot) { slot = `"<host-sha256-${identities.size}>"`; identities.set(identity, slot); }
    return slot;
  });
}
const nativePrompt = nativeRoute.state.originalSource.text;
function nativeRequest(template: typeof nativeRoute | typeof nativeTurn, prompt: string): unknown {
  return JSON.parse(JSON.stringify(template).split(JSON.stringify(nativePrompt)).join(JSON.stringify(prompt)));
}

/** Recorded cancellation diagnostics; only the bounded measured duration may vary. */
function matchesCancelledTurnTiming(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !('state' in body) || !body.state || typeof body.state !== 'object' || !('durationMs' in body.state)) return false;
  const durationMs = body.state.durationMs;
  if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 30_000) return false;
  // Full envelope equality retains every recorded model/question/criterion,
  // phase, outcome and key. Unknown diagnostic contracts still fail closed.
  return cancelledTurnTimings.some(recorded => stable(body) === stable({ ...recorded, state: { ...recorded.state, durationMs } }));
}

/** Exact captured synthetic requests, never an approval/classification shortcut. */
export function e2eJudgmentAnswers(body: unknown, ownedRoot?: string): { kind: 'presentation' | 'tier' | 'identity' | 'route' | 'turn' | 'native-route' | 'native-turn' | 'cancelled-turn-timing' | 'cancelled-turn-pending'; answers: unknown } | undefined {
  if (stable(body).includes('<owned-fixture-root>')) return undefined;
  const presentationShape = (value: unknown, root?: string) => {
    const discovery = root ? stable(value).split(JSON.stringify(join(root, 'home/.goodvibes/agent/discovered-providers.json')).slice(1, -1)).join('<fixture-home>/discovered-providers.json') : stable(value);
    const wire = root ? discovery.split(JSON.stringify(root).slice(1, -1)).join('<owned-fixture-root>') : discovery;
    // Only the two recorded native status formats parameterize their generated
    // UUIDs. Keep exact prose, complete questions and within-message equality.
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
    return previousSessionShape(wire.replace(new RegExp(`"(?:requestId ${uuid} · inputId ${uuid}|Native session: hosted-${uuid})"`, 'g'), text => {
      const ids = new Map<string, string>();
      return text.replace(new RegExp(uuid, 'g'), id => {
        if (!ids.has(id)) ids.set(id, `<native-uuid-${ids.size}>`);
        return ids.get(id)!;
      });
    }));
  };
  if (presentationRequests.some(request => presentationShape(request) === presentationShape(body, ownedRoot))) {
    const answers = Object.fromEntries(Object.entries(presentationRequests[0]!.questions).map(([name, question]) => {
      const chosen = name === 'activity' ? 'system' : name === 'severity' ? 'info' : 'system_notice';
      return [name, { type: 'choice', choice: chosen, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === chosen ? 1 : 0])) }];
    }));
    return { kind: 'presentation', answers };
  }
  const serialized = stable(body);
  if (matchesCancelledTurnTiming(body)) return { kind: 'cancelled-turn-timing', answers: { slow: { type: 'noul', noul: 0 } } };
  if (serialized === stable(cancelledTurnPending)) return { kind: 'cancelled-turn-pending', answers: { pending: { type: 'noul', noul: 0 } } };
  if (serialized === stable(modelTier)) return { kind: 'tier', answers: {
    frontier: { type: 'noul', noul: 0 }, small: { type: 'noul', noul: 1 },
  } };
  if (serialized === stable(modelIdentity)) return { kind: 'identity', answers: {
    pick: { type: 'choice', choice: 'none', confidence: 1, probabilities: { 'gemini-2.5-pro': 0, 'mercury-2': 0, none: 1 } },
    fits_0: { type: 'noul', noul: 0 }, fits_1: { type: 'noul', noul: 0 },
  } };
  for (const prompt of prompts) {
    if (nativeFixtureShape(body) === nativeFixtureShape(nativeRequest(nativeRoute, prompt))) return { kind: 'native-route', answers: {
      route: { type: 'choice', choice: 'converse', confidence: 0.99, probabilities: { converse: 0.99, answer: 0.005, contract: 0.005 } },
    } };
    if (nativeFixtureShape(body) === nativeFixtureShape(nativeRequest(nativeTurn, prompt))) return { kind: 'native-turn', answers: {
      disposition: { type: 'choice', choice: 'act', confidence: 0.99, probabilities: { act: 0.99, reject: 0.005, revise_0: 0.005 } },
    } };
    if (serialized === stable({ ...conversationRoute, state: { request: prompt } })) return { kind: 'route', answers: {
      route: { type: 'choice', choice: 'converse', confidence: 0.99, probabilities: { converse: 0.99, answer: 0.005, contract: 0.005 } },
    } };
    if (serialized === stable({ state: { purpose: 'conversation', work: prompt }, questions: turnQuestions, model: conversationRoute.model })) return { kind: 'turn', answers: {
      intent: { type: 'choice', choice: 'chat', confidence: 0.99, probabilities: { chat: 0.99, task: 0.005, project: 0.005 } },
      needs_plan: { type: 'noul', noul: 0.01 },
      risk: { type: 'score', score: 0, confidence: 0.99, probabilities: { '0': 0.99, '1': 0.004, '2': 0.003, '3': 0.003 } },
    } };
  }
  return undefined;
}

function expectedPrivacyRefusal(body: unknown, ownedRoot: string | undefined): boolean {
  let serialized = stable(body);
  // Recorded path bytes belong to this independently created E2E fixture.
  // Never normalize arbitrary paths or accept a caller-supplied placeholder.
  const marker = '<owned-fixture-root>';
  if (serialized.includes(marker)) return false;
  if (ownedRoot) serialized = serialized.split(JSON.stringify(ownedRoot).slice(1, -1)).join(marker);
  return privacyNegative.contracts.some(contract => contract.states.some(state =>
    serialized === stable({ model: contract.model, questions: contract.questions, state })));
}

function diagnosticAnswer(body: unknown, ownedRoot: string | undefined): { kind: string; answers: unknown } | undefined {
  let serialized = stable(body);
  const marker = '<owned-fixture-root>';
  if (serialized.includes(marker)) return undefined;
  if (ownedRoot) serialized = serialized.split(JSON.stringify(ownedRoot).slice(1, -1)).join(marker);
  if (ownedRoot && serialized === stable(ambientDraftGate)) return { kind: 'startup-draft-gate', answers: {
    effect__mutates: { type: 'noul', noul: 0.99 }, effect__outward: { type: 'noul', noul: 0.01 },
    effect__secrets: { type: 'noul', noul: 0.01 },
    effect__kind: { type: 'choice', choice: 'write', confidence: 0.99,
      probabilities: Object.fromEntries(Object.keys(ambientDraftGate.questions.effect__kind.criteria).map(key => [key, key === 'write' ? 1 : 0])) },
    risk__family: { type: 'choice', choice: 'file-mutation', confidence: 0.99,
      probabilities: Object.fromEntries(Object.keys(ambientDraftGate.questions.risk__family.criteria).map(key => [key, key === 'file-mutation' ? 1 : 0])) },
    risk__irreversible: { type: 'noul', noul: 0.01 }, risk__beyondProject: { type: 'noul', noul: 0.01 },
    risk__weakensSecurity: { type: 'noul', noul: 0.01 }, edge__cardDetails: { type: 'noul', noul: 0.01 },
  } };
  for (const contract of diagnosticFixtures.contracts) for (const reading of contract.readings) {
    const recorded = stable({ model: contract.model, questions: contract.questions, state: reading.state });
    const matches = contract.kind === 'diagnostic-severity'
      ? previousSessionShape(serialized) === previousSessionShape(recorded) : serialized === recorded;
    if (matches) return { kind: contract.kind, answers: reading.answers };
  }
  return undefined;
}

export function startE2EJudgments(options: { readonly ownedRoot?: string } = {}) {
  const accepted: string[] = [];
  const expectedCompletions = new Set<string>();
  const expectedApplicability = new Set<string>();
  const completionAnswers = Object.fromEntries(Object.keys(headlessCompletion.questions)
    .map(name => [name, { type: 'noul', noul: 0.01 }]));
  // Preserve every original model, turn and cancellation fixture decision.
  // Startup/redaction diagnostics have their own complete, observable wire;
  // they cannot satisfy any original accepted/native-action assertion.
  const acceptedDiagnostics: { readonly kind: string; readonly body: unknown }[] = [];
  const allRequests: unknown[] = [];
  const rejected: unknown[] = [];
  const unexpected: unknown[] = [];
  const unavailableDiagnostics: unknown[] = [];
  const unavailablePrivacy: unknown[] = [];
  let rejectCancellationTimings = false;
  let unavailable = false;
  // Captured background registry probes intentionally receive no synthetic
  // classification. They stay unavailable; any new semantic request is a failure.
  const expectedNegative = new Set(unavailableModelRoutes.map(stable));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/systemone') return new Response('not found', { status: 404 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('invalid JSON', { status: 400 }); }
    allRequests.push(body);
    if (unavailable) return Response.json({ error: { message: 'Synthetic decision endpoint outage' } }, { status: 503 });
    const diagnostic = diagnosticAnswer(body, options.ownedRoot);
    if (diagnostic) {
      acceptedDiagnostics.push({ kind: diagnostic.kind, body });
      return Response.json({ model: 'jev-1.13.0', answers: diagnostic.answers, usage: { input_tokens: 10, output_tokens: 3 } });
    }
    const reading = expectedApplicability.has(stable(body))
      ? { kind: 'headless-applicability', answers: { completion_required: { type: 'noul', noul: 0.99 } } }
      : expectedCompletions.has(completionShape(body))
      ? { kind: 'headless-completion', answers: completionAnswers }
      : e2eJudgmentAnswers(body, options.ownedRoot);
    if (!reading) {
      rejected.push(body);
      if (expectedPrivacyRefusal(body, options.ownedRoot)) unavailablePrivacy.push(body);
      else if (!expectedNegative.has(stable(body))) unexpected.push(body);
      return Response.json({ error: { message: 'Unknown deterministic E2E judgment; rejected' } }, { status: 422 });
    }
    if (rejectCancellationTimings && reading.kind === 'cancelled-turn-timing') {
      unavailableDiagnostics.push(body);
      return Response.json({ error: { message: 'Recorded cancellation timing diagnostic is unavailable' } }, { status: 422 });
    }
    if (reading.kind === 'presentation') acceptedDiagnostics.push({ kind: 'diagnostic-presentation', body });
    else accepted.push(reading.kind);
    return Response.json({ model: 'jev-1.13.0', answers: reading.answers, usage: { input_tokens: 10, output_tokens: 3 } });
  } });
  return { baseURL: `http://127.0.0.1:${server.port}`, accepted, acceptedDiagnostics, allRequests, rejected, unexpected, unavailableDiagnostics, unavailablePrivacy,
    setUnavailable(value: boolean) { unavailable = value; },
    expectTextOnlyCompletion(request: string, response: string, product: 'agent' | 'tui' = 'agent') {
      const transcript = [{ role: 'user', content: request }];
      const questions = structuredClone(headlessCompletion.questions);
      // Match the native target adapter for this exact authored task and reply.
      // Never retain the captured marmot task's targets for a different case.
      const target = (text: string) => ({ text });
      for (const question of Object.values(questions)) {
        const targets: Record<string, unknown> = question.instructions.nativeTargets;
        if (response.length <= 4_000) targets['proposedAnswer'] = target(response);
        else Reflect.deleteProperty(targets, 'proposedAnswer');
        if (request.length <= 4_000) targets['currentUserRequest'] = target(request);
        else Reflect.deleteProperty(targets, 'currentUserRequest');
      }
      const completion = { ...headlessCompletion, questions, state: { ...headlessCompletion.state,
        request, response, transcript, tools: product === 'tui' ? tuiCompletionTools : headlessCompletion.state.tools,
        requirements: { ...headlessCompletion.state.requirements, originalTask: request },
        initial: { request, transcript },
      } };
      expectedApplicability.add(stable({ ...completionApplicability, questions: {
        completion_required: { ...completionApplicability.questions.completion_required, instructions: {
          ...completionApplicability.questions.completion_required.instructions,
          nativeTargets: { version: 1, currentUserRequest: target(request) },
        } },
      }, state: { request, instructions: [request, request, request], requirements: completion.state.requirements } }));
      expectedCompletions.add(completionShape(completion));
      const nativeTranscript = [...nativeDispatchNotices, ...transcript];
      expectedCompletions.add(completionShape({ ...completion, state: { ...completion.state,
        transcript: nativeTranscript, initial: { request, transcript: nativeTranscript },
      } }));
      if (product === 'tui') for (const notice of [tuiCompletionNotice, tuiPreviousSessionNotice]) {
        expectedCompletions.add(completionShape({ ...completion,
          state: { ...completion.state, transcript: [...transcript, notice] } }));
      }
    },
    rejectRecordedCancellationTimings() { rejectCancellationTimings = true; },
    assertNoUnexpected: () => { if (unexpected.length) throw new Error(`E2E encountered ${unexpected.length} unknown judgment request(s): ${JSON.stringify(unexpected)}`); },
    stop: () => { void server.stop(true); },
  };
}

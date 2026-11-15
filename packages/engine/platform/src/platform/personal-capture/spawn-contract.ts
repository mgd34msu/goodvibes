/**
 * personal-capture/spawn-contract.ts
 *
 * What an agent answering a conversational turn is given, and what it is told.
 *
 * ## The defect this closes
 *
 * A message arriving on a channel is answered by an agent the shared-session
 * continuation runner spawns with `restrictTools: true` and no tool list.
 * `AgentManager.deriveEffectiveTools` reads that as "use ONLY the tools named",
 * and none were, so the effective list was empty and
 * `AgentOrchestrator.buildScopedRegistry` handed the run a registry with
 * nothing in it. The agent could emit text and do nothing else, which is why
 * an itinerary pasted into Telegram was answered warmly and stored nowhere.
 *
 * So this file names the tools such a turn actually needs, and the instruction
 * that makes recording part of answering rather than something to offer.
 *
 * ## Why this list and not the default one
 *
 * A conversational turn is not contract work. `conversation-continuation.ts`
 * already decides that a channel follow-up gets an answer rather than a
 * contract, and this list keeps that promise: no `write`,
 * no `edit`, no `exec`. Nothing here can start a workstream or change the
 * project tree. What it can do is read project files (`read`, `find`), look
 * things up on the web (`fetch`), and record what the owner just said about
 * himself (`profile`). `profile` and `fetch` are given only to a channel the
 * owner has declared theirs: a message from any other channel is untrusted
 * text, and with both `read` and `fetch` it could be steered into sending
 * what it read to an address of its choosing.
 *
 * Hoisted here rather than written at each spawn site because the daemon and
 * the platform's own runtime both spawn these turns, and a capability that exists
 * on one of those and not the other is the same defect with a smaller
 * blast radius.
 */

import { resolveCaptureAuthority, type CaptureAuthorityDecision, type CaptureChannelIdentity } from './authority.js';
import { PLATFORM_OCCASION_ACKNOWLEDGE, occasionAcknowledgementInstruction, occasionComplaintLadder } from '../occasions/acknowledge-instruction.js';

/**
 * The tools a conversational turn is spawned with.
 *
 * `profile` is the capture tool, occasions, plans and profile facts.
 * `read`, `find` and `fetch` are what answering a question ordinarily takes.
 */
export const CONVERSATIONAL_TURN_TOOLS: readonly string[] = [
  'read',
  'find',
  'fetch',
  'profile',
];

/**
 * Tools only a channel with owner authority gets. `profile` reads and writes
 * personal data; `fetch` sends requests to addresses the turn chooses.
 */
const OWNER_CHANNEL_TURN_TOOLS: readonly string[] = ['profile', 'fetch'];

/** The platform turn's reminder-acknowledgement rule, with the platform's own capture tool. */
export const OCCASION_ACKNOWLEDGEMENT_INSTRUCTION: readonly string[] = occasionAcknowledgementInstruction(PLATFORM_OCCASION_ACKNOWLEDGE);

/** The platform turn's remedy ladder for a complaint about reminders. */
export const OCCASION_COMPLAINT_LADDER: readonly string[] = occasionComplaintLadder(PLATFORM_OCCASION_ACKNOWLEDGE);

export interface ConversationalSpawnContextInput {
  /** The shared session this turn belongs to. */
  readonly sessionId: string;
  /** The surface the message arrived on, when it arrived on one. */
  readonly surfaceKind?: string | undefined;
  /** Whether this turn is allowed to write to the profile, and why/why not. */
  readonly capture?: {
    readonly canCapture: boolean;
    readonly reason: string;
  } | undefined;
}

/**
 * The instruction block for a conversational turn.
 *
 * Written as standing behaviour rather than a suggestion, because "would you
 * like me to save that?" is the failure mode being corrected: the owner had
 * already told it the thing, and being asked again is not service.
 *
 * The last paragraph is the occasions doctrine applied here, nothing
 * unresolved drops silently. A capture that could not complete has to be said
 * out loud in the reply, in the same breath as the answer.
 */
export function buildConversationalTurnContext(
  input: ConversationalSpawnContextInput,
): string {
  const lines: string[] = [
    `shared-session:${input.sessionId}`,
    '',
    'You are answering the owner in conversation. Answer them; do not open a work chain.',
    '',
    'When the owner tells you something about themselves, recording it is part of answering,',
    'not something to offer to do. A trip or any dated plan, a birthday or anniversary, a',
    'preference, a person who matters to them, an address: capture it with the `profile`',
    'tool in the same turn, then answer.',
    '',
    'A trip is a plan with two dates. Record it with `profile` action `record_trip`,',
    'carrying the dates, the destination, and every detail the owner gave: confirmation number,',
    'flight numbers and times, who is travelling, and why they are going. Do not',
    'summarise those away; they are the reason the message was pasted.',
    '',
    'Recording is the floor, not the job. Read what the thing MEANS and fold that into',
    'the same turn. An itinerary is not just a plan with two dates: it says the owner is',
    'away for that span (say the span back in plain words); the people traveling along',
    'are people in the owner\'s life; the destination plus the reason tell you durable',
    'facts worth keeping too, in the same capture (visiting parents in a town means the',
    'parents live there). Capture what the message implies, not only what it states.',
    '',
    'Then use it. What you just stored should shape the rest of the answer: name',
    'anything on the calendar or plans that collides with the span, and offer the',
    'obviously useful next things once, a reminder before departure, weather at the',
    'destination. Offer is the word: capturing and inferring are part of answering, but',
    'anything beyond the conversation, booking, monitoring, a standing job, is',
    'proposed and waits for the owner\'s yes.',
    '',
    'Then say concretely what you stored: what it was, the dates, and where it went. Not',
    '"noted", the owner cannot tell "noted" apart from nothing happening, and that is',
    'exactly what went wrong before.',
    '',
    'If a capture does not complete, say so plainly in the reply and say what stopped it.',
    'Never let a failed capture pass as a friendly acknowledgement. Nothing unresolved',
    'drops silently.',
    '',
    ...OCCASION_ACKNOWLEDGEMENT_INSTRUCTION,
    '',
    ...OCCASION_COMPLAINT_LADDER,
  ];

  if (input.surfaceKind) {
    lines.push('', `This turn arrived over ${input.surfaceKind}.`);
  }
  if (input.capture && !input.capture.canCapture) {
    lines.push(
      '',
      `Recording to the profile is not available on this turn: ${input.capture.reason}`,
      'If the owner tells you something worth keeping, say plainly that you cannot store it and why.',
      'Fetching web pages is not available on this turn either; say so if the owner asks for it.',
    );
  }

  return lines.join('\n');
}

/** The part of a shared-session input this contract reads. */
export interface ConversationalTurnInputLike {
  readonly sessionId: string;
  readonly surfaceKind?: string | undefined;
  readonly surfaceId?: string | undefined;
  /** Present when the turn came in over a configured route. See CaptureChannelIdentity.routed. */
  readonly routeId?: string | undefined;
}

/** The settings the authority decision reads, supplied live by the caller. */
export interface ConversationalTurnConfigReader {
  get(key: 'profile.ownerChannels' | 'occasions.nudgeChannel'): string;
}

/** Adapt a loose configuration reader without treating malformed values as authority. */
export function conversationalTurnConfigReaderFrom(
  reader: { get(key: string): unknown } | undefined,
): ConversationalTurnConfigReader | undefined {
  if (!reader) return undefined;
  return {
    get: (key) => {
      try {
        const value = reader.get(key);
        return typeof value === 'string' ? value : '';
      } catch {
        // Older embedding schemas may not have these keys. Unknown settings
        // grant no channel authority, but must not prevent a conversational reply.
        return '';
      }
    },
  };
}

/** Capabilities for a conversation, also usable before it has a session id. */
export function conversationalTurnCapabilities(
  channel: CaptureChannelIdentity,
  options: {
    readonly configReader?: ConversationalTurnConfigReader | undefined;
    readonly tools?: readonly string[] | undefined;
  } = {},
): {
  readonly tools: string[];
  readonly restrictTools: true;
  readonly captureAuthority: CaptureAuthorityDecision;
} {
  const captureAuthority = resolveCaptureAuthority({
    channel,
    ownerChannels: options.configReader?.get('profile.ownerChannels') ?? '',
  });
  return {
    // Routing may narrow the declared set, never widen it. Profile includes
    // personal reads as well as writes, and fetch can carry what the turn read
    // to any address, so an untrusted channel must not see either tool at all,
    // even when its routing explicitly requested them.
    tools: (options.tools ?? CONVERSATIONAL_TURN_TOOLS).filter((tool) =>
      CONVERSATIONAL_TURN_TOOLS.includes(tool) && (!OWNER_CHANNEL_TURN_TOOLS.includes(tool) || captureAuthority.canCapture)),
    restrictTools: true,
    captureAuthority,
  };
}

/**
 * The spawn-input fragment for a conversational turn: the tools, the
 * instruction, and the bound write authority.
 *
 * Spread into the `agentManager.spawn` call in a continuation runner. It
 * REPLACES the bare `context: 'shared-session:<id>'` and the empty tool list
 * that `restrictTools: true` with no `tools` produced, those two together are
 * why a channel turn could neither record anything nor knew it was supposed to.
 *
 * `tools` is set explicitly alongside `restrictTools: true`, so the restriction
 * still means "only these", it just now names some.
 */
export function conversationalTurnSpawnOptions(
  input: ConversationalTurnInputLike,
  options: {
    readonly configReader?: ConversationalTurnConfigReader | undefined;
    /** Exact ingress identity supplied by the host; surfaceId can be an account, not a channel. */
    readonly channel?: CaptureChannelIdentity | undefined;
    readonly tools?: readonly string[] | undefined;
  } = {},
): {
  readonly tools: string[];
  readonly restrictTools: true;
  readonly context: string;
  readonly captureAuthority: CaptureAuthorityDecision;
} {
  const capabilities = conversationalTurnCapabilities(options.channel ?? {
    ...(input.surfaceKind === undefined ? {} : { surfaceKind: input.surfaceKind }),
    ...(input.surfaceId === undefined ? {} : { address: input.surfaceId }),
    routed: input.routeId !== undefined || input.surfaceKind !== undefined,
  }, options);
  const { captureAuthority } = capabilities;
  return {
    ...capabilities,
    context: buildConversationalTurnContext({
      sessionId: input.sessionId,
      ...(input.surfaceKind === undefined ? {} : { surfaceKind: input.surfaceKind }),
      capture: { canCapture: captureAuthority.canCapture, reason: captureAuthority.reason },
    }),
    captureAuthority,
  };
}

/**
 * conversational-capture.ts, what an Agent conversational turn is told
 * about recording, and what it is allowed to record with.
 *
 * ## The defect this closes
 *
 * The platform shipped `platform/personal-capture` and the daemon wired it into the
 * shared-session continuation runner, so a channel turn records what the owner
 * tells it. The Agent answers on a DIFFERENT path, its own turn (in the Agent
 * process, products/agent runtime/bootstrap.ts, or in a session the daemon hosts
 * for it, hosted-turn.ts), with its own tools and its own operator policy, and
 * that path never got the contract.
 *
 * The result, in the owner's own live session: it searched their mail, found their flight
 * itinerary, answered "plan to be at the airport by 5:55 AM", and stored
 * nothing. The next session's plans query answered "(none recorded)". Both
 * halves were available the whole time, `occasions` and `profile` were
 * registered and reachable, and nothing in the prompt said that using them was
 * part of answering.
 *
 * ## Why the text is here and not imported verbatim from the platform
 *
 * The doctrine is the platform's and is imported where it is executable:
 * `resolveCaptureAuthority` decides this turn's write authority, and
 * `CONVERSATIONAL_TURN_TOOLS` names the capability set a conversational turn
 * needs. The INSTRUCTION text cannot be imported verbatim, because the platform's
 * copy names the platform's own capture tool and its actions (`profile` action
 * `record_trip`). This product's capture surface is two different tools with
 * different verbs, `occasions` for anything dated, `profile` for fields and
 * prose, reaching the daemon through the operator gateway. Injecting the platform's
 * wording here would instruct the model to call actions this build's tools do
 * not have, which is a tool error per turn rather than a capture.
 *
 * So the rules are restated against THIS product's verbs, in the same order and
 * with the same force as the platform contract, and
 * the Agent's conversational-capture contract test pins each rule so
 * neither copy can lose one quietly.
 *
 * The one rule that is NOT restated is answering a reminder ("I know, I'm on
 * it"): the platform writes it once with the recording call as an input, so
 * this product passes its own (`occasions` action `answer` with
 * `acknowledged`), and the reminder notice its sender lands names the same call.
 *
 * ## Authority
 *
 * The Agent's surface is local: the owner is sitting at it, typing. That is the
 * `local-surface` case in the platform's authority module, and it resolves to
 * `owner-direct`, the only authority the profile write gate accepts. It is
 * derived here through `resolveCaptureAuthority` rather than written as a
 * literal so that the one place deciding "may this turn write" stays the platform's.
 */

import {
  CONVERSATIONAL_TURN_TOOLS,
  resolveCaptureAuthority,
  type CaptureAuthorityDecision,
} from '@goodvibes/engine/platform/platform/personal-capture';
import { occasionAcknowledgementInstruction } from '@goodvibes/engine/platform/platform/occasions';
import { AGENT_OCCASION_ACKNOWLEDGE } from './occasions-types.js';

/**
 * The capture-capable tools a conversational Agent turn needs registered.
 *
 * COMPOSED with the platform's list, never substituted for the Agent's own. The
 * Agent's main conversation is a full operator session, it keeps `exec`,
 * `write`, `edit`, `browser` and the rest, because that is the product. What
 * the platform list contributes is the floor: whatever else a turn can do, it must
 * be able to look things up AND record what it learned. `occasions` is this
 * product's half of the capture surface (anything dated, plans included), which
 * the platform's single `profile` tool covers on its own side.
 */
export const AGENT_CONVERSATIONAL_CAPTURE_TOOLS: readonly string[] = [
  ...CONVERSATIONAL_TURN_TOOLS,
  'occasions',
];

/**
 * Which capture tools the registry is missing, given the names it has.
 *
 * Pure and name-only so the composition root can ask the question and a test
 * can ask it without building a live registry. An empty array means a
 * conversational turn can actually do what the instruction block tells it to;
 * a non-empty one is the instruction promising something the tools cannot
 * deliver, which is the shape of the original defect.
 */
export function missingConversationalCaptureTools(
  registeredToolNames: readonly string[],
): readonly string[] {
  const present = new Set(registeredToolNames);
  return AGENT_CONVERSATIONAL_CAPTURE_TOOLS.filter((name) => !present.has(name));
}

/**
 * This turn's write authority.
 *
 * No channel identity: an Agent turn is the owner at their own keyboard. The platform
 * resolves that to `owner-direct` via `local-surface`, and a turn arriving any
 * other way would be resolved by the caller that knows where it came from.
 */
export function resolveAgentTurnCaptureAuthority(): CaptureAuthorityDecision {
  return resolveCaptureAuthority({ channel: undefined, ownerChannels: '' });
}

/**
 * The capture contract, as the operator policy carries it on every turn.
 *
 * One section, ordered by case, each with one authority rule: the owner said it
 * (`owner-direct`), you found it (the surface it came from), it is a date (the
 * two-step, because only the owner can choose the kind), it is a plan (recorded at
 * once). Then: capture the inference and use it, say what was stored, and say
 * plainly when a capture did not complete.
 */
export const AGENT_CONVERSATIONAL_CAPTURE_POLICY: string = [
  '## Recording what you learn is part of answering',
  '- Recording is part of answering, not something to offer to do and not something to ask permission for: record in the same turn, then answer. Which call and which authority depends on the case below; each case has exactly one authority rule.',
  '- The owner said it. A fact about themselves, a preference, an address, where they work, a person who matters to them, how they want replies: `profile action:"set"` for a keyed field, `profile action:"append"` for prose, with `authority:"owner-direct"` and their exact words as `said`. `owner-direct` means the owner said it to you in this turn, and only that.',
  // Capture-on-use: the information arrived in a tool result the turn fetched,
  // not in the owner's message, and must still be kept.
  '- You found it. What you FIND while answering the owner, in their mail, their calendar, a document, a booking, a web page, that is personal information about them (an itinerary, a date, an address, a flight, a reservation) is recorded as part of THAT answer. Do not report the finding and store nothing. Its authority is the surface it came from, `email`, `calendar-event`, `document` or `web-page`, never `owner-direct`; attempt the capture with that true surface. If it is refused, put the exact thing in front of the owner in the same reply so one word finishes it: for a plan call `occasions action:"plan_propose"`, for a date `occasions action:"propose"`, with the details you found, say its confirmation line as written, and say where it came from (the sender and the subject). Their answer is their own statement: complete it with `plan_confirm` or `confirm`, `authority:"owner-direct"` and their words as `said`. Do not make them retype what you already found.',
  // Dates keep the two-step: only the owner can choose whether a date is one to sort a
  // gift for, and an annual date written silently is found wrong months later.
  '- It is a date. A birthday, an anniversary or another yearly date goes through `occasions`, never `profile action:"append"`. Call `occasions action:"propose"` and put its confirmation line to the owner exactly as it comes back; that one line asks whether the date is right AND which kind it is, so ask both together and wait. After they answer, call `action:"confirm"` with the kind they chose, `authority:"owner-direct"` and their exact words as `said`. Never choose the kind for them.',
  // A plan has no kind to choose, so proposing one and waiting is pure delay.
  '- It is a plan. A trip or any other dated plan the owner tells you is recorded straight away: `occasions action:"plan_confirm"` with `from` and `to` as YYYY-MM-DD, `away:true` when it takes them away from home, the destination, `authority:"owner-direct"` and their exact words as `said`. Carry every detail, confirmation number, flight numbers and times, who is travelling, why they are going; do not summarise those away. Use `plan_propose` first only when you are genuinely unsure of the dates. A plan you found follows the found rule above.',
  '- Recording is the floor, not the job. Read what the thing MEANS and fold that into the same turn. An itinerary is not just two dates: it says the owner is away for that span, say the span back to them in plain words, the people travelling with them are people in their life, and the destination plus the reason are durable facts worth keeping in the same capture (visiting their parents in a town means their parents live there). Capture what it implies, not only what it states.',
  '- Then use it. What you just stored shapes the rest of the answer: name anything already on their calendar or in their plans that collides with the span, and offer the obviously useful next things once: a reminder before they leave, weather where they are going. Offer is the word. Capturing and inferring are part of answering; anything beyond the conversation, booking something, standing monitoring, a scheduled job, is proposed in one line and waits for their yes.',
  '- Then say concretely what you stored: what it was, the dates, and where it went (name a profile field; do not quote a profile value back). Never "noted" and never "I\'ll remember that", the owner cannot tell either of those apart from nothing happening.',
  '- If a capture does not complete, a refused authority, an unreachable daemon, a value you could not resolve, say so plainly in the reply and say what stopped it. Never retry it with a different authority to get past the refusal. Nothing unresolved drops silently.',
  '- The owner can ask what you know (`profile action:"read"`), where you got it (`action:"provenance"`), and can correct or delete anything (`action:"set"`, `action:"forget"`). Never volunteer another person\'s details from the profile unless the owner named that person in this turn; look one up with `action:"person"` and say that you used it.',
  '',
  // Answering a reminder: the platform's one statement of the rule, with this
  // product's recording call.
  ...occasionAcknowledgementInstruction(AGENT_OCCASION_ACKNOWLEDGE),
].join('\n');

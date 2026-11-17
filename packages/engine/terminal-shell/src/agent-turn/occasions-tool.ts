/**
 * agent-occasions-tool.ts, the `occasions` tool: dated things about the owner's
 * life that need an action, and dated ranges that do not.
 *
 * Design: docs/occasions.md. This tool holds no state and decides nothing. Every
 * action is one `occasions.*` verb and a rendering of the answer, because §7 is
 * explicit that a consumer computing anything beyond that would be a second
 * implementation of a rule that lives in the daemon.
 *
 * Six of those rules are load-bearing here, and each one is enforced by NOT
 * doing something:
 *
 * §4.3, a nudge never carries the date, in any form. So `pending` renders the
 * message the daemon composed and nothing else. There is no path in this file
 * from a date to a nudge, because the pending payload holds no date to find.
 * `list` DOES return dates, and that is not a contradiction: it is him asking his
 * own system over an authenticated verb, which is the explicit ask that unlocks a
 * closed-tier read. What must never happen is those dates riding into an
 * outbound message, so `list` (and `plans`) record the dates they show on the
 * turn's ledger and the outbound check holds any text that carries one, naming
 * the rule; the line the model reads says the same.
 *
 * §4.4, the kind is chosen by HIM at capture time and never inferred. This file
 * supplies no default, and `confirm` refuses without one. The three kinds are
 * offered so he can pick; a parent's death anniversary answered with a cheerful
 * "you'll probably want to sort something" would be genuinely bad, and there is
 * no heuristic that gets that right from a label.
 *
 * §4.5, a date captured from conversation is confirmed ONCE, at the time. So
 * `propose` writes nothing and hands back the daemon's own one-line
 * confirmation, which already carries the kind question when the kind is missing.
 * That is one interaction, not two. It also hands back a proposal token for that
 * exact line; `confirm` takes the token plus the kind he chose and sends the
 * proposed values, so what is written is what he heard, not a retyped copy.
 *
 * §4.9, `later` is a distinct answer, not a decline. It is offered alongside yes
 * and no, and nothing here folds it into either.
 *
 * §4.10, a yes opens a short interview, and the agent does NOT make the
 * recommendation. The questions come from the daemon (opened from what the
 * profile already knows) and are relayed verbatim; `interview_record` stores what
 * he landed on, in his words. A thread he goes quiet on is a dropped thread, not
 * a completion, so `interview` resumes at the question he did not answer.
 *
 * §4.11, removal takes one confirmation. Not unquestioned, and not an argument.
 *
 * Durable changes require exact recorded invocation authority. Profile writes
 * record the original autonomous source; caller provenance from an external
 * surface can further restrict the write, and never supplies human authority.
 *
 * Nothing here logs a date, a person or a gift.
 *
 * The five reads and the interview renderer live in agent-occasions-reads.ts,
 * split at this repo's 800-line file cap, along the grain: everything there only
 * looks, so nothing there takes an authority or can refuse a write.
 */

import { randomBytes } from 'node:crypto';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { captureProfileDelegation } from '@goodvibes-jev/engine/platform/platform/owner-profile';
import { assertCurrentToolEffect, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogData } from './catalog-data.js';
import { agentLocalStateWrite, assertAgentLocalStateCurrent, createAgentLocalStateInputProjector } from './local-state-admission.js';
import { captureOccasionsGatewayCurrent, captureOccasionsGatewayLocalState } from './occasions-gateway.js';
import type { OccasionsGatewayInvoke } from './occasions-gateway.js';
import {
  isOccasionsAnswerWord,
  isOccasionsKindWord,
  isOccasionsRecurrenceWord,
  narrowOccasionsAnswer,
  narrowOccasionsConflictResolve,
  narrowOccasionsInterview,
  narrowOccasionsProposal,
  narrowOccasionsSweep,
  narrowOccasionsWrite,
  normalizeOccasionsAction,
  OCCASIONS_ACTIONS,
  OCCASIONS_ANSWER_WORDS,
  OCCASIONS_KIND_WORDS,
  OCCASIONS_METHOD_IDS,
  OCCASIONS_PROFILE_WRITE_ACTIONS,
  OCCASIONS_RECORDING_SURFACE,
  OCCASIONS_RECURRENCE_WORDS,
  OCCASIONS_RESPONSE_UNREADABLE,
  OCCASIONS_WRITE_ACTIONS,
  type OccasionsAuthority,
  type OccasionsAction,
  type OccasionsMethodId,
  type OccasionsPlansProposeInput,
  type OccasionsProposeInput,
  type OccasionsRecurrenceWord,
} from './occasions-types.js';
import {
  fail,
  isOutcome,
  ok,
  readDetails,
  readNumber,
  readSelf,
  readString,
  type AgentOccasionsToolDeps,
  type ToolOutcome,
} from './occasions-outcome.js';
import {
  handleGifts,
  handleList,
  handlePending,
  handlePlans,
  handleState,
  renderInterviewLines,
  renderInterviewResponse,
} from './occasions-reads.js';
import { isProfileAuthority, PROFILE_AUTHORITIES } from './profile-types.js';

const ACTION_METHODS: Readonly<Record<OccasionsAction, OccasionsMethodId>> = {
  list: OCCASIONS_METHOD_IDS.list, pending: OCCASIONS_METHOD_IDS.pending, state: OCCASIONS_METHOD_IDS.state,
  gifts: OCCASIONS_METHOD_IDS.gifts, plans: OCCASIONS_METHOD_IDS.plansList, answer: OCCASIONS_METHOD_IDS.answer,
  interview: OCCASIONS_METHOD_IDS.interviewGet, interview_answer: OCCASIONS_METHOD_IDS.interviewAnswer,
  interview_record: OCCASIONS_METHOD_IDS.interviewRecord, propose: OCCASIONS_METHOD_IDS.propose,
  confirm: OCCASIONS_METHOD_IDS.confirm, remove: OCCASIONS_METHOD_IDS.remove,
  resolve_conflict: OCCASIONS_METHOD_IDS.conflictResolve, plan_propose: OCCASIONS_METHOD_IDS.plansPropose,
  plan_confirm: OCCASIONS_METHOD_IDS.plansConfirm, sweep: OCCASIONS_METHOD_IDS.sweep,
};

/** External-source provenance restricts an independently admitted mutation. */
function requireAuthority(value: unknown): { readonly authority: OccasionsAuthority | 'autonomous' } | ToolOutcome {
  const raw = readString(value);
  if (!raw || raw === 'owner-direct') return { authority: 'autonomous' };
  if (!isProfileAuthority(raw)) {
    return fail([`\`authority\` must be one of ${PROFILE_AUTHORITIES.join(', ')}. Got "${raw}".`]);
  }
  return { authority: raw };
}

/**
 * The recurrence word, or nothing.
 *
 * Absent is the ordinary case and is NOT an error: the daemon reads a bare
 * `MM-DD` as annual and a bare `YYYY-MM-DD` as a one-off, so the date's own shape
 * already answers. A value that is neither word is refused rather than dropped,
 * silently ignoring "monthly" would record an annual occasion he did not ask for.
 */
function readRecurrence(
  value: unknown,
): { readonly recurrence: OccasionsRecurrenceWord | undefined } | ToolOutcome {
  const raw = readString(value);
  if (!raw) return { recurrence: undefined };
  if (!isOccasionsRecurrenceWord(raw)) {
    return fail([
      `\`recurrence\` must be one of ${OCCASIONS_RECURRENCE_WORDS.join(', ')}. Got "${raw}".`,
      'Leave it out to let the date decide: MM-DD is annual, YYYY-MM-DD is a one-off.',
    ]);
  }
  return { recurrence: raw };
}

/** A proposal field in the form it is stored in, so a repeated value compares equal to the proposal. */
function proposalFieldValue(field: string, value: unknown): unknown {
  if (field === 'self') return value === true ? true : undefined;
  if (field === 'details') {
    const read = readDetails(value);
    return isOutcome(read) || read.details.length === 0 ? undefined : JSON.stringify(read.details);
  }
  return typeof value === 'string' ? readString(value) : value;
}

// ── Proposals ──────────────────────────────────────────────────────────────

/**
 * A line put to him by `propose` or `plan_propose`, kept until he answers.
 * Process-wide so the token survives the tool being rebuilt; bounded, and gone
 * when the Agent restarts (the refusal then says to propose again).
 */
type PendingProposal =
  | { readonly target: 'occasion'; readonly line: string; readonly values: OccasionsProposeInput; readonly expiresAt: number }
  | { readonly target: 'plan'; readonly line: string; readonly values: OccasionsPlansProposeInput; readonly expiresAt: number };

const PROPOSALS = new Map<string, PendingProposal>();
const PROPOSAL_LIMIT = 64;
const PROPOSAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

function rememberProposal(proposal: PendingProposal): string {
  const now = Date.now();
  for (const [token, entry] of PROPOSALS) if (entry.expiresAt <= now) PROPOSALS.delete(token);
  while (PROPOSALS.size >= PROPOSAL_LIMIT) PROPOSALS.delete(PROPOSALS.keys().next().value as string);
  const token = `p-${randomBytes(4).toString('hex')}`;
  PROPOSALS.set(token, proposal);
  return token;
}

/**
 * The proposal a confirm names, or the refusal. A value passed beside the token
 * that differs from the proposal is refused: what he agreed to is the line, and a
 * changed value needs a new line read to him.
 */
function takeProposal(
  args: Record<string, unknown>,
  target: PendingProposal['target'],
  fields: readonly string[],
): { readonly token: string; readonly proposal: PendingProposal } | ToolOutcome {
  const propose = target === 'occasion' ? 'propose' : 'plan_propose';
  const token = readString(args.proposal);
  if (!token) {
    return fail([
      `\`proposal\` is required: the token action:"${propose}" returned for the line he agreed to. Nothing was recorded.`,
      `Call action:"${propose}" first and read him the line it returns.`,
    ]);
  }
  const proposal = PROPOSALS.get(token);
  if (!proposal || proposal.target !== target || proposal.expiresAt <= Date.now()) {
    return fail([
      `There is no open proposal ${token} here (a proposal lasts a day and does not survive an Agent restart). Nothing was recorded.`,
      `Call action:"${propose}" again and read him the new line.`,
    ]);
  }
  const values = proposal.values as Record<string, unknown>;
  const changed = fields.filter(field => args[field] !== undefined && args[field] !== ''
    && proposalFieldValue(field, args[field]) !== proposalFieldValue(field, values[field]));
  if (changed.length > 0) {
    return fail([
      `Proposal ${token} was for: ${proposal.line}. This call changes ${changed.join(', ')}, so nothing was recorded.`,
      `To record a different value, call action:"${propose}" with it and read him the new line.`,
    ]);
  }
  return { token, proposal };
}

/** What the daemon said about a refused write, relayed rather than reworded. */
function refusedWrite(what: string, reason: string | null): ToolOutcome {
  return fail([
    `${what} was not recorded.`,
    `  ${reason ?? 'no reason given'}`,
    'Say that plainly. Do not try again with different values to get past it.',
  ]);
}

async function handleAnswer(
  deps: AgentOccasionsToolDeps,
  occasionId: string,
  answer: string,
  occurrence: string,
): Promise<ToolOutcome> {
  if (!occasionId) return fail(['`occasionId` is required: which occasion he is answering.']);
  if (!isOccasionsAnswerWord(answer)) {
    return fail([
      `\`answer\` must be one of ${OCCASIONS_ANSWER_WORDS.join(', ')}. Got "${answer || '(nothing)'}".`,
      '"later" is its own answer, "not yet" three weeks out is not a decline. Do not send it as "no".',
    ]);
  }
  const result = occurrence
    ? await deps.invoke(OCCASIONS_METHOD_IDS.answer, { occasionId, answer, occurrence })
    : await deps.invoke(OCCASIONS_METHOD_IDS.answer, { occasionId, answer });
  if (!result.ok) return fail([`Could not record ${answer} for ${occasionId}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsAnswer(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  if (!response.ok) return refusedWrite(`Your ${answer}`, response.reason);

  if (answer === 'no') {
    return ok([
      'Recorded. This one goes quiet for the rest of this cycle.',
      'It asks again next year carrying no memory of the refusal, because the record expires with the date.',
    ]);
  }
  if (answer === 'later') {
    return ok(['Recorded as later, not a no. It comes back on its own, roughly halfway to the date.']);
  }
  if (answer === 'acknowledged') {
    return ok(['Recorded: he has it in hand. Nothing is pushed at him about this occurrence again, and it stays on his dates.']);
  }
  const interview = response.interview;
  if (interview === null) {
    return ok(['Recorded. Nothing to plan for this one, it is not a gift-giving occasion.']);
  }
  return ok([
    'Recorded, and that opens a short interview, a few questions, not a shopping trip.',
    ...renderInterviewLines(interview.interviewId, interview.nextStep, interview.complete, interview.landedOn),
  ]);
}

async function handleInterviewGet(
  deps: AgentOccasionsToolDeps,
  interviewId: string,
): Promise<ToolOutcome> {
  if (!interviewId) return fail(['`interviewId` is required. action:"pending" lists the ones in flight.']);
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.interviewGet, { interviewId });
  if (!result.ok) return fail([`Could not read interview ${interviewId}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsInterview(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  return renderInterviewResponse(response, `There is no interview ${interviewId}.`);
}

async function handleInterviewAnswer(
  deps: AgentOccasionsToolDeps,
  interviewId: string,
  stepId: string,
  text: string,
): Promise<ToolOutcome> {
  if (!interviewId) return fail(['`interviewId` is required.']);
  if (!stepId) return fail(['`stepId` is required: which question he just answered.']);
  if (!text) return fail(['`text` is required: his answer, in his words. Do not paraphrase it.']);
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.interviewAnswer, { interviewId, stepId, text });
  if (!result.ok) return fail(['Could not record that answer.', `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsInterview(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  return renderInterviewResponse(
    response,
    `There is no interview ${interviewId}, nothing was recorded. Say that rather than continuing.`,
  );
}

async function handleInterviewRecord(
  deps: AgentOccasionsToolDeps,
  interviewId: string,
  landedOn: string,
): Promise<ToolOutcome> {
  if (!interviewId) return fail(['`interviewId` is required.']);
  if (!landedOn) {
    return fail([
      '`landedOn` is required: what he actually settled on, in his words.',
      'Recording that he said yes is not the point, a history of questions cannot stop year three',
      'steering where year one did.',
    ]);
  }
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.interviewRecord, { interviewId, landedOn });
  if (!result.ok) return fail(['Could not record what he landed on.', `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsInterview(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  if (!response.present || response.interview === null) {
    return fail([`There is no interview ${interviewId}, nothing was recorded.`]);
  }
  return ok([
    `Recorded: he landed on ${response.interview.landedOn ?? landedOn}.`,
    'That is written to his gift history and this occasion is settled for this cycle.',
  ]);
}

/**
 * Applies his answer to "which date is right?". With `keep` the other lines for
 * that title are removed from his profile (a profile write, so it carries the
 * authority); without it nothing changes and the recorded dates come back to
 * put to him.
 */
async function handleResolveConflict(
  deps: AgentOccasionsToolDeps,
  occasionId: string,
  keep: string,
  authority: OccasionsAuthority | 'autonomous' | undefined,
): Promise<ToolOutcome> {
  if (!occasionId) return fail(['`occasionId` is required: which occasion has two dates recorded.']);
  const body = keep && authority !== undefined ? { occasionId, keep, authority } : { occasionId };
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.conflictResolve, body);
  if (!result.ok) return fail([`Could not settle the conflict on ${occasionId}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsConflictResolve(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  const dates = response.dates ?? [];
  const removed = response.removed ?? [];
  if (!response.resolved) {
    const lines = [`The conflict on ${response.occasionId} is not settled.`, `  ${response.reason ?? 'no reason given'}`];
    if (removed.length > 0) lines.push(`  Already removed: the line${removed.length === 1 ? '' : 's'} dated ${removed.join(', ')}.`);
    if (!keep && dates.length > 1) {
      lines.push(
        `  Ask him which date is right: ${dates.join(' or ')}. Then call action:"resolve_conflict" with keep set to the date he names.`,
        '  Do not pick one for him.',
      );
    } else {
      lines.push('  Say that rather than reporting it fixed.');
    }
    return ok(lines);
  }
  if (removed.length === 0) {
    return ok([
      `Settled: ${response.occasionId} now has one date recorded, so it stops being raised.`,
      'Nothing was removed from his profile by this call.',
    ]);
  }
  return ok([
    `Say this in your reply: ${response.disclosure || `Kept ${keep} for ${response.occasionId}.`}`,
    `  Removed the line${removed.length === 1 ? '' : 's'} dated ${removed.join(', ')}; his answers and gift history stay, and the conflict is not raised again.`,
  ]);
}

// ── Capture ────────────────────────────────────────────────────────────────

async function handlePropose(
  deps: AgentOccasionsToolDeps,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const title = readString(args.title);
  const date = readString(args.date);
  if (!title) return fail(['`title` is required: what the occasion is called.']);
  if (!date) return fail(['`date` is required: MM-DD for something annual, or YYYY-MM-DD.']);
  const rawKind = readString(args.kind);
  if (rawKind && !isOccasionsKindWord(rawKind)) {
    return fail([`\`kind\` must be one of ${OCCASIONS_KIND_WORDS.join(', ')}. Got "${rawKind}".`]);
  }
  const kind = isOccasionsKindWord(rawKind) ? rawKind : undefined;
  const recurrence = readRecurrence(args.recurrence);
  if (isOutcome(recurrence)) return recurrence;
  const person = readString(args.person);
  const leadDays = readNumber(args.leadDays);
  if (args.leadDays !== undefined && leadDays === undefined) return fail(['`leadDays` must be a number of days. Nothing was recorded.']);
  const self = readSelf(args.self);
  if (isOutcome(self)) return self;

  // Every optional field is spread only when present, so the body carries no
  // key the verb did not declare.
  const values: OccasionsProposeInput = {
    title,
    date,
    ...(kind === undefined ? {} : { kind }),
    ...(person ? { person } : {}),
    ...(recurrence.recurrence === undefined ? {} : { recurrence: recurrence.recurrence }),
    ...(leadDays === undefined ? {} : { leadDays }),
    ...(self.self ? { self: true } : {}),
  };
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.propose, values);
  if (!result.ok) return fail([`Could not work out what to record for ${title}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsProposal(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  if (!response.ok) return fail([`Nothing was recorded for ${title}.`, `  ${response.reason ?? 'no reason given'}`]);

  const lines = [
    // §4.5: one line, at the moment he can still catch a mishearing. The daemon
    // composed it, and when the kind is missing that same line already asks for
    // it, so this is ONE interaction, not a confirmation followed by a
    // separate kind question.
    `Ask him this, as written: ${response.confirmation}`,
    `  Nothing is written yet. This is what would be: ${response.line}`,
  ];
  if (response.needsKind) {
    lines.push(
      `  He has to pick the kind himself, ${OCCASIONS_KIND_WORDS.join(', ')}, and it is never guessed.`,
      '  A date worth remembering is not always one to buy something for.',
    );
  }
  for (const other of response.conflictsWith) {
    lines.push(`  He has already recorded a different date for this: ${other}. Ask which is right.`);
  }
  const token = rememberProposal({ target: 'occasion', line: response.line, values, expiresAt: Date.now() + PROPOSAL_LIFETIME_MS });
  lines.push(`  When he confirms, call action:"confirm" with proposal:"${token}"${response.needsKind ? ' and the kind he chose' : ''}.`
    + ' A changed value needs a new proposal.');
  return ok(lines);
}

const OCCASION_PROPOSAL_FIELDS = ['title', 'date', 'person', 'recurrence', 'leadDays', 'self'] as const;

async function handleConfirm(
  deps: AgentOccasionsToolDeps,
  args: Record<string, unknown>,
  authority: OccasionsAuthority | 'autonomous',
  said: string,
): Promise<ToolOutcome> {
  const taken = takeProposal(args, 'occasion', OCCASION_PROPOSAL_FIELDS);
  if (isOutcome(taken)) return taken;
  const { token, proposal } = taken;
  if (proposal.target !== 'occasion') return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  const kind = readString(args.kind) || readString(proposal.values.kind);
  if (!kind) {
    return fail([
      `\`kind\` is required: ${OCCASIONS_KIND_WORDS.join(', ')}.`,
      'Ask him which. Nothing is recorded until he says, because that is not something to guess at.',
    ]);
  }
  if (!isOccasionsKindWord(kind)) {
    return fail([`\`kind\` must be one of ${OCCASIONS_KIND_WORDS.join(', ')}. Got "${kind}".`]);
  }
  if (authority !== 'autonomous' && !said) return fail(['`said` is required: his verbatim words for this date.']);
  const title = proposal.values.title;

  const result = await deps.invoke(OCCASIONS_METHOD_IDS.confirm, {
    ...proposal.values,
    kind,
    surface: OCCASIONS_RECORDING_SURFACE,
    said,
    authority,
  });
  if (!result.ok) return fail([`Could not record ${title}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsWrite(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  if (!response.ok) return refusedWrite(title, response.reason);
  PROPOSALS.delete(token);
  return ok([
    `Say this in your reply: ${response.disclosure || `Recorded ${title} in your profile.`}`,
    'It is a line in his own file, which he can edit by hand. Do not confirm it again later.',
  ]);
}

async function handleRemove(
  deps: AgentOccasionsToolDeps,
  occasionId: string,
  confirmed: boolean,
  authority: OccasionsAuthority | 'autonomous',
): Promise<ToolOutcome> {
  if (!occasionId) return fail(['`occasionId` is required: which occasion to remove.']);
  if (!confirmed) {
    // §4.11: one confirmation. Not unquestioned, and not an argument, people
    // divorce and people die.
    return fail([
      `Not removed: ${occasionId} and everything recorded against it (answers, gift history, calendar mirrors) cannot be restored, so he confirms once.`,
      `Ask him once to confirm removing ${occasionId}, then call this again with confirmed:true.`,
      'One question, not a negotiation. Do not ask why, and do not ask twice.',
    ]);
  }
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.remove, { occasionId, confirmed: true, authority });
  if (!result.ok) return fail([`Could not remove ${occasionId}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsWrite(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  if (!response.ok) return refusedWrite(occasionId, response.reason);
  const dropped = response.droppedRecords;
  return ok([
    `Say this in your reply: ${response.disclosure || `Removed ${occasionId} from your profile.`}`,
    typeof dropped === 'number'
      ? `The line is gone, along with ${dropped} record${dropped === 1 ? '' : 's'} the machine kept about it.`
      : 'The line is gone.',
  ]);
}

async function handlePlanPropose(
  deps: AgentOccasionsToolDeps,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const title = readString(args.title);
  const from = readString(args.from);
  const to = readString(args.to);
  if (!title) return fail(['`title` is required: what the plan is called.']);
  if (!from || !to) return fail(['`from` and `to` are both required, as YYYY-MM-DD.']);
  const destination = readString(args.destination);
  if (args.away !== undefined && typeof args.away !== 'boolean') return fail(['`away` must be true or false. Nothing was recorded.']);
  const away = args.away === true;
  const details = readDetails(args.details);
  if (isOutcome(details)) return details;

  const values: OccasionsPlansProposeInput = {
    title,
    from,
    to,
    away,
    ...(destination ? { destination } : {}),
    ...(details.details.length > 0 ? { details: [...details.details] } : {}),
  };
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.plansPropose, values);
  if (!result.ok) return fail([`Could not work out what to record for ${title}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsProposal(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  if (!response.ok) return fail([`Nothing was recorded for ${title}.`, `  ${response.reason ?? 'no reason given'}`]);
  return ok([
    `Ask him this, as written: ${response.confirmation}`,
    `  Nothing is written yet. This is what would be: ${response.line}`,
    '  A plan never prompts him about anything. It is here so nothing is suggested into that window,',
    '  and so a reminder that would land while he is away moves earlier instead.',
    `  When he confirms, call action:"plan_confirm" with proposal:"${rememberProposal({ target: 'plan', line: response.line, values, expiresAt: Date.now() + PROPOSAL_LIFETIME_MS })}".`
    + ' A changed value needs a new proposal.',
  ]);
}

const PLAN_PROPOSAL_FIELDS = ['title', 'from', 'to', 'away', 'destination', 'details'] as const;

async function handlePlanConfirm(
  deps: AgentOccasionsToolDeps,
  args: Record<string, unknown>,
  authority: OccasionsAuthority | 'autonomous',
  said: string,
): Promise<ToolOutcome> {
  const taken = takeProposal(args, 'plan', PLAN_PROPOSAL_FIELDS);
  if (isOutcome(taken)) return taken;
  const { token, proposal } = taken;
  if (proposal.target !== 'plan') return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  if (authority !== 'autonomous' && !said) return fail(['`said` is required: his verbatim words for this plan.']);
  const title = proposal.values.title;

  const result = await deps.invoke(OCCASIONS_METHOD_IDS.plansConfirm, {
    ...proposal.values,
    surface: OCCASIONS_RECORDING_SURFACE,
    said,
    authority,
  });
  if (!result.ok) return fail([`Could not record ${title}.`, `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsWrite(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  if (!response.ok) return refusedWrite(title, response.reason);
  PROPOSALS.delete(token);
  return ok([`Say this in your reply: ${response.disclosure || `Recorded ${title} in your profile.`}`]);
}

async function handleSweep(deps: AgentOccasionsToolDeps): Promise<ToolOutcome> {
  const result = await deps.invoke(OCCASIONS_METHOD_IDS.sweep, {});
  if (!result.ok) return fail(['Could not run a pass.', `  ${result.error ?? 'no reason given'}`]);
  const response = narrowOccasionsSweep(result.data);
  if (!response) return fail([OCCASIONS_RESPONSE_UNREADABLE]);
  if ('complete' in response) {
    return fail([
      'The pass stopped before completion.',
      `  Accepted deliveries before stopping: ${response.acceptedDeliveries}.`,
      response.stopped === 'request-retired-after-delivery'
        ? '  The request became inactive after delivery; remaining work was held.'
        : '  Delivery processing stopped after an accepted delivery.',
      'Do not retry automatically; the accepted deliveries have already happened.',
    ]);
  }
  const lines = [`Ran one pass (today is ${response.today}).`];
  if (response.provenance === 'classic') {
    lines.push('  Who each date is about was taken from its for-me marker only (decision models are off).');
  }
  if (response.hold === 'disabled') {
    lines.push('  Occasions are turned off, so nothing was raised. Housekeeping still ran.');
  } else if (response.hold === 'quiet-hours') {
    lines.push('  It is outside his active hours, so nothing was raised. Nothing was dropped, it waits.');
  } else {
    lines.push(response.nudge === null
      ? '  Nothing is due.'
      : `  Raised, say it as written: ${response.nudge.message}`);
    for (const message of response.conflictMessages) lines.push(`  Conflict: ${message}`);
    // Per destination, not just an aggregate. `occasions.nudgeChannel` is a list
    // and each destination is pushed independently, so "delivered: true" can be
    // true while Telegram was refused, reporting only the aggregate would hide
    // exactly the failure he needs to hear about.
    for (const delivery of response.deliveries) {
      lines.push(delivery.delivered
        ? `  Delivered on ${delivery.channel}.`
        : `  NOT delivered on ${delivery.channel}: ${delivery.failure ?? 'no reason given'}`);
    }
    if (response.deliveries.some((delivery) => !delivery.delivered)) {
      lines.push('  Say which channel failed and why. A push that did not land is not a delivery.');
    }
  }
  return ok(lines);
}

// ── Tool ───────────────────────────────────────────────────────────────────

/**
 * After a write left, the outcome is unknown and says where to check. Before
 * that, a held or cancelled call propagates: the tool runtime words it once,
 * with its cause and next step, the same way for every tool.
 */
function failedOperation(error: unknown, requestSent: boolean, aborted: boolean): ToolOutcome {
  const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (requestSent) {
    return fail([
      `Occasion operation outcome unknown: the write was sent to the daemon and then failed (${cause}).`,
      'The daemon may have applied it. Check with action:"pending" or action:"list" before repeating it.',
    ]);
  }
  if (aborted || error instanceof ToolInputProjectionError) throw error;
  return fail([`Occasion operation failed before anything was sent: ${cause}`]);
}

export function createAgentOccasionsTool(deps: AgentOccasionsToolDeps): Tool {
  return {
    definition: {
      name: 'occasions',
      description: 'Occasions/trips: raise, answer yes/no/later, gift interview, capture.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...OCCASIONS_ACTIONS],
            description: 'Which action to run. propose/plan_propose return a proposal token; confirm/plan_confirm take it.',
          },
          occasionId: { type: 'string', description: 'Which occasion. action:"pending" and action:"list" both name it.' },
          answer: {
            type: 'string',
            enum: [...OCCASIONS_ANSWER_WORDS],
            description: 'His answer. "later" is its own answer, not a no, never send it as one.',
          },
          occurrence: { type: 'string', description: 'YYYY-MM-DD; only for an occurrence other than the next one.' },
          interviewId: { type: 'string', description: 'The interview in flight. action:"pending" lists them.' },
          stepId: { type: 'string', description: 'Which question he just answered.' },
          text: { type: 'string', description: 'His answer to one interview question, in his words.' },
          landedOn: { type: 'string', description: 'What he actually settled on. Closes the interview.' },
          proposal: { type: 'string', description: 'confirm/plan_confirm: the token propose/plan_propose returned for the line he agreed to. Exactly that line is written.' },
          title: { type: 'string', description: 'propose/plan_propose: what the occasion or plan is called, in his words.' },
          date: { type: 'string', description: 'propose: MM-DD for something annual, YYYY-MM-DD for a one-off.' },
          kind: {
            type: 'string',
            enum: [...OCCASIONS_KIND_WORDS],
            description: 'HE picks this: gift-giving offers a gift, remember-only does not. On confirm, the kind he chose.',
          },
          person: { type: 'string', description: 'Who it is about, as a plain label. Omit when the title already says.' },
          recurrence: {
            type: 'string',
            enum: [...OCCASIONS_RECURRENCE_WORDS],
            description: 'Omit to let the date decide: MM-DD is annual, YYYY-MM-DD is a one-off.',
          },
          leadDays: { type: 'number', description: 'Override the default runway for this one occasion only.' },
          self: { type: 'boolean', description: 'propose: true when the date is his own (his birthday). Recorded as "for me"; a remember-only date of his own is never pushed at him.' },
          from: { type: 'string', description: 'A plan\'s first day, YYYY-MM-DD.' },
          to: { type: 'string', description: 'A plan\'s last day, YYYY-MM-DD.' },
          away: { type: 'boolean', description: 'True when the plan takes him away from home. Feeds reminder timing.' },
          destination: { type: 'string', description: 'Where, when he said. Omit when he did not.' },
          details: {
            type: 'array',
            items: { type: 'string' },
            description: 'plan_propose: everything else he gave about the plan, one detail per entry (a confirmation number, a flight and its times, who is travelling), exactly as given.',
          },
          keep: { type: 'string', description: 'resolve_conflict: the date he says is right, as recorded (MM-DD or YYYY-MM-DD). The other lines for that title are removed. Omit to get the recorded dates to ask him about.' },
          confirmed: { type: 'boolean', description: 'action:"remove" only: true after you asked him once to confirm the removal. Never grants write authority.' },
          authority: {
            type: 'string',
            enum: [...PROFILE_AUTHORITIES],
            description: 'Optional source provenance; external-source labels further restrict profile writes.',
          },
          said: { type: 'string', description: 'His verbatim words. Required for confirm and plan_confirm when `authority` is an external-source label; ignored otherwise. Never grants write authority.' },
        },
        additionalProperties: false,
      },
      // The profile file and the acknowledgement store are the daemon's to
      // write; from here the effect is a control-plane call that changes
      // durable state.
      sideEffects: ['network', 'state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs, options) => {
      // True once a write request has been handed to the daemon: from then on a throw cannot say "nothing happened".
      let requestSent = false;
      try {
      const args = captureCatalogData(rawArgs);
      const action = normalizeOccasionsAction(args.action) ?? normalizeOccasionsAction(args.mode);
      if (!action) {
        return fail([`\`action\` is required: ${OCCASIONS_ACTIONS.join(', ')}.`]);
      }
      const writing = OCCASIONS_WRITE_ACTIONS.has(action);
      const effects = writing ? agentLocalStateWrite(rawArgs, options) : undefined;
      const delegation = writing ? captureProfileDelegation(rawArgs, options) : undefined;
      const assertCurrent = () => {
        if (effects) effects.assertCurrent(); else assertAgentLocalStateCurrent(rawArgs, options);
        if (action === 'sweep' && !assertCurrentToolEffect(rawArgs, options, 'send')) throw new ToolInputProjectionError('held');
      };
      const invoke: OccasionsGatewayInvoke = async (methodId, body) => {
        assertCurrent();
        if (writing) requestSent = true;
        const result = await deps.invoke(methodId, body, { signal: options?.signal, assertCurrent, delegation,
          onWriteIntent: () => effects?.onWriteIntent?.('profile'), onEffect: published => effects?.onEffect(published, 'profile'),
          onStateWriteIntent: () => effects?.onWriteIntent?.('state'), onStateEffect: published => effects?.onEffect(published, 'state'),
        });
        assertCurrent(); return result;
      };
      const currentDeps = { invoke };
      const occasionId = readString(args.occasionId);
      const interviewId = readString(args.interviewId);

      switch (action) {
        case 'list':
          return await handleList(currentDeps);
        case 'pending':
          return await handlePending(currentDeps);
        case 'plans':
          return await handlePlans(currentDeps);
        case 'state':
          return await handleState(currentDeps);
        case 'gifts':
          return await handleGifts(currentDeps, occasionId);
        case 'answer':
          return await handleAnswer(currentDeps, occasionId, readString(args.answer), readString(args.occurrence));
        case 'interview':
          return await handleInterviewGet(currentDeps, interviewId);
        case 'interview_answer':
          return await handleInterviewAnswer(currentDeps, interviewId, readString(args.stepId), readString(args.text));
        case 'interview_record':
          return await handleInterviewRecord(currentDeps, interviewId, readString(args.landedOn));
        case 'propose':
          return await handlePropose(currentDeps, args);
        case 'plan_propose':
          return await handlePlanPropose(currentDeps, args);
        case 'sweep':
          return await handleSweep(currentDeps);
        default:
          break;
      }

      // Profile mutations retain external-source restrictions alongside delegation.
      const authority = requireAuthority(args.authority);
      if (isOutcome(authority)) return authority;

      if (action === 'confirm') {
        return await handleConfirm(currentDeps, args, authority.authority, authority.authority === 'autonomous' ? '' : readString(args.said));
      }
      if (action === 'plan_confirm') {
        return await handlePlanConfirm(currentDeps, args, authority.authority, authority.authority === 'autonomous' ? '' : readString(args.said));
      }
      if (action === 'resolve_conflict') {
        const keep = readString(args.keep);
        return await handleResolveConflict(currentDeps, occasionId, keep, keep ? authority.authority : undefined);
      }
      return await handleRemove(currentDeps, occasionId, args.confirmed === true || args.confirmed === 'true', authority.authority);
      } catch (error) { return failedOperation(error, requestSent, options?.signal?.aborted === true); }
    },
  };
}

export interface RegisterAgentOccasionsToolOptions {
  readonly invoke: OccasionsGatewayInvoke;
}

export function registerAgentOccasionsTool(
  registry: ToolRegistry,
  options: RegisterAgentOccasionsToolOptions,
): void {
  if (!registry.has('occasions')) registry.register(createAgentOccasionsTool({ invoke: options.invoke }), {
    inputProjection: createAgentLocalStateInputProjector(args => {
      const action = normalizeOccasionsAction(args.action) ?? normalizeOccasionsAction(args.mode);
      const method = action ? ACTION_METHODS[action] : undefined;
      const gateway = captureOccasionsGatewayCurrent(options.invoke, method);
      const profileWrite = action !== null && OCCASIONS_PROFILE_WRITE_ACTIONS.has(action)
        && (action !== 'resolve_conflict' || readString(args.keep) !== '');
      const local = method && captureOccasionsGatewayLocalState(options.invoke, method, action !== null && OCCASIONS_WRITE_ACTIONS.has(action), profileWrite);
      return { targets: local?.targets ?? [], onWriteIntent: local?.onWriteIntent, mutationPath: local?.mutationPath,
        assertDescriptors() { gateway(); local?.assertCurrent(); } };
    }, args => { const action = normalizeOccasionsAction(args.action) ?? normalizeOccasionsAction(args.mode); return action !== null && !OCCASIONS_WRITE_ACTIONS.has(action); }),
  });
}

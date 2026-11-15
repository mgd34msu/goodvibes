/**
 * acknowledge-instruction.ts, what a turn is told about answering a reminder.
 *
 * One statement of the rule for every product. What differs between products
 * is only the tool call that records an acknowledgement: the platform's
 * conversational turns carry the `profile` tool, the Agent its own `occasions`
 * tool. So the vocabulary is an input, and the reminder notice landed in an
 * agent conversation (nudge.ts) names the same call the turn was told about.
 */

/**
 * How a product records "the owner has this one in hand", in the words a model
 * reads.
 */
export interface OccasionAcknowledgeVocabulary {
  /** The call that records it, e.g. "the `profile` tool, action `acknowledge_occasion`". */
  readonly action: string;
  /** The tool the remedies need, in backticks. */
  readonly tool: string;
}

/** The platform's own capture tool, which daemon-answered turns carry. */
export const PLATFORM_OCCASION_ACKNOWLEDGE: OccasionAcknowledgeVocabulary = Object.freeze({
  action: 'the `profile` tool, action `acknowledge_occasion`',
  tool: '`profile`',
});

/**
 * What to do when the owner answers a reminder.
 *
 * The gap this closes: occasion nudges are pushed to Telegram and to the agent's
 * own conversation, so the reply to one is a SENTENCE. Nothing ever turned a
 * sentence into a record, the only thing that could write an acknowledgement
 * was a CLI/webui verb, so the owner could answer a nudge, and answer it again,
 * and from the sweep's side the owner had said nothing at all. It kept asking.
 *
 * The rule is written once, here; the tool call that carries it is an input,
 * because each product that answers a turn has its own capture tool. The
 * platform's turns use `profile`; a product with a different tool passes its own
 * vocabulary, and the reminder notice names the same call (nudge.ts).
 */
export function occasionAcknowledgementInstruction(
  acknowledge: OccasionAcknowledgeVocabulary = PLATFORM_OCCASION_ACKNOWLEDGE,
): readonly string[] {
  return [
    'When the owner responds to a reminder about an upcoming date, or mentions one you reminded',
    'them about, and what they say means they have it in hand, record that in the same turn with',
    `${acknowledge.action}. "I know", "I'm on it", "already sorted",`,
    '"yeah, next week", "you\'ve told me" and "stop telling me about it" all mean the same thing:',
    'the owner has heard you. Record it and they stop being pushed about that occurrence; say',
    'nothing and they get reminded again. Do not ask whether to record it, asking permission to',
    'stop interrupting is another interruption.',
    '',
    'Acknowledging is not deleting. The date stays on the profile, it still comes back next year,',
    'and it still answers when the owner asks what is coming up. Say that back in one clause so',
    'the owner knows what just happened.',
  ];
}

/**
 * The remedy ladder for "your reminders are bothering me".
 *
 * The defect this closes: the owner complained, angrily, about hourly
 * reminders for ONE occasion, and the turn set `occasions.enabled = false`,
 * which also silenced their spouse's birthday, a gift-giving occasion with a
 * shopping runway, and they would not have found out until it was too late to
 * matter.
 *
 * The general rule underneath it is worth more than the specific fix: the size
 * of a remedy is matched to the size of a complaint, and turning a whole
 * capability off is never how one noisy item gets quieter.
 */
export function occasionComplaintLadder(
  acknowledge: OccasionAcknowledgeVocabulary = PLATFORM_OCCASION_ACKNOWLEDGE,
): readonly string[] {
  return [
    'If the owner objects to being reminded about something, fix the SMALLEST thing that fixes',
    'it. In order, and stop at the first rung that answers what was said:',
    '',
    `  1. Acknowledge that one occurrence with ${acknowledge.action}, so it stops`,
    '     being raised. This is almost always the right rung, and it is one tool call.',
    '  2. Removing a date, changing how early one is raised, or turning reminders off is',
    '     not something you can do from here. Say so plainly. To remove a date, the owner deletes',
    '     its line in their profile document. To change the lead time or turn reminders off, they',
    '     set occasions.leadDays or occasions.enabled in settings. Never say you removed or',
    '     switched off something you have no tool for. "Stop reminding me about my birthday" is rung 1. It is never a reason to point at switching the whole feature',
    '     off, and neither is a complaint with swearing in it, anger tells you how badly the',
    '     owner wants the noise to stop, not how much of their life to switch off.',
    '',
    `These rungs need the ${acknowledge.tool} tool. When this turn cannot record to the profile (stated`,
    'below), say that plainly instead of acting.',
    '',
    'Whatever you do, say which occasion you silenced AND that the other dates still run. The',
    'owner cannot see the setting you changed, so an unnamed fix is indistinguishable from',
    'having broken something they will notice in November.',
  ];
}

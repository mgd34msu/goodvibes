/**
 * Asking for work: in your own words (the host decides whether it is an answer
 * or a piece of work), as a goal with what done means, or from a file; and the
 * journal that makes a lost answer safe to send again (a submission, input
 * waiting to be admitted). The program holding the conversation keeps that
 * journal and sends through its own link to the host, so these run there (home
 * `session`); the work itself is the daemon's.
 */
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription } from '../types.js';

/** What asking for work needs from the program holding the conversation: each act in words. */
export interface WorkIntakeCapabilityServices {
  readonly workIntake?: {
    request(goal: string): Promise<string>;
    newWork(goal: string, criteria: string): Promise<string>;
    submitFile(path: string): Promise<string>;
    submission(act: 'status' | 'retry' | 'discard'): Promise<string>;
    intake(act: 'status' | 'retry' | 'resume' | 'cancel'): Promise<string>;
  } | undefined;
}

function servicesOf(services: WorkIntakeCapabilityServices): NonNullable<WorkIntakeCapabilityServices['workIntake']> {
  if (!services.workIntake) throw new CapabilityRefusal('Asking for work is not available in this session.');
  return services.workIntake;
}

type Intake = CapabilityDefinition<WorkIntakeCapabilityServices>;

const GOAL: InputDescription = { id: 'goal', label: 'What you want done', help: 'In your own words, as you would ask in the chat', kind: 'long-text', freeTextReason: 'your own words for the work', required: true, typed: { tail: true } };

function act(id: string, actionId: string, label: string, sentence: string, inputs: readonly InputDescription[], example: Record<string, string>,
  run: (intake: NonNullable<WorkIntakeCapabilityServices['workIntake']>, values: Readonly<Record<string, string>>) => Promise<string>,
  extra: Partial<Pick<Intake, 'risk' | 'touches'>> & { readonly repeat?: 'safe' | 'unsafe' } = {}): Intake {
  const { repeat, ...rest } = extra;
  return {
    capability: { id, group: 'work', home: 'session', repeat: repeat ?? 'safe' }, actionId, label, word: actionId, inputs, sentence, done: '',
    touches: 'another-machine', lasts: 'not-a-change', risk: 'none', example, ...rest,
    async run(values, services) { return { text: await run(servicesOf(services), values) }; },
  };
}

export const WORK_INTAKE_CAPABILITIES: readonly Intake[] = [
  act('work.request', 'request', 'Ask for work in your own words', '"{goal}" is sent to the host, which answers it or makes it a piece of work.',
    [GOAL], { goal: 'add retries to the uploader' }, (intake, values) => intake.request(values.goal!), { repeat: 'unsafe' }),
  act('work.new', 'new', 'Ask for new work, and say what done means',
    '"{goal}" is sent to the host as new work, done when: {criteria}. It is kept here until the host has it.',
    [
      { id: 'criteria', label: 'Done when', help: 'What must be true when it is done, one per line (1 to 100)', kind: 'long-text', freeTextReason: 'what done means', required: true, typed: { flag: '--done-when' } },
      { ...GOAL, help: 'In your own words' },
    ], { goal: 'add retries to the uploader', criteria: 'an upload that fails twice still finishes' },
    (intake, values) => intake.newWork(values.goal ?? '', values.criteria ?? ''), { repeat: 'unsafe' }),
  act('work.submit-file', 'submit-file', 'Submit work from a file', 'The work described in {path} is sent to the host; it is kept here until the host has it.',
    [{ id: 'path', label: 'File', help: 'A JSON file with "goal" and "criteria"', kind: 'path', freeTextReason: 'a file on this machine', required: true, typed: { tail: true } }],
    { path: 'work.json' }, (intake, values) => intake.submitFile(values.path ?? ''), { repeat: 'unsafe' }),
  act('work.submission', 'submission', 'See the submitted file\'s state', 'Shows whether the work last submitted from a file reached the host.', [], {},
    (intake) => intake.submission('status'), { touches: 'reads' }),
  act('work.submission-retry', 'submission-retry', 'Send the submitted file again', 'The work last submitted from a file is sent to the host again; the host keeps it once.', [], {},
    (intake) => intake.submission('retry')),
  act('work.submission-discard', 'submission-discard', 'Drop the submitted file', 'The saved submission the host has no record of is dropped, so a corrected one can be sent.', [], {},
    (intake) => intake.submission('discard'), { risk: 'cannot-be-undone' }),
  act('work.intake', 'intake', 'See input waiting to be admitted', 'Shows the input you typed that waits for the host to admit it, and what happens next.', [], {},
    (intake) => intake.intake('status'), { touches: 'reads' }),
  act('work.intake-retry', 'intake-retry', 'Try admitting the input again', 'The waiting input is sent to the host again; the host admits it once.', [], {},
    (intake) => intake.intake('retry')),
  act('work.intake-resume', 'intake-resume', 'Go on with the admitted input', 'The input the host admitted goes on to its turn.', [], {},
    (intake) => intake.intake('resume'), { repeat: 'unsafe' }),
  act('work.intake-cancel', 'intake-cancel', 'Drop the input waiting to be admitted', 'The waiting input is dropped and nothing starts from it.', [], {},
    (intake) => intake.intake('cancel'), { risk: 'cannot-be-undone' }),
];

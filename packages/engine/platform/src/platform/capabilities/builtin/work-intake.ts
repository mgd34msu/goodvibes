/**
 * Asking for work: in your own words (the daemon decides whether it is an
 * answer or a piece of work), or as new work with what done means, written
 * here or read from a file; and what has no answer yet. The program holding
 * the conversation keeps a copy of what it sent until the daemon answers, so a
 * lost answer is safe to send again: the work you asked for, and the message
 * you typed. Both wait in the Work place's Unanswered list, where each is
 * checked, sent again, gone on with or dropped. These run in that program
 * (home `session`); the work itself is the daemon's.
 */
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription } from '../types.js';

/** What asking for work needs from the program holding the conversation: each act in words. */
export interface WorkIntakeCapabilityServices {
  readonly workIntake?: {
    request(goal: string): Promise<string>;
    /** New work: from a file when `file` is given, else from what you want done and its results. */
    newWork(input: { readonly goal?: string | undefined; readonly criteria?: string | undefined; readonly file?: string | undefined }): Promise<string>;
    /** The work you asked for that has no answer yet. */
    sent(act: 'status' | 'retry' | 'discard'): Promise<string>;
    /** The message you typed that has no answer yet. */
    typed(act: 'status' | 'retry' | 'resume' | 'cancel'): Promise<string>;
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
  extra: Partial<Pick<Intake, 'risk' | 'touches' | 'button'>> & { readonly repeat?: 'safe' | 'unsafe' } = {}): Intake {
  const { repeat, ...rest } = extra;
  return {
    capability: { id, group: 'work', home: 'session', repeat: repeat ?? 'safe' }, actionId, label, word: actionId, inputs, sentence, done: '',
    touches: 'another-machine', lasts: 'not-a-change', risk: 'none', example, ...rest,
    async run(values, services) { return { text: await run(servicesOf(services), values) }; },
  };
}

const blank = (value: string | undefined): boolean => value === undefined || value.trim() === '';

export const WORK_INTAKE_CAPABILITIES: readonly Intake[] = [
  act('work.request', 'request', 'Ask for work in your own words', '"{goal}" is sent to the daemon, which answers it or makes it a piece of work.',
    [GOAL], { goal: 'add retries to the uploader' }, (intake, values) => intake.request(values.goal!), { repeat: 'unsafe' }),
  act('work.new', 'new', 'Ask for new work, and say what done means',
    'New work is sent to the daemon: what you want done and the results that mean it is done, written here or read from a file. A copy is kept here until the daemon answers.',
    [
      // An empty blank's words show in the form beside its label: what leaving it empty means there.
      { ...GOAL, help: 'In your own words (leave it empty when the work comes from a file)', required: { default: '', defaultMeans: 'given by the file' } },
      { id: 'criteria', label: 'Done when', help: 'The results that mean it is done, one per line (1 to 100; empty when the work comes from a file)', kind: 'long-text', freeTextReason: 'what done means', required: { default: '', defaultMeans: 'given by the file' }, typed: { flag: '--done-when' } },
      { id: 'file', label: 'From a file', help: 'A JSON file on this computer with "goal" and "criteria", in place of the two above', kind: 'path', freeTextReason: 'a file on this computer', required: { default: '', defaultMeans: 'none: written here' }, typed: { flag: '--file' } },
    ], { goal: 'add retries to the uploader', criteria: 'an upload that fails twice still finishes' },
    (intake, values) => {
      if (blank(values.file) && (blank(values.goal) || blank(values.criteria))) {
        throw new CapabilityRefusal('Nothing was sent: say what you want done and when it is done, or name a file that says both.');
      }
      return intake.newWork({ goal: values.goal, criteria: values.criteria, file: values.file });
    }, { repeat: 'unsafe' }),
  act('work.submission', 'submission', 'Check work you asked for that has no answer', 'Asks the daemon whether the work you asked for from this folder reached it, while that request has no answer yet.', [], {},
    (intake) => intake.sent('status'), { touches: 'reads' }),
  act('work.submission-retry', 'submission-retry', 'Send work you asked for again', 'The work you asked for that has no answer is sent to the daemon again, exactly as before; the daemon keeps it once.', [], {},
    (intake) => intake.sent('retry')),
  act('work.submission-discard', 'submission-discard', 'Drop work you asked for that has no answer', 'The work you asked for that the daemon has no record of is dropped here, so you can ask again.', [], {},
    // The confirming button reads whole in a narrow window.
    (intake) => intake.sent('discard'), { risk: 'cannot-be-undone', button: 'Drop it' }),
  act('work.intake', 'intake', 'Check a message that has no answer', 'Asks the daemon what became of the message you typed that has no answer yet.', [], {},
    (intake) => intake.typed('status'), { touches: 'reads' }),
  act('work.intake-retry', 'intake-retry', 'Try a message again', 'The message you typed that has no answer is sent to the daemon again; the daemon takes it once.', [], {},
    (intake) => intake.typed('retry')),
  act('work.intake-resume', 'intake-resume', 'Go on with a message', 'The message the daemon was taking when it was interrupted goes on to its answer.', [], {},
    (intake) => intake.typed('resume'), { repeat: 'unsafe' }),
  act('work.intake-cancel', 'intake-cancel', 'Drop a message that has no answer', 'The message you typed that has no answer is dropped and nothing starts from it.', [], {},
    (intake) => intake.typed('cancel'), { risk: 'cannot-be-undone', button: 'Drop it' }),
];

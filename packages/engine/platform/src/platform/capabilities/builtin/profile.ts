/**
 * About you: what the platform knows about the person who owns it, kept as
 * one hand-editable Markdown file the daemon owns (docs/owner-profile.md),
 * read and written only through the daemon's `profile.*` methods (their
 * trust gate, policy and native write path are the only way to the file).
 * Each capability calls its method as the same caller and words the answer.
 *
 * What the method needs that only the caller knows comes from the caller: the
 * surface a write is recorded as is the program that asked (`tui`, `agent`;
 * `webui` for a browser or a script), and a write is the owner's own words
 * (`owner-direct`) only because it is owner-only: no model and no other agent
 * reaches it (`ownerOnly`). Values reach exactly one place: the text a read
 * returns. A write says the daemon's one-line disclosure, never the value.
 * People are third-party personal data: a read for anyone but the person
 * counts them, and "See what is known about a person" is the way through.
 */
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';
import { PROFILE_FIELDS } from '../../owner-profile/fields.js';

type ProfileDefinition = CapabilityDefinition<unknown>;

const daemon = (id: string, repeat: 'safe' | 'unsafe') => ({ id, group: 'memory' as const, home: 'daemon' as const, repeat });
const UNREADABLE = 'The daemon answered in a shape this build does not recognise. Nothing was read or changed by this call.';
const OWNER_ONLY = {
  reason: 'it writes your profile as your own words, with your own credential',
  instead: 'Use the profile tool (set, append, undo or forget): it writes under the Agent\'s delegated authority and records where the fact came from.',
};

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const list = (value: unknown): readonly Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];

async function call(caller: CapabilityCaller, methodId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!caller.method) throw new CapabilityRefusal('Your profile is read and written by the daemon, and no daemon dispatch ran this call; nothing was read or changed.');
  const answer = await caller.method(methodId, body);
  if (answer === null || typeof answer !== 'object') throw new CapabilityRefusal(UNREADABLE);
  return answer as Record<string, unknown>;
}

/** The surface a write is recorded as: the program that asked. */
function surfaceOf(caller: CapabilityCaller): string {
  return caller.program === 'agent' ? 'agent' : caller.program === 'tui' ? 'tui' : 'webui';
}

function provenance(value: unknown): string {
  const origin = record(value);
  return str(origin.surface) ? `, from ${str(origin.surface)} on ${str(origin.date)}, you said: "${str(origin.said)}"` : '';
}

/** A write's answer: done with its disclosure, or not done with the daemon's reason. */
function written(answer: Record<string, unknown>, target: string, done: string): { readonly text: string; readonly data: Record<string, unknown> } {
  if (typeof answer.ok !== 'boolean') throw new CapabilityRefusal(UNREADABLE);
  // A refusal, "there was nothing to forget", and a line whose text no longer matches are all not done.
  if (!answer.ok) throw new CapabilityRefusal(`Not done: ${target}. ${str(answer.reason) || 'No reason was given.'}`);
  return { text: str(answer.disclosure) || done, data: { ok: true } };
}

const FIELD: InputDescription = {
  id: 'field', label: 'Fact', help: 'The facts recorded about you: your shipping address, birthday, phone number and the like', kind: 'choice',
  choices: { list: 'about-me.fields' as ListName, allowOther: { reason: 'a field id such as commerce.shippingAddress' } }, required: true, typed: { position: 1 },
};
/**
 * The fact to record: every kind of fact a profile holds (owner-profile/fields.ts), set or not, by its label, so an
 * empty profile offers them all; the facts already recorded are the ones the other actions choose from (`FIELD`).
 */
const FIELD_TO_RECORD: InputDescription = {
  id: 'field', label: 'Fact', help: 'The kind of fact: your shipping address, birthday, phone number and the like', kind: 'choice',
  choices: PROFILE_FIELDS.map((field) => ({ value: field.id, label: `${field.label} (${field.section})` })), required: true, typed: { position: 1 },
};
const SECTION = (position?: 1): InputDescription => ({
  id: 'section', label: 'Section', help: position ? 'The section the line is in' : 'Where the line goes', kind: 'choice',
  choices: { list: 'about-me.sections' as ListName, allowOther: { reason: 'a section name' } },
  required: position ? true : { default: 'Notes', defaultMeans: 'Notes' }, typed: position ? { position } : { flag: '--section' },
});

function read(fields: Pick<ProfileDefinition, 'capability' | 'actionId' | 'label' | 'word' | 'sentence' | 'run'> & Partial<Pick<ProfileDefinition, 'inputs' | 'example'>>): ProfileDefinition {
  return { inputs: [], example: {}, done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', ...fields };
}
function change(fields: Pick<ProfileDefinition, 'capability' | 'actionId' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'> & Partial<Pick<ProfileDefinition, 'risk' | 'undoneBy'>>): ProfileDefinition {
  return { done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', ownerOnly: OWNER_ONLY, ...fields };
}

export const PROFILE_SHOW = read({
  capability: daemon('about-me.show', 'safe'), actionId: 'show', label: 'See what GoodVibes knows about you', word: 'show',
  sentence: 'Shows your profile by section, each fact with where it came from.',
  async run(_values, _services, caller) {
    const document = await call(caller, 'profile.read', {});
    const state = record(document.state);
    if (state.kind === 'unavailable') throw new CapabilityRefusal(`Your profile could not be read: ${str(state.reason) || 'no reason given'} (${str(state.path)}).`);
    if (state.kind === 'disabled') return { text: `Your profile is turned off (${str(state.path)}).`, data: { state: 'disabled' } };
    const lines = [`About you (${str(state.path)})`];
    if (state.exists === false) lines.push('  The file does not exist yet; nothing has been recorded.');
    for (const section of list(document.sections)) {
      const heading = str(section.heading);
      const fields = list(section.fields);
      const prose = list(section.prose);
      lines.push(`  ## ${heading}`);
      // People are third-party personal data: only the person reads them in a list.
      if (heading.trim().toLowerCase() === 'people' && caller.personAsked !== true) {
        const count = fields.length + prose.length;
        lines.push(`    ${count} ${count === 1 ? 'person' : 'people'} recorded; not listed here.`, '    "See what is known about a person" shows one.');
        continue;
      }
      if (fields.length === 0 && prose.length === 0) { lines.push('    (nothing recorded)'); continue; }
      for (const field of fields) lines.push(`    ${str(field.label)}: ${str(field.value)}  [${str(field.fieldId)}]${provenance(field.provenance)}${field.valid === false ? `  (did not parse: ${str(field.invalidReason) || 'no reason given'})` : ''}`);
      for (const line of prose) lines.push(`    ${str(line.text)}${provenance(line.provenance)}`);
    }
    return { text: lines.join('\n'), data: { sections: list(document.sections).length } };
  },
});

export const PROFILE_FIELD = read({
  capability: daemon('about-me.field', 'safe'), actionId: 'field', label: 'See one fact about you', word: 'field', inputs: [FIELD],
  sentence: 'Shows what GoodVibes knows of fact {field} (your shipping address, birthday, phone number and the like): its value and where it came from.', example: { field: 'commerce.shippingAddress' },
  async run(values, _services, caller) {
    const response = await call(caller, 'profile.get', { fieldId: values.field! });
    const field = record(response.field);
    if (response.present !== true || !str(field.fieldId)) throw new CapabilityRefusal(`${values.field} is not set in your profile.`);
    return {
      text: [
        `${str(field.label)}: ${str(field.value)}`,
        ...(field.valid === false ? [`  did not parse: ${str(field.invalidReason) || 'no reason given'}; kept as written, treated as unset`] : []),
        field.provenance ? `  ${provenance(field.provenance).slice(2)}` : '  no provenance recorded; you wrote or edited this line by hand.',
        ...(str(response.disclosure) ? [str(response.disclosure)] : []),
      ].join('\n'),
      data: { fieldId: str(field.fieldId), present: true },
    };
  },
});

export const PROFILE_PERSON = read({
  capability: daemon('about-me.person', 'safe'), actionId: 'person', label: 'See what is known about a person', word: 'person',
  inputs: [{ id: 'name', label: 'Person', help: 'Their name as you would say it: family, a friend, someone you work with', kind: 'text', freeTextReason: 'a name you know them by', required: true, typed: { tail: true } }],
  sentence: 'Shows what GoodVibes knows about {name}, a person in your life (a sister, a friend, a colleague).', example: { name: 'Ada' },
  async run(values, _services, caller) {
    const response = await call(caller, 'profile.person', { name: values.name! });
    const lines = list(response.lines);
    if (lines.length === 0) throw new CapabilityRefusal(`No one called ${str(response.name) || values.name} is recorded in your profile.`);
    return {
      text: [str(response.name) || values.name!, ...lines.map((line) => `  ${str(line.text)}${provenance(line.provenance)}`), ...(str(response.disclosure) ? [str(response.disclosure)] : [])].join('\n'),
      data: { name: str(response.name), lines: lines.length },
    };
  },
});

export const PROFILE_WHERE = read({
  capability: daemon('about-me.where', 'safe'), actionId: 'where', label: 'See where a fact came from', word: 'where', inputs: [FIELD],
  sentence: 'Shows where fact {field} came from: the surface, the date and your exact words, and the values it replaced.', example: { field: 'commerce.shippingAddress' },
  async run(values, _services, caller) {
    const response = await call(caller, 'profile.provenance', { fieldId: values.field! });
    if (response.present !== true) throw new CapabilityRefusal(`${values.field} is not in your profile; there is nothing to trace.`);
    return {
      text: [
        str(response.fieldId) || values.field!,
        response.provenance ? `  ${provenance(response.provenance).slice(2)}` : response.handEdited === true ? '  no provenance recorded; you edited this line by hand.' : '  no provenance recorded.',
        ...list(response.superseded).map((entry) => {
          const origin = record(entry.provenance);
          return `  was: ${[str(entry.value), str(origin.surface) ? `via ${str(origin.surface)} on ${str(origin.date)}, you said: "${str(origin.said)}"` : '', `replaced ${str(entry.supersededOn)}`].filter(Boolean).join(', ')}`;
        }),
      ].join('\n'),
      data: { fieldId: str(response.fieldId), replaced: list(response.superseded).length },
    };
  },
});

export const PROFILE_STATUS = read({
  capability: daemon('about-me.status', 'safe'), actionId: 'status', label: 'Check that your profile loads', word: 'status',
  sentence: 'Says whether your profile (what GoodVibes knows about you) loaded, from where, and which facts did not parse.',
  async run(_values, _services, caller) {
    const response = await call(caller, 'profile.status', {});
    const invalid = list(response.invalidFields);
    const sections = Array.isArray(response.sections) ? response.sections.map(str).filter(Boolean) : [];
    return {
      text: [
        `Your profile: ${str(response.kind)}`,
        ...(str(response.reason) ? [`  ${str(response.reason)}`] : []),
        `  file ${str(response.path)}`,
        ...(response.exists === false ? ['  the file does not exist yet'] : []),
        ...(sections.length > 0 ? [`  sections ${sections.join(', ')}`] : []),
        ...(typeof response.fieldCount === 'number' ? [`  facts ${response.fieldCount}`] : []),
        ...(typeof response.proseLineCount === 'number' ? [`  lines ${response.proseLineCount}`] : []),
        ...(invalid.length === 0 ? ['  every fact parses'] : invalid.map((entry) => `  did not parse ${str(entry.fieldId)}: ${str(entry.reason)}`)),
      ].join('\n'),
      data: { kind: str(response.kind), invalid: invalid.length },
    };
  },
});

export const PROFILE_SET = change({
  capability: daemon('about-me.set', 'safe'), actionId: 'set', label: 'Set a fact about you', word: 'set',
  inputs: [FIELD_TO_RECORD, { id: 'value', label: 'Value', help: 'What it is now', kind: 'text', freeTextReason: 'your own words for the fact', required: true, typed: { tail: true } }],
  sentence: 'Fact {field} is recorded as "{value}" in your own words, and GoodVibes knows it until you change it.', example: { field: 'commerce.shippingAddress', value: '1 Main St' },
  undoneBy: 'undo',
  async run(values, _services, caller) {
    // The person's own request, typed or submitted: his words are what he gave (the trust gate's verbatim quote).
    const answer = await call(caller, 'profile.set', {
      fieldId: values.field!, value: values.value!, surface: surfaceOf(caller), said: `${values.field} is ${values.value}`, authority: 'owner-direct',
    });
    // The fact by its label, as the form and the question showed it.
    const label = PROFILE_FIELDS.find((field) => field.id === values.field)?.label ?? values.field;
    return written(answer, `${label} was not recorded`, `Saved ${label} to your profile.`);
  },
});

export const PROFILE_NOTE = change({
  capability: daemon('about-me.note', 'unsafe'), actionId: 'note', label: 'Add a line about you', word: 'note',
  inputs: [SECTION(), { id: 'text', label: 'Line', help: 'The line, in your words', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  sentence: 'The line "{text}" is added to what GoodVibes knows about you, until you change it.', example: { section: 'Work', text: 'I work from Vienna on Fridays' },
  undoneBy: 'forget-line',
  async run(values, _services, caller) {
    const section = values.section || 'Notes';
    const answer = await call(caller, 'profile.append', { section, text: values.text!, surface: surfaceOf(caller), said: values.text!, authority: 'owner-direct' });
    return written(answer, `the line was not added to ${section}`, `Added a line to ${section} in your profile.`);
  },
});

export const PROFILE_UNDO = change({
  capability: daemon('about-me.undo', 'safe'), actionId: 'undo', label: 'Put back a fact\'s earlier value', word: 'undo', inputs: [FIELD],
  sentence: 'Fact {field} gets back the value it had before its last change, until you change it.', example: { field: 'commerce.shippingAddress' },
  async run(values, _services, caller) {
    const answer = await call(caller, 'profile.undo', { fieldId: values.field!, authority: 'owner-direct' });
    return written(answer, `${values.field} was not put back`, `Put back the earlier ${values.field} in your profile.`);
  },
});

export const PROFILE_FORGET = change({
  capability: daemon('about-me.forget', 'safe'), actionId: 'forget', label: 'Forget a fact', word: 'forget', inputs: [FIELD],
  sentence: 'Fact {field} and every earlier value kept for it are deleted from your profile: GoodVibes no longer knows it.', example: { field: 'commerce.shippingAddress' },
  risk: 'cannot-be-undone',
  async run(values, _services, caller) {
    const answer = await call(caller, 'profile.forget', { fieldId: values.field!, authority: 'owner-direct' });
    return written(answer, `${values.field} was not deleted`, `Deleted ${values.field} from your profile.`);
  },
});

export const PROFILE_FORGET_LINE = change({
  capability: daemon('about-me.forget-line', 'safe'), actionId: 'forget-line', label: 'Forget a line', word: 'forget-line',
  inputs: [
    SECTION(1),
    // Named by its exact text, never by position: the owner edits this file himself, so a
    // position read earlier may address another line by the time the delete lands (§9.2).
    { id: 'line', label: 'Line', help: 'The line, exactly as shown', kind: 'choice', choices: { list: 'about-me.lines' as ListName, dependsOn: 'section', allowOther: { reason: 'the exact text of the line' } }, required: true, typed: { tail: true } },
  ],
  sentence: 'The line "{line}" is deleted from section {section} of your profile.', example: { section: 'Notes', line: 'Allergic to cats' },
  risk: 'cannot-be-undone',
  async run(values, _services, caller) {
    const answer = await call(caller, 'profile.forget', { section: values.section!, text: values.line!, authority: 'owner-direct' });
    return written(answer, `the line "${values.line}" under ${values.section} was not deleted`, `Deleted the line from ${values.section}.`);
  },
});

/** Every "about you" capability, in the order a person meets them. */
export const PROFILE_CAPABILITIES: readonly ProfileDefinition[] = [
  PROFILE_SHOW, PROFILE_FIELD, PROFILE_PERSON, PROFILE_WHERE, PROFILE_STATUS, PROFILE_SET, PROFILE_NOTE, PROFILE_UNDO, PROFILE_FORGET, PROFILE_FORGET_LINE,
];

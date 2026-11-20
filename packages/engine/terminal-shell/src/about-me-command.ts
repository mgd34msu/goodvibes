/**
 * `/about-me`, described once (command-actions/) for both terminal apps: what
 * the platform knows about the person who owns it, kept as one hand-editable
 * Markdown file the daemon owns (docs/owner-profile.md), over the daemon's
 * `profile.*` methods. Read it, see where a fact came from, correct one, add a
 * line, put a value back, or forget one. Each app says how it reaches the
 * daemon and which surface it records a write as; the words are the same.
 *
 * Values reach exactly one place: the text a run returns. A write prints the
 * daemon's one-line disclosure, never the value just recorded (§8.2). The
 * People section is third-party personal data: when a model runs the read its
 * output lands where a later turn composes from, so People are counted and
 * "See what is known about a person" is the way through (§10).
 */
import type { OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, CommandDescription, InputDescription } from './command-actions/types.js';
import { listInput, readAction, textInput } from './described-command-kit.js';
import {
  isWithheldProfileSection,
  narrowProfileGet,
  narrowProfilePerson,
  narrowProfileProvenance,
  narrowProfileRead,
  narrowProfileStatus,
  narrowProfileWrite,
  PROFILE_RESPONSE_UNREADABLE,
  withholdPeople,
  type ProfileMethodId,
  type ProfileReadResponse,
} from './agent-turn/profile-types.js';

/** How one app reaches the daemon's `profile.*` methods. */
export interface AboutMeHost<Ctx> {
  /** The daemon's answer to one method, or a refusal saying why it could not be asked (never a profile value). */
  readonly call: <M extends ProfileMethodId>(ctx: Ctx, method: M, input: OperatorMethodInput<M>) => Promise<unknown>;
  /** The surface a write is recorded as (the provenance suffix names it). */
  readonly surface: string;
}

let installed: AboutMeHost<CommandActionContext> | undefined;
function hostOf(): AboutMeHost<CommandActionContext> {
  if (!installed) throw commandRefusal('Your profile is not available in this session.');
  return installed;
}

async function read(ctx: CommandActionContext): Promise<ProfileReadResponse> {
  const document = narrowProfileRead(await hostOf().call(ctx, 'profile.read', {}));
  if (!document) throw commandRefusal(PROFILE_RESPONSE_UNREADABLE);
  return document;
}

/** A field id as typed, or the one field whose label it is (a label that matches two is refused). */
async function fieldId(ctx: CommandActionContext, token: string): Promise<string> {
  if (token.includes('.')) return token;
  let document: ProfileReadResponse;
  try { document = await read(ctx); } catch { return token; }
  const wanted = token.trim().toLowerCase().replace(/\s+/g, ' ');
  const matches = [...new Set(document.sections.flatMap((section) => section.fields)
    .filter((field) => field.label.trim().toLowerCase().replace(/\s+/g, ' ') === wanted || field.fieldId.toLowerCase() === wanted)
    .map((field) => field.fieldId))];
  if (matches.length > 1) throw commandRefusal(`"${token}" names more than one field: ${matches.join(', ')}.`, 'Give the field id.');
  return matches[0] ?? token;
}

function provenance(value: { readonly surface: string; readonly date: string; readonly said: string } | null | undefined): string {
  return value ? `, from ${value.surface} on ${value.date}, you said: "${value.said}"` : '';
}

async function write(ctx: CommandActionContext, method: 'profile.set' | 'profile.append' | 'profile.forget' | 'profile.undo', input: OperatorMethodInput<'profile.set' | 'profile.append' | 'profile.forget' | 'profile.undo'>, target: string, done: string): Promise<string> {
  const response = narrowProfileWrite(await hostOf().call(ctx, method, input as never));
  if (!response) throw commandRefusal(PROFILE_RESPONSE_UNREADABLE);
  // A refusal, "there was nothing to forget", and a line whose text no longer
  // matches are all not done; the daemon's own reason says which.
  if (!response.ok) throw commandRefusal(`Not done: ${target}. ${response.reason ?? 'No reason was given.'}`);
  return response.disclosure || done;
}

const FIELDS = defineList<CommandActionContext>({
  name: 'about-me.fields',
  async read(ctx) {
    return (await read(ctx)).sections.flatMap((section) => section.heading.trim().toLowerCase() === 'people' ? [] : section.fields.map((field): ListRow => ({ value: field.fieldId, label: field.label, detail: section.heading })));
  },
  operator: { method: 'profile.read', input: {}, rows: { from: 'sections', each: 'fields', value: 'fieldId', label: 'label' } },
});
const SECTIONS = defineList<CommandActionContext>({
  name: 'about-me.sections',
  async read(ctx) {
    return (await read(ctx)).sections.map((section): ListRow => ({ value: section.heading, label: section.heading, state: `${section.prose.length} line${section.prose.length === 1 ? '' : 's'}` }));
  },
  operator: { method: 'profile.read', input: {}, rows: { from: 'sections', value: 'heading', label: 'heading' } },
});
const LINES = defineList<CommandActionContext>({
  name: 'about-me.lines',
  async read(ctx, earlier) {
    const section = (await read(ctx)).sections.find((entry) => entry.heading === earlier.section);
    return (section?.prose ?? []).map((line): ListRow => ({ value: line.text, label: line.text }));
  },
  operator: { method: 'profile.read', input: {}, rows: { from: 'sections', where: { field: 'heading', equals: '{section}' }, each: 'prose', value: 'text', label: 'text' } },
});

const FIELD: InputDescription = listInput({ id: 'field', label: 'Fact', help: 'The facts recorded about you', list: FIELDS, other: 'a field id such as commerce.shippingAddress' });
const OWNER_ONLY = {
  reason: 'it writes your profile as your own words, with your own credential',
  instead: 'Use the profile tool (set, append, undo or forget): it writes under the Agent\'s delegated authority and records where the fact came from.',
};
const PROFILE_METHOD = (method: string, fields: Readonly<Record<string, string>>) => ({ method, fields });

type AboutMeAction = ActionDescription<CommandActionContext>;
function change(fields: Pick<AboutMeAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run' | 'operator'> & Partial<Pick<AboutMeAction, 'risk' | 'undoneBy'>>): AboutMeAction {
  return { done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', ownerOnly: OWNER_ONLY, ...fields };
}

export const ABOUT_ME_COMMAND: CommandDescription<CommandActionContext> = {
  name: 'about-me',
  title: 'About you',
  summary: 'What the platform knows about you: read it, see where a fact came from, correct it, or forget it',
  group: 'You',
  report: 'show',
  firstScreenRows: [
    'show', 'set', 'note', 'where',
    { label: 'Look something up…', actions: ['field', 'person', 'status'] },
    { label: 'Put back or forget…', actions: ['undo', 'forget', 'forget-line'] },
  ],
  actions: [
    readAction<CommandActionContext>({
      id: 'show', label: 'See what is known about you', word: 'show',
      sentence: 'Shows your profile by section, each fact with where it came from.',
      operator: PROFILE_METHOD('profile.read', {}),
      async run(_values, ctx) {
        const document = await read(ctx);
        if (document.state.kind === 'unavailable') throw commandRefusal(`Your profile could not be read: ${document.state.reason ?? 'no reason given'} (${document.state.path}).`);
        if (document.state.kind === 'disabled') return `Your profile is turned off (${document.state.path}).`;
        const shown = ctx.invokedByModel === true ? withholdPeople(document) : document;
        const lines = [`About you (${shown.state.path})`];
        if (shown.state.exists === false) lines.push('  The file does not exist yet; nothing has been recorded.');
        for (const section of shown.sections) {
          lines.push(`  ## ${section.heading}`);
          if (isWithheldProfileSection(section)) {
            lines.push(`    ${section.count} ${section.count === 1 ? 'person' : 'people'} recorded; not listed here.`, '    /about-me person <name> shows one.');
            continue;
          }
          if (section.fields.length === 0 && section.prose.length === 0) { lines.push('    (nothing recorded)'); continue; }
          for (const field of section.fields) lines.push(`    ${field.label}: ${field.value}  [${field.fieldId}]${provenance(field.provenance)}${field.valid ? '' : `  (did not parse: ${field.invalidReason ?? 'no reason given'})`}`);
          for (const line of section.prose) lines.push(`    ${line.text}${provenance(line.provenance)}`);
        }
        return lines.join('\n');
      },
    }),
    readAction<CommandActionContext>({
      id: 'field', label: 'See one fact about you', word: 'field', inputs: [FIELD],
      sentence: 'Shows fact {field}, its value and where it came from.', example: { field: 'commerce.shippingAddress' },
      operator: PROFILE_METHOD('profile.get', { fieldId: 'field' }),
      async run(values, ctx) {
        const id = await fieldId(ctx, values.field!);
        const response = narrowProfileGet(await hostOf().call(ctx, 'profile.get', { fieldId: id }));
        if (!response) throw commandRefusal(PROFILE_RESPONSE_UNREADABLE);
        if (!response.present || !response.field) throw commandRefusal(`${response.fieldId} is not set in your profile.`);
        const field = response.field;
        return [
          `${field.label}: ${field.value}`,
          ...(field.valid ? [] : [`  did not parse: ${field.invalidReason ?? 'no reason given'}; kept as written, treated as unset`]),
          field.provenance ? `  ${provenance(field.provenance).slice(2)}` : '  no provenance recorded; you wrote or edited this line by hand.',
          // Present only for a closed-tier field: the daemon decides which reads need a receipt.
          ...(response.disclosure ? [response.disclosure] : []),
        ].join('\n');
      },
    }),
    readAction<CommandActionContext>({
      id: 'person', label: 'See what is known about a person', word: 'person',
      inputs: [textInput({ id: 'name', label: 'Person', help: 'Their name as you would say it', why: 'a name you know them by', typed: { tail: true } })],
      sentence: 'Shows what your profile records about {name}.', example: { name: 'Ada' },
      operator: PROFILE_METHOD('profile.person', { name: 'name' }),
      async run(values, ctx) {
        const response = narrowProfilePerson(await hostOf().call(ctx, 'profile.person', { name: values.name! }));
        if (!response) throw commandRefusal(PROFILE_RESPONSE_UNREADABLE);
        if (response.lines.length === 0) throw commandRefusal(`No one called ${response.name} is recorded in your profile.`);
        return [response.name, ...response.lines.map((line) => `  ${line.text}${provenance(line.provenance)}`), ...(response.disclosure ? [response.disclosure] : [])].join('\n');
      },
    }),
    readAction<CommandActionContext>({
      id: 'where', label: 'See where a fact came from', word: 'where', inputs: [FIELD],
      sentence: 'Shows where fact {field} came from: the surface, the date and your exact words, and the values it replaced.', example: { field: 'commerce.shippingAddress' },
      operator: PROFILE_METHOD('profile.provenance', { fieldId: 'field' }),
      async run(values, ctx) {
        const response = narrowProfileProvenance(await hostOf().call(ctx, 'profile.provenance', { fieldId: await fieldId(ctx, values.field!) }));
        if (!response) throw commandRefusal(PROFILE_RESPONSE_UNREADABLE);
        if (!response.present) throw commandRefusal(`${response.fieldId} is not in your profile; there is nothing to trace.`);
        return [
          response.fieldId,
          response.provenance ? `  ${provenance(response.provenance).slice(2)}` : response.handEdited ? '  no provenance recorded; you edited this line by hand.' : '  no provenance recorded.',
          ...response.superseded.map((record) => `  was: ${[record.value, record.provenance ? `via ${record.provenance.surface} on ${record.provenance.date}, you said: "${record.provenance.said}"` : '', `replaced ${record.supersededOn}`].filter(Boolean).join(', ')}`),
        ].join('\n');
      },
    }),
    readAction<CommandActionContext>({
      id: 'status', label: 'Check that your profile loads', word: 'status',
      sentence: 'Says whether your profile loaded, from where, and which facts did not parse.',
      operator: PROFILE_METHOD('profile.status', {}),
      async run(_values, ctx) {
        const response = narrowProfileStatus(await hostOf().call(ctx, 'profile.status', {}));
        if (!response) throw commandRefusal(PROFILE_RESPONSE_UNREADABLE);
        const invalid = response.invalidFields ?? [];
        return [
          `Your profile: ${response.kind}`,
          ...(response.reason ? [`  ${response.reason}`] : []),
          `  file ${response.path}`,
          ...(response.exists === false ? ['  the file does not exist yet'] : []),
          ...(response.sections && response.sections.length > 0 ? [`  sections ${response.sections.join(', ')}`] : []),
          ...(response.fieldCount !== undefined ? [`  facts ${response.fieldCount}`] : []),
          ...(response.proseLineCount !== undefined ? [`  lines ${response.proseLineCount}`] : []),
          ...(invalid.length === 0 ? ['  every fact parses'] : invalid.map((entry) => `  did not parse ${entry.fieldId}: ${entry.reason}`)),
        ].join('\n');
      },
    }),
    change({
      id: 'set', label: 'Record or correct a fact', word: 'set',
      inputs: [FIELD, textInput({ id: 'value', label: 'Value', help: 'What it is now', why: 'your own words for the fact', typed: { tail: true } })],
      sentence: 'Fact {field} is recorded as "{value}" in your own words, until you change it.', example: { field: 'commerce.shippingAddress', value: '1 Main St' },
      undoneBy: 'undo', operator: PROFILE_METHOD('profile.set', { fieldId: 'field', value: 'value' }),
      async run(values, ctx) {
        const id = await fieldId(ctx, values.field!);
        // `said` is the line as the owner typed it: the verbatim owner words layer 3 of the trust gate requires (§7).
        // `owner-direct` is claimed, not defaulted: the owner typed this at his own terminal.
        return write(ctx, 'profile.set', { fieldId: id, value: values.value!, surface: hostOf().surface, said: `/about-me set ${values.field} ${values.value}`, authority: 'owner-direct' }, `${id} was not recorded`, `Saved ${id} to your profile.`);
      },
    }),
    change({
      id: 'note', label: 'Add a line about you', word: 'note',
      inputs: [
        listInput({ id: 'section', label: 'Section', help: 'Where the line goes', list: SECTIONS, other: 'a section name', optional: { default: 'Notes', means: 'Notes' } }),
        textInput({ id: 'text', label: 'Line', help: 'The line, in your words', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
      ],
      sentence: 'The line "{text}" is added to your profile, until you change it.', example: { section: 'Work', text: 'I work from Vienna on Fridays' },
      undoneBy: 'forget-line', operator: PROFILE_METHOD('profile.append', { section: 'section', text: 'text' }),
      async run(values, ctx) {
        const section = values.section || 'Notes';
        return write(ctx, 'profile.append', { section, text: values.text!, surface: hostOf().surface, said: `/about-me note ${values.text}`, authority: 'owner-direct' }, `the line was not added to ${section}`, `Added a line to ${section} in your profile.`);
      },
    }),
    change({
      id: 'undo', label: 'Put back a fact\'s earlier value', word: 'undo', inputs: [FIELD],
      sentence: 'Fact {field} gets back the value it had before its last change, until you change it.', example: { field: 'commerce.shippingAddress' },
      operator: PROFILE_METHOD('profile.undo', { fieldId: 'field' }),
      async run(values, ctx) {
        const id = await fieldId(ctx, values.field!);
        return write(ctx, 'profile.undo', { fieldId: id, authority: 'owner-direct' }, `${id} was not put back`, `Put back the earlier ${id} in your profile.`);
      },
    }),
    change({
      id: 'forget', label: 'Forget a fact', word: 'forget', inputs: [FIELD],
      sentence: 'Fact {field} and every earlier value kept for it are deleted from your profile.', example: { field: 'commerce.shippingAddress' },
      risk: 'cannot-be-undone', operator: PROFILE_METHOD('profile.forget', { fieldId: 'field' }),
      async run(values, ctx) {
        const id = await fieldId(ctx, values.field!);
        return write(ctx, 'profile.forget', { fieldId: id, authority: 'owner-direct' }, `${id} was not deleted`, `Deleted ${id} from your profile.`);
      },
    }),
    change({
      id: 'forget-line', label: 'Forget a line', word: 'forget-line',
      inputs: [
        listInput({ id: 'section', label: 'Section', help: 'The section the line is in', list: SECTIONS, other: 'a section name', position: 1 }),
        // Named by its exact text, never by position: the owner edits this file himself, so a
        // position read earlier may address another line by the time the delete lands (§9.2).
        { id: 'line', label: 'Line', help: 'The line, exactly as shown', kind: 'choice', choices: { list: LINES, dependsOn: 'section', allowOther: { reason: 'the exact text of the line' } }, required: true, typed: { tail: true } },
      ],
      sentence: 'The line "{line}" is deleted from section {section} of your profile.', example: { section: 'Notes', line: 'Allergic to cats' },
      risk: 'cannot-be-undone', operator: PROFILE_METHOD('profile.forget', { section: 'section', text: 'line' }),
      async run(values, ctx) {
        return write(ctx, 'profile.forget', { section: values.section!, text: values.line!, authority: 'owner-direct' }, `the line "${values.line}" under ${values.section} was not deleted`, `Deleted the line from ${values.section}.`);
      },
    }),
  ],
};

const ABOUT_ME_SLASH_COMMAND = defineCommand(ABOUT_ME_COMMAND);

/** Register `/about-me` (the one description) with this app's way to the daemon. */
export function registerAboutMeCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: AboutMeHost<Ctx>): void {
  installed = host as unknown as AboutMeHost<CommandActionContext>;
  registry.register(ABOUT_ME_SLASH_COMMAND as never);
}

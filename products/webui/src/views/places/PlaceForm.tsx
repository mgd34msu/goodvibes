/**
 * PlaceForm: the form a place's action opens for the inputs the selected item
 * does not give, built from the capability's inputs with the same blanks as
 * the action sheets (choices as selects or radios, live choices read from
 * their source, a secret as a password field, long text as a text area). It
 * is titled with the action and names the place; the inputs the item gave are
 * shown by the item's title and never asked again. A secret value lives only
 * in this form's state while it is open: it is sent with the request and never
 * shown, kept or written anywhere in the browser.
 */
import { useMemo, useState } from 'react';
import { isShown, type ActionValues, type InputDescription } from '@goodvibes/engine/terminal-shell/command-actions/data';
import { Blank, initialValues, shownValues } from '../../components/command/ActionSheet';
import { Facts } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import type { InputData } from '../../lib/command-actions-types';
import { capabilityButton, capabilityRisk, capabilityRiskWords, capabilitySentence, displayValues, type PlaceCapability } from '../../lib/place-capabilities';

export interface PlaceFormRequest {
  readonly capability: PlaceCapability;
  /** The place's title: the form says where it was opened. */
  readonly place: string;
  /** The inputs the selected item (or the pressed answer) gave: shown, never asked. */
  readonly given: ActionValues;
  /** How the item's own values read (its id as its title). */
  readonly names: Readonly<Record<string, string>>;
}

const asInput = (input: InputData): InputDescription => input as unknown as InputDescription;

/**
 * An input the program asking supplies from its own context (`fromContext: 'program'`): a caller with no program, as
 * the browser is, names it from the two programs, with no default.
 */
const fromProgram = (input: InputData): boolean => (input as { readonly fromContext?: unknown }).fromContext === 'program';
const PROGRAMS = [{ value: 'tui', label: 'The terminal app' }, { value: 'agent', label: 'The Agent' }] as const;

export function PlaceForm({ request, onSubmit, onClose }: {
  readonly request: PlaceFormRequest;
  readonly onSubmit: (values: ActionValues, names: Readonly<Record<string, string>>) => void;
  readonly onClose: () => void;
}) {
  const { capability, given, names } = request;
  const action = capability.action;
  // A program-supplied input starts empty: the browser is neither program, so it is never guessed.
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(initialValues(action, given))
    .filter(([id]) => given[id] !== undefined || !action.inputs.some((input) => input.id === id && fromProgram(input)))));
  /** The names of things chosen from live lists, by value: the sentence says a schedule's name, not its id. */
  const [labels, setLabels] = useState<Record<string, string>>({});
  const asked = useMemo(() => action.inputs.filter((input) => given[input.id] === undefined
    && !('impliedBy' in input.typed && !Array.isArray(input.choices))
    && isShown(asInput(input), values)), [action, given, values]);
  const sent = useMemo(() => ({ ...shownValues(action, values), ...given }), [action, values, given]);
  const shownNames = useMemo(() => ({ ...names, ...labels }), [names, labels]);
  const missing = asked.filter((input) => (input.required === true || fromProgram(input)) && !values[input.id]);
  const risk = capabilityRisk(capability, sent);
  const givenFacts = action.inputs.flatMap((input) => (given[input.id] !== undefined
    ? [{ label: input.label, value: input.kind === 'secret' ? 'given, not shown' : (names[given[input.id]!] ?? given[input.id]!) }]
    : []));
  const set = (id: string) => (value: string) => setValues((now) => ({ ...now, [id]: value }));
  const labelFor = (id: string) => (label: string | undefined) => setLabels((now) => {
    const value = values[id];
    if (value === undefined || label === undefined || now[value] === label) return now;
    return { ...now, [value]: label };
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={action.label}
      description={risk !== 'none' ? `${request.place}. ${capabilityRiskWords(risk)}` : request.place}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={risk === 'cannot-be-undone' ? 'danger' : 'primary'}
            disabled={missing.length > 0}
            onClick={() => onSubmit(sent, shownNames)}
          >
            {capabilityButton(capability)}
          </Button>
        </>
      )}
    >
      <form
        className="gv-action-sheet place-form"
        data-capability={capability.id}
        onSubmit={(event) => { event.preventDefault(); if (missing.length === 0) onSubmit(sent, shownNames); }}
      >
        {givenFacts.length > 0 ? <Facts items={givenFacts} /> : null}
        <div className="gv-action-sheet__group">
          {asked.map((input) => (fromProgram(input) ? (
            // Supplied by the program asking; a browser is neither, so the person names the program, with no default.
            <Field key={input.id} label={input.label} help={input.help}>
              <Select aria-label={input.label} value={values[input.id] ?? ''} onChange={set(input.id)} placeholder="Choose the program" options={PROGRAMS} />
            </Field>
          ) : (
            <Blank key={input.id} action={action} input={input} values={values} onChange={set(input.id)} onLabel={labelFor(input.id)} />
          )))}
        </div>
        <div className="gv-action-sheet__outcome">
          <p className="gv-action-sheet__sentence">{capabilitySentence(capability, displayValues(capability, sent, shownNames))}</p>
        </div>
      </form>
    </Dialog>
  );
}

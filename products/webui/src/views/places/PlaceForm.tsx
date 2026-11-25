/**
 * PlaceForm: the form a place's action opens for the inputs the selected item
 * does not give, built from the capability's inputs with the same blanks as
 * the action sheets (choices as selects or radios, live choices read from the
 * method the daemon names for their list, a secret as a password field, long
 * text as a text area), grouped by the same steps (a long step of usual
 * settings folded under "More settings"). It is titled with the action and
 * names the place; the inputs the item gave are shown by the item's title and
 * never asked again. An input supplied from context (the program asking) is
 * the person's to name here, with no default. A secret value lives only in this
 * form's state while it is open: it is sent with the request and never shown,
 * kept or written anywhere in the browser.
 */
import { useMemo, useState } from 'react';
import { type ActionValues } from '@goodvibes/engine/terminal-shell/command-actions/data';
import { Blank, initialValues, shownValues, stepGroups } from '../../components/command/ActionSheet';
import { Facts } from '../../components/data-view/DataView';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import type { InputData } from '../../lib/command-actions-types';
import {
  capabilityButton, capabilityRisk, capabilityRiskWords, capabilitySentence, displayValues, namedByCaller, shownInBrowser, type PlaceCapability,
} from '../../lib/place-capabilities';

export interface PlaceFormRequest {
  readonly capability: PlaceCapability;
  /** The place's title: the form says where it was opened. */
  readonly place: string;
  /** The inputs the selected item (or the pressed answer) gave: shown, never asked. */
  readonly given: ActionValues;
  /** How the item's own values read (its id as its title). */
  readonly names: Readonly<Record<string, string>>;
}

export function PlaceForm({ request, onSubmit, onClose }: {
  readonly request: PlaceFormRequest;
  readonly onSubmit: (values: ActionValues, names: Readonly<Record<string, string>>) => void;
  readonly onClose: () => void;
}) {
  const { capability, given, names } = request;
  const action = capability.action;
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(action, given));
  /** The names of things chosen from live lists, by value: the sentence says a schedule's name, not its id. */
  const [labels, setLabels] = useState<Record<string, string>>({});
  const asked = useMemo(() => action.inputs.filter((input) => given[input.id] === undefined
    && !('impliedBy' in input.typed && !Array.isArray(input.choices))
    && shownInBrowser(input, values)), [action, given, values]);
  const sent = useMemo(() => ({ ...shownValues(action, values), ...given }), [action, values, given]);
  const shownNames = useMemo(() => ({ ...names, ...labels }), [names, labels]);
  const missing = asked.filter((input) => (input.required === true || namedByCaller(input)) && !values[input.id]);
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
  const blank = (input: InputData) => <Blank key={input.id} action={action} input={input} values={values} onChange={set(input.id)} onLabel={labelFor(input.id)} />;
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
        {stepGroups(action, asked).map((group) => (group.folded ? (
          <details key={group.key} className="gv-action-sheet__more">
            <summary>More settings{group.title ? <span className="gv-action-sheet__hint-inline"> · {group.title}</span> : null}</summary>
            <div className="gv-action-sheet__group">{group.inputs.map(blank)}</div>
          </details>
        ) : (
          <div key={group.key} className="gv-action-sheet__group">
            {group.title ? <p className="gv-action-sheet__step">{group.title}</p> : null}
            {group.inputs.map(blank)}
          </div>
        )))}
        <div className="gv-action-sheet__outcome">
          <p className="gv-action-sheet__sentence">{capabilitySentence(capability, displayValues(capability, sent, shownNames))}</p>
        </div>
      </form>
    </Dialog>
  );
}

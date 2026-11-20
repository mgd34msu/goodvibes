/**
 * ActionSheet: one action of a slash command, drawn from its description
 * (lib/generated/command-actions.ts): the same blanks as pick-lists, switches
 * and fields, grouped by the terminal's steps (a long step of usual settings
 * folded under "More settings"), a blank shown only while the choice it
 * belongs to is made, the same sentence above the button, and after it runs
 * the same "what happened" line with the terminal line under it. A choice the
 * browser cannot make (a rule that lasts one terminal session) is shown greyed
 * with the reason.
 *
 * An action whose description names a `preview` method (a schedule described
 * in words, a trigger's definition) is read by the daemon first: the sheet
 * shows what will be kept, and the button keeps exactly that. The owner's
 * press is sent with the explicit-user-request claim (lib/goodvibes.ts
 * invokeOwnerMethod), which the payment and grant handlers require. No action
 * text is written here.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  actionButton,
  actionDoneLine,
  actionSentence,
  effectiveRisk,
  isShown,
  listOperatorInput,
  operatorInputFromValues,
  renderTypedLine,
  riskWords,
  rowsFromOutput,
  withoutSecrets,
  type InputDescription,
} from '@goodvibes-jev/engine/terminal-shell/command-actions/data';
import { COMMAND_ACTIONS } from '../../lib/generated/command-actions';
import { asActionShape, asCommandShape, type ActionData, type CommandActionsData, type InputData } from '../../lib/command-actions-types';
import { invokeMethod, invokeOwnerMethod } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { DateField } from '../ui/DateField';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Textarea } from '../ui/Field';
import { Radio } from '../ui/Radio';
import { Select } from '../ui/Select';

/** The command and action a sheet draws, from the generated data; undefined for a name it does not hold. */
export function findCommandAction(command: string, actionId: string): { readonly command: CommandActionsData; readonly action: ActionData } | undefined {
  const described = COMMAND_ACTIONS.commands.find((entry) => entry.name === command);
  const action = described?.actions.find((entry) => entry.id === actionId);
  return described && action ? { command: described, action } : undefined;
}

/** The actions of a command the browser cannot run, with the reason in a sentence (shown greyed under a screen). */
export function terminalOnlyActions(command: string): readonly { readonly label: string; readonly reason: string }[] {
  const described = COMMAND_ACTIONS.commands.find((entry) => entry.name === command);
  return (described?.actions ?? []).flatMap((action) => ('terminalOnly' in action.operator ? [{ label: action.label, reason: action.operator.terminalOnly }] : []));
}

/** Call a read the generated data names (a list's source, a preview): the contract check holds every name to a real method. */
function invokeNamed(method: string, input: Record<string, unknown>): Promise<unknown> {
  // The method id comes from the generated data, not a literal, so it is passed through the typed signature as itself.
  return invokeMethod(method as Parameters<typeof invokeMethod>[0], input as never) as Promise<unknown>;
}

/** The engine's shape of a blank; a list's name is plain text in the generated data, and nothing here reads its brand. */
function asInput(input: InputData): InputDescription {
  return input as unknown as InputDescription;
}

/** A choice the browser cannot make: one that lasts only one terminal session. */
function sessionOnly(action: ActionData, input: InputData, value: string): string | undefined {
  if (typeof action.lasts !== 'object' || action.lasts.byInput !== input.id || !Array.isArray(input.choices)) return undefined;
  const choice = input.choices.find((entry) => entry.value === value);
  return choice?.lasts === 'session' ? 'Done from the terminal app whose session it is.' : undefined;
}

function initialValues(action: ActionData, prefill: Readonly<Record<string, string>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of action.inputs) {
    if (prefill[input.id] !== undefined) { values[input.id] = prefill[input.id]!; continue; }
    if (input.required === true) continue;
    const usual = input.required.default;
    // The usual choice when the browser can make it; else the first one it can.
    if (sessionOnly(action, input, usual) && Array.isArray(input.choices)) {
      values[input.id] = input.choices.find((choice) => !sessionOnly(action, input, choice.value))?.value ?? usual;
    } else values[input.id] = usual;
  }
  return values;
}

/** The values of the blanks shown now: one hidden by an earlier choice is not sent, whatever it held. */
function shownValues(action: ActionData, values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of action.inputs) {
    if (!isShown(asInput(input), values)) continue;
    const value = values[input.id];
    if (value !== undefined && value !== '') out[input.id] = value;
  }
  return out;
}

/** The local `YYYY-MM-DDTHH:MM` a date field shows for a kept ISO time ('' for none or text it cannot read). */
function localDateTime(iso: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function ListBlank({ input, values, onChange, placeholder }: { readonly input: InputData; readonly values: Readonly<Record<string, string>>; readonly onChange: (value: string) => void; readonly placeholder?: string | undefined }) {
  const list = !Array.isArray(input.choices) && input.choices ? input.choices : undefined;
  const operator = list ? COMMAND_ACTIONS.lists[list.list] : undefined;
  const earlier = list?.dependsOn ? { [list.dependsOn]: values[list.dependsOn] ?? '' } : {};
  const ready = list?.dependsOn ? Boolean(values[list.dependsOn]) : true;
  const rows = useQuery({
    queryKey: ['command-actions', 'list', list?.list ?? '', JSON.stringify(earlier)],
    enabled: ready && operator !== undefined && 'method' in operator,
    queryFn: async () => {
      if (!operator || !('method' in operator)) return [];
      return rowsFromOutput(operator.rows, await invokeNamed(operator.method, listOperatorInput(operator.input, earlier)), earlier);
    },
  });
  const value = values[input.id] ?? '';
  if (!operator || !('method' in operator) || (list?.allowOther && (rows.data?.length ?? 0) === 0)) {
    return <Input aria-label={input.label} value={value} placeholder={placeholder ?? list?.allowOther?.reason ?? input.help} onChange={(event) => onChange(event.target.value)} />;
  }
  return (
    <Select
      aria-label={input.label}
      value={value}
      onChange={onChange}
      placeholder={rows.isLoading ? 'Reading…' : !ready ? 'Choose the earlier blank first' : rows.isError ? 'Could not read the list' : (rows.data?.length ?? 0) === 0 ? 'None yet' : input.help}
      options={(rows.data ?? []).map((row) => ({ value: row.value, label: row.state ? `${row.label} (${row.state})` : row.label }))}
    />
  );
}

function Blank({ action, input, values, onChange, current }: {
  readonly action: ActionData; readonly input: InputData; readonly values: Readonly<Record<string, string>>;
  readonly onChange: (value: string) => void; readonly current?: string | undefined;
}) {
  const value = values[input.id] ?? '';
  const help = input.required === true ? input.help : `${input.help}. Usual: ${input.required.defaultMeans}.`;
  const placeholder = current ? `Now: ${current}` : undefined;
  if (Array.isArray(input.choices)) {
    const choices = input.choices;
    if (choices.length <= 4) {
      return (
        <fieldset className="gv-action-sheet__choices">
          <legend>{input.label}</legend>
          {choices.map((choice) => {
            const why = sessionOnly(action, input, choice.value);
            return (
              <div key={choice.value} className="gv-action-sheet__choice">
                <Radio name={`${action.id}-${input.id}`} checked={value === choice.value} disabled={why !== undefined} onChange={() => onChange(choice.value)}>
                  {choice.label}{choice.risk && choice.risk !== 'none' ? ` (${riskWords(choice.risk)})` : ''}
                </Radio>
                {why || choice.help ? <p className="gv-action-sheet__hint">{why ?? choice.help}</p> : null}
              </div>
            );
          })}
        </fieldset>
      );
    }
    const usual = input.required !== true && input.required.default === '' ? [{ value: '', label: input.required.defaultMeans }] : [];
    return (
      <Field label={input.label} help={help}>
        <Select aria-label={input.label} value={value} onChange={onChange} options={[...usual, ...choices.map((choice) => ({ value: choice.value, label: choice.label }))]} />
      </Field>
    );
  }
  if (input.choices) {
    return (
      <Field label={input.label} help={help}>
        <ListBlank input={input} values={values} onChange={onChange} placeholder={placeholder} />
      </Field>
    );
  }
  if (input.kind === 'date-time') {
    return (
      <Field label={input.label} help={help}>
        <DateField
          time
          aria-label={input.label}
          value={localDateTime(value)}
          onChange={(local) => {
            const at = local ? new Date(local) : null;
            onChange(at && !Number.isNaN(at.getTime()) ? at.toISOString() : '');
          }}
        />
      </Field>
    );
  }
  const repeats = 'flag' in input.typed && input.typed.repeats === true;
  if (repeats || input.kind === 'list' || input.kind === 'long-text') {
    return (
      <Field label={input.label} help={repeats || input.kind === 'list' ? `${help} One per line.` : help}>
        <Textarea
          aria-label={input.label}
          className={input.kind === 'secret' ? 'gv-action-sheet__secret' : undefined}
          value={value}
          rows={input.kind === 'long-text' ? 3 : 2}
          placeholder={placeholder ?? input.freeTextReason ?? input.help}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    );
  }
  return (
    <Field label={input.label} help={help}>
      <Input
        aria-label={input.label}
        type={input.kind === 'secret' ? 'password' : 'text'}
        inputMode={input.kind === 'number' || input.kind === 'money' ? 'decimal' : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder ?? input.freeTextReason ?? input.help}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** The blanks by step: a step whose blanks all have a usual value and that holds four or more is folded. */
function stepGroups(action: ActionData, shown: readonly InputData[]): readonly { readonly key: string; readonly title?: string | undefined; readonly folded: boolean; readonly inputs: readonly InputData[] }[] {
  const steps = [...new Set(shown.map((input) => input.step ?? 0))].sort((a, b) => a - b);
  const titled = steps.filter((step) => step > 0).length > 1;
  return steps.map((step) => {
    const inputs = shown.filter((input) => (input.step ?? 0) === step);
    return {
      key: String(step),
      title: titled && step > 0 ? action.stepTitles?.[step - 1] : undefined,
      folded: inputs.length >= 4 && inputs.every((input) => input.required !== true),
      inputs,
    };
  });
}

interface Preview { readonly key: string; readonly summary: string; readonly input: Readonly<Record<string, unknown>> }

function readPreview(output: unknown): { summary: string; input: Readonly<Record<string, unknown>> } {
  const record = output && typeof output === 'object' && !Array.isArray(output) ? output as Record<string, unknown> : {};
  const input = record.input && typeof record.input === 'object' && !Array.isArray(record.input) ? record.input as Record<string, unknown> : null;
  if (typeof record.summary !== 'string' || !input) throw new Error('The daemon did not say what it would keep. Nothing was kept.');
  return { summary: record.summary, input };
}

export interface ActionSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly command: string;
  readonly action: string;
  /** Blanks the row already knows (its server, its tool). */
  readonly prefill?: Readonly<Record<string, string>>;
  /** What the thing holds now, by blank id, shown in a blank left empty ("Now: …"): an editor's current values. */
  readonly current?: Readonly<Record<string, string>>;
  /** Called after the action ran, so the screen that opened the sheet reads again. */
  readonly onDone?: () => void;
}

export function ActionSheet({ open, onClose, command, action: actionId, prefill = {}, current = {}, onDone }: ActionSheetProps) {
  const found = findCommandAction(command, actionId);
  const { toast } = useToast();
  const [values, setValues] = useState<Record<string, string>>(() => (found ? initialValues(found.action, prefill) : {}));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const operator = found && 'method' in found.action.operator ? found.action.operator : undefined;
  const sent = useMemo(() => (found ? shownValues(found.action, values) : {}), [found, values]);
  const key = JSON.stringify(sent);
  const fresh = preview !== null && preview.key === key;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const check = useMutation({
    mutationFn: async () => {
      if (!operator?.preview) throw new Error('This action is not read first.');
      return { key, ...readPreview(await invokeNamed(operator.preview, { ...operatorInputFromValues(operator.fields, sent), zone })) };
    },
    onMutate: () => setProblem(null),
    onSuccess: (read) => setPreview(read),
    onError: (error: unknown) => { setPreview(null); setProblem(formatError(error)); },
  });
  const run = useMutation({
    mutationFn: async () => {
      if (!operator) throw new Error('This action is done from a terminal app.');
      if (operator.preview && !fresh) throw new Error('Check it again: what you gave changed since it was read.');
      return invokeOwnerMethod(operator.method, operator.preview && preview ? preview.input : operatorInputFromValues(operator.fields, sent));
    },
    onMutate: () => setProblem(null),
    onSuccess: () => {
      if (!found) return;
      const shape = asActionShape(found.action);
      toast({
        title: actionDoneLine(shape, sent) || found.action.label,
        description: `From a terminal: ${renderTypedLine(asCommandShape(found.command), found.action.id, withoutSecrets(shape, sent))}`,
        tone: 'success',
      });
      onDone?.();
      onClose();
    },
    onError: (error: unknown) => setProblem(`${found?.action.label ?? 'Action'}: not done. ${formatError(error)}`),
  });
  const shown = useMemo(() => (found ? found.action.inputs.filter((input) => isShown(asInput(input), values)) : []), [found, values]);
  const missing = shown.filter((input) => input.required === true && !values[input.id]);
  if (!found) return null;
  const shape = asActionShape(found.action);
  const terminalOnly = 'terminalOnly' in found.action.operator ? found.action.operator.terminalOnly : undefined;
  const blocked = shown.map((input) => sessionOnly(found.action, input, values[input.id] ?? '')).find(Boolean);
  const risk = effectiveRisk(shape, sent);
  const needsCheck = operator?.preview !== undefined && !fresh;
  const disabled = terminalOnly !== undefined || blocked !== undefined || missing.length > 0 || run.isPending || check.isPending;
  const set = (id: string) => (value: string) => setValues((now) => ({ ...now, [id]: value }));
  const blank = (input: InputData) => <Blank key={input.id} action={found.action} input={input} values={values} onChange={set(input.id)} current={current[input.id]} />;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={found.action.label}
      description={risk !== 'none' ? riskWords(risk) : undefined}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          {needsCheck ? (
            <Button variant="primary" disabled={disabled} onClick={() => check.mutate()}>{check.isPending ? 'Reading…' : 'Check'}</Button>
          ) : (
            <Button variant={risk === 'cannot-be-undone' ? 'danger' : 'primary'} disabled={disabled} onClick={() => run.mutate()}>
              {actionButton(shape)}
            </Button>
          )}
        </>
      )}
    >
      <div className="gv-action-sheet" data-command={found.command.name} data-action={found.action.id}>
        {stepGroups(found.action, shown).map((group) => (group.folded ? (
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
        <p className="gv-action-sheet__sentence">{actionSentence(shape, sent)}</p>
        {fresh && preview ? <p className="gv-action-sheet__preview" role="status">{preview.summary}</p> : null}
        {problem ? <p className="gv-action-sheet__problem" role="alert">{problem}</p> : null}
        {terminalOnly ? <p className="gv-action-sheet__hint">{terminalOnly}</p> : null}
        <p className="gv-action-sheet__line">From a terminal: <code>{renderTypedLine(asCommandShape(found.command), found.action.id, withoutSecrets(shape, sent))}</code></p>
      </div>
    </Dialog>
  );
}

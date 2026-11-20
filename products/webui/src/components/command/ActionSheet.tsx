/**
 * ActionSheet: one action of a slash command, drawn from its description
 * (lib/generated/command-actions.ts): the same blanks as pick-lists, switches
 * and fields, the same sentence above the button, and after it runs the same
 * "what happened" line with the terminal line under it. A choice the browser
 * cannot make (a rule that lasts one terminal session) is shown greyed with
 * the reason. No action text is written here.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  actionButton,
  actionDoneLine,
  actionSentence,
  effectiveRisk,
  listOperatorInput,
  operatorInputFromValues,
  renderTypedLine,
  riskWords,
  rowsFromOutput,
} from '@goodvibes-jev/engine/terminal-shell/command-actions/data';
import { COMMAND_ACTIONS } from '../../lib/generated/command-actions';
import { asActionShape, asCommandShape, type ActionData, type CommandActionsData, type InputData } from '../../lib/command-actions-types';
import { invokeMethod } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
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

/** Call an operator method the generated data names (the contract check holds every name to a real method). */
function invokeNamed(method: string, input: Record<string, unknown>): Promise<unknown> {
  // The method id comes from the generated data, not a literal, so it is passed through the typed signature as itself.
  return invokeMethod(method as Parameters<typeof invokeMethod>[0], input as never) as Promise<unknown>;
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

function ListBlank({ input, values, onChange }: { readonly input: InputData; readonly values: Readonly<Record<string, string>>; readonly onChange: (value: string) => void }) {
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
    return <Input value={value} placeholder={list?.allowOther?.reason ?? input.help} onChange={(event) => onChange(event.target.value)} />;
  }
  return (
    <Select
      value={value}
      onChange={onChange}
      placeholder={rows.isLoading ? 'Reading…' : !ready ? 'Choose the earlier blank first' : input.help}
      options={(rows.data ?? []).map((row) => ({ value: row.value, label: row.state ? `${row.label} (${row.state})` : row.label }))}
    />
  );
}

function Blank({ action, input, values, onChange }: { readonly action: ActionData; readonly input: InputData; readonly values: Readonly<Record<string, string>>; readonly onChange: (value: string) => void }) {
  const value = values[input.id] ?? '';
  const help = input.required === true ? input.help : `${input.help}. Usual: ${input.required.defaultMeans}.`;
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
    return (
      <Field label={input.label} help={help}>
        <Select value={value} onChange={onChange} options={choices.map((choice) => ({ value: choice.value, label: choice.label }))} />
      </Field>
    );
  }
  if (input.choices) {
    return (
      <Field label={input.label} help={help}>
        <ListBlank input={input} values={values} onChange={onChange} />
      </Field>
    );
  }
  const repeats = 'flag' in input.typed && input.typed.repeats === true;
  if (repeats || input.kind === 'list' || input.kind === 'long-text') {
    return (
      <Field label={input.label} help={repeats || input.kind === 'list' ? `${help} One per line.` : help}>
        <Textarea value={value} placeholder={input.freeTextReason ?? input.help} onChange={(event) => onChange(event.target.value)} />
      </Field>
    );
  }
  return (
    <Field label={input.label} help={help}>
      <Input type={input.kind === 'secret' ? 'password' : 'text'} autoComplete="off" value={value} placeholder={input.freeTextReason ?? input.help} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

export interface ActionSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly command: string;
  readonly action: string;
  /** Blanks the row already knows (its server, its tool). */
  readonly prefill?: Readonly<Record<string, string>>;
  /** Called after the action ran, so the screen that opened the sheet reads again. */
  readonly onDone?: () => void;
}

export function ActionSheet({ open, onClose, command, action: actionId, prefill = {}, onDone }: ActionSheetProps) {
  const found = findCommandAction(command, actionId);
  const { toast } = useToast();
  const [values, setValues] = useState<Record<string, string>>(() => (found ? initialValues(found.action, prefill) : {}));
  const run = useMutation({
    mutationFn: async () => {
      if (!found || !('method' in found.action.operator)) throw new Error('This action is done from a terminal app.');
      return invokeNamed(found.action.operator.method, operatorInputFromValues(found.action.operator.fields, values));
    },
    onSuccess: () => {
      if (!found) return;
      const shape = asActionShape(found.action);
      toast({
        title: actionDoneLine(shape, values) || found.action.label,
        description: `From a terminal: ${renderTypedLine(asCommandShape(found.command), found.action.id, values)}`,
        tone: 'success',
      });
      onDone?.();
      onClose();
    },
    onError: (error: unknown) => toast({ title: `${found?.action.label ?? 'Action'}: not done`, description: formatError(error), tone: 'danger' }),
  });
  const missing = useMemo(() => (found?.action.inputs ?? []).filter((input) => input.required === true && !values[input.id]), [found, values]);
  if (!found) return null;
  const shape = asActionShape(found.action);
  const terminalOnly = 'terminalOnly' in found.action.operator ? found.action.operator.terminalOnly : undefined;
  const blocked = found.action.inputs.map((input) => sessionOnly(found.action, input, values[input.id] ?? '')).find(Boolean);
  const risk = effectiveRisk(shape, values);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={found.action.label}
      description={risk !== 'none' ? riskWords(risk) : undefined}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={risk === 'none' ? 'primary' : 'danger'}
            disabled={terminalOnly !== undefined || blocked !== undefined || missing.length > 0 || run.isPending}
            onClick={() => run.mutate()}
          >
            {actionButton(shape)}
          </Button>
        </>
      )}
    >
      <div className="gv-action-sheet">
        {found.action.inputs.map((input) => (
          <Blank key={input.id} action={found.action} input={input} values={values} onChange={(value) => setValues((current) => ({ ...current, [input.id]: value }))} />
        ))}
        <p className="gv-action-sheet__sentence">{actionSentence(shape, values)}</p>
        {terminalOnly ? <p className="gv-action-sheet__hint">{terminalOnly}</p> : null}
        <p className="gv-action-sheet__line">From a terminal: <code>{renderTypedLine(asCommandShape(found.command), found.action.id, values)}</code></p>
      </div>
    </Dialog>
  );
}

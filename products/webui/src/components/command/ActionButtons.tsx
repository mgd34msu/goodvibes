/**
 * ActionButtons: the buttons a row carries for the thing it shows (a server,
 * a tool), named as the terminal names them. Each opens the action's sheet
 * with what the row already knows filled in. An action only a terminal can do
 * is shown disabled with its reason as the button's title.
 */
import { useState } from 'react';
import { riskWords } from '@goodvibes-jev/engine/terminal-shell/command-actions/data';
import { Button } from '../ui/Button';
import { ActionSheet, findCommandAction } from './ActionSheet';

export interface ActionButtonsProps {
  readonly command: string;
  /** The action ids this row offers, in order. */
  readonly actions: readonly string[];
  /** What the row knows (its server, its tool), by blank id. */
  readonly prefill?: Readonly<Record<string, string>>;
  /** What the thing holds now, by blank id (an editor's current values), shown in blanks left empty. */
  readonly current?: Readonly<Record<string, string>>;
  readonly onDone?: () => void;
  /** Words for a button other than the action's label ("Change…" on a row that already names the schedule). */
  readonly labels?: Readonly<Record<string, string>>;
}

export function ActionButtons({ command, actions, prefill = {}, current, onDone, labels = {} }: ActionButtonsProps) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <span className="gv-action-buttons">
      {actions.map((id) => {
        const found = findCommandAction(command, id);
        if (!found) return null;
        const terminalOnly = 'terminalOnly' in found.action.operator ? found.action.operator.terminalOnly : undefined;
        return (
          <Button
            key={id}
            size="sm"
            // Red only for what cannot be undone; other risks say their words in the title and the sheet.
            variant={found.action.risk === 'cannot-be-undone' ? 'quiet-danger' : 'secondary'}
            disabled={terminalOnly !== undefined}
            title={terminalOnly ?? (found.action.riskWords ? `${found.action.label} (${riskWords(found.action.risk)})` : found.action.label)}
            onClick={() => setOpen(id)}
          >
            {labels[id] ?? (found.action.inputs.some((input) => input.required === true && prefill[input.id] === undefined) ? `${found.action.label}…` : found.action.label)}
          </Button>
        );
      })}
      {open ? (
        <ActionSheet key={open} open command={command} action={open} prefill={prefill} {...(current ? { current } : {})} onClose={() => setOpen(null)} {...(onDone ? { onDone } : {})} />
      ) : null}
    </span>
  );
}

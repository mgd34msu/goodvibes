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
  readonly onDone?: () => void;
}

export function ActionButtons({ command, actions, prefill = {}, onDone }: ActionButtonsProps) {
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
            variant={found.action.risk === 'none' ? 'secondary' : 'quiet-danger'}
            disabled={terminalOnly !== undefined}
            title={terminalOnly ?? (found.action.riskWords ? `${found.action.label} (${riskWords(found.action.risk)})` : found.action.label)}
            onClick={() => setOpen(id)}
          >
            {found.action.inputs.some((input) => prefill[input.id] === undefined) ? `${found.action.label}…` : found.action.label}
          </Button>
        );
      })}
      {open ? (
        <ActionSheet key={open} open command={command} action={open} prefill={prefill} onClose={() => setOpen(null)} {...(onDone ? { onDone } : {})} />
      ) : null}
    </span>
  );
}

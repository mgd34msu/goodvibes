/**
 * ActionButtons: the buttons a row carries for the thing it shows (a server,
 * a tool, a schedule), named as the terminal names them. Each opens the
 * action's sheet with what the row already knows filled in. Actions that are
 * rarely wanted sit in the row's "More" menu, each with its risk words. An
 * action only a terminal can do is not drawn.
 */
import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { actionButton, riskWords } from '@goodvibes/engine/terminal-shell/command-actions/data';
import { asActionShape, type ActionData } from '../../lib/command-actions-types';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Menu, MenuItem } from '../ui/Menu';
import { ActionSheet, findCommandAction } from './ActionSheet';
import { useCapabilityIndex } from '../../lib/place-capabilities';

export interface ActionButtonsProps {
  readonly command: string;
  /** The action ids this row offers as buttons, in order. */
  readonly actions: readonly string[];
  /** The action ids in the row's "More" menu, in order. */
  readonly menu?: readonly string[];
  /** The accessible name of the "More" menu (it names the row's thing). */
  readonly menuLabel?: string;
  /** What the row knows (its server, its tool), by blank id. */
  readonly prefill?: Readonly<Record<string, string>>;
  /** What the thing holds now, by blank id (an editor's current values), shown in blanks left empty. */
  readonly current?: Readonly<Record<string, string>>;
  /** Buttons say the action's verb ("Pause") rather than its label: the row already names the thing. */
  readonly short?: boolean;
  /** The first button is the screen's main action. */
  readonly primary?: boolean;
  readonly onDone?: () => void;
}

function terminalOnly(action: ActionData): string | undefined {
  return 'terminalOnly' in action.operator ? action.operator.terminalOnly : undefined;
}

export function ActionButtons({ command, actions, menu = [], menuLabel, prefill = {}, current, short = false, primary = false, onDone }: ActionButtonsProps) {
  const [open, setOpen] = useState<string | null>(null);
  // What each action is and where it runs is read from the daemon (lib/place-capabilities.ts); the row draws again then.
  useCapabilityIndex();
  const needsMore = (action: ActionData) => action.inputs.some((input) => input.required === true && prefill[input.id] === undefined);
  const inMenu = menu.flatMap((id) => findCommandAction(command, id)?.action ?? []).filter((action) => terminalOnly(action) === undefined);
  return (
    <span className="gv-action-buttons">
      {actions.map((id, index) => {
        const found = findCommandAction(command, id);
        // An act only a terminal program can do is not drawn: the web draws no control that cannot be used here.
        if (!found || terminalOnly(found.action) !== undefined) return null;
        const words = short && !needsMore(found.action) ? actionButton(asActionShape(found.action)) : `${found.action.label}${needsMore(found.action) ? '…' : ''}`;
        return (
          <Button
            key={id}
            size="sm"
            // Red only for what cannot be undone; other risks say their words in the title and the sheet.
            variant={found.action.risk === 'cannot-be-undone' ? 'quiet-danger' : primary && index === 0 ? 'primary' : 'secondary'}
            title={found.action.riskWords ? `${found.action.label} (${riskWords(found.action.risk)})` : found.action.label}
            data-action={id}
            onClick={() => setOpen(id)}
          >
            {words}
          </Button>
        );
      })}
      {inMenu.length > 0 ? (
        <Menu
          label={menuLabel ?? 'More'}
          placement="bottom-end"
          trigger={(props) => <IconButton {...props} size="sm" label={menuLabel ?? 'More'} icon={<MoreHorizontal />} />}
        >
          {inMenu.map((action) => (
            <MenuItem key={action.id} danger={action.risk === 'cannot-be-undone'} onSelect={() => setOpen(action.id)}>
              {action.label}{needsMore(action) ? '…' : ''}{action.riskWords ? ` (${action.riskWords})` : ''}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
      {open ? (
        <ActionSheet key={open} open command={command} action={open} prefill={prefill} {...(current ? { current } : {})} onClose={() => setOpen(null)} {...(onDone ? { onDone } : {})} />
      ) : null}
    </span>
  );
}

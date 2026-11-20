/**
 * The frame of a screen drawn from one slash command's description: its title
 * and summary, the main action, the rows the screen shows, and under them,
 * greyed, the command's actions only a terminal app can do, each with the
 * reason in a sentence. A screen reads its rows with `useCommandRead` and
 * reads again after any of its sheets ran.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { COMMAND_ACTIONS } from '../../../lib/generated/command-actions';
import { invokeMethod } from '../../../lib/goodvibes';
import { formatError } from '../../../lib/errors';
import { Button } from '../../ui/Button';
import { terminalOnlyActions } from '../ActionSheet';

/** False inside a panel whose own header already names the screen. */
export const CommandScreenTitleShown = createContext(true);

/** The query key prefix of every screen's reads: a sheet that ran reads them all again. */
export const COMMAND_SCREEN_KEY = ['command-screen'] as const;

/** One read a screen shows (a list's operator method). */
export function useCommandRead(name: string, method: string, input: Record<string, unknown> = {}) {
  return useQuery({
    queryKey: [...COMMAND_SCREEN_KEY, name],
    // The method id is one the command's description names; the contract check holds it to a real method.
    queryFn: () => invokeMethod(method as Parameters<typeof invokeMethod>[0], input as never) as Promise<unknown>,
  });
}

/** Read every screen and every sheet's live lists again (after an action ran). */
export function useRefreshCommandScreens(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: COMMAND_SCREEN_KEY });
    void queryClient.invalidateQueries({ queryKey: ['command-actions'] });
  };
}

export function CommandScreen({ command, title, summary, actions, testId, children }: {
  readonly command: string;
  /** A heading other than the command's title (a screen that shows part of a command). */
  readonly title?: string;
  readonly summary?: string;
  /** The screen's main action, right of the title. */
  readonly actions?: ReactNode;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  const described = COMMAND_ACTIONS.commands.find((entry) => entry.name === command);
  const terminal = terminalOnlyActions(command);
  const titled = useContext(CommandScreenTitleShown);
  return (
    <section className="gv-command-screen" data-testid={testId} aria-label={title ?? described?.title ?? command}>
      <header className="gv-command-screen__head">
        <div className="gv-command-screen__titles">
          {titled ? <h3 className="gv-command-screen__title">{title ?? described?.title ?? command}</h3> : null}
          <p className="gv-command-screen__summary">{summary ?? described?.summary}</p>
        </div>
        {actions ? <div className="gv-command-screen__actions">{actions}</div> : null}
      </header>
      {children}
      {terminal.length > 0 ? (
        <details className="gv-command-screen__terminal">
          <summary>Done from a terminal app ({terminal.length})</summary>
          <ul>
            {terminal.map((entry) => (
              <li key={entry.label}><span className="gv-command-screen__terminal-label">{entry.label}</span> {entry.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** What a screen shows while its read is running, failed or empty. */
export function ReadState({ read, empty, isEmpty }: {
  readonly read: { readonly isPending: boolean; readonly isError: boolean; readonly error: unknown; readonly refetch: () => unknown };
  readonly empty: string;
  readonly isEmpty: boolean;
}) {
  if (read.isPending) return <p className="gv-command-screen__state">Reading…</p>;
  if (read.isError) {
    return (
      <div className="gv-command-screen__state" role="alert">
        <p>{formatError(read.error)}</p>
        <Button size="sm" onClick={() => { void read.refetch(); }}>Read again</Button>
      </div>
    );
  }
  return isEmpty ? <p className="gv-command-screen__state">{empty}</p> : null;
}

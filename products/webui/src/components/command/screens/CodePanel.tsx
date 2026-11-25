/**
 * Code and changes: the web view of the Code and changes place (terminal-shell
 * places/code-place.ts), its daemon side only. The worktrees of the daemon's
 * project (`worktrees.snapshot`, the register every program shares), each with
 * "Run setup again" and "Remove", the two code capabilities that are the
 * daemon's own methods (`worktree.setup`, `worktree.discard`), run through
 * `capabilities.run` as the owner's own press; removing asks first, because it
 * cannot be undone. The changed files, commits, code index, code lookups and
 * tests act on the folder of the terminal program holding the conversation,
 * so they are there, not here.
 */
import { useState } from 'react';
import { formatError } from '../../../lib/errors';
import { invokeOwnerMethod } from '../../../lib/goodvibes';
import { asArray, asRecord } from '../../../lib/object';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Row, RowList } from '../../ui/Row';
import { StatusDot } from '../../ui/StatusDot';
import { CommandScreen, ReadState, useCommandRead, useRefreshCommandScreens } from './CommandScreen';

interface WorktreeRow {
  readonly path: string;
  readonly name: string;
  readonly state: string;
  readonly made: string;
  readonly session: string;
  readonly task: string;
  readonly setup: string;
}

const MADE_BY: Readonly<Record<string, string>> = { manual: 'made by hand', agent: 'made by an agent', orchestrator: 'made by work' };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readWorktrees(output: unknown): readonly WorktreeRow[] {
  return asArray(asRecord(output).records).map(asRecord).filter((record) => text(record.path)).map((record) => {
    const path = text(record.path);
    return {
      path,
      name: path.split('/').filter(Boolean).at(-1) ?? path,
      state: text(record.state) || 'active',
      made: MADE_BY[text(record.kind)] ?? '',
      session: text(record.sessionId),
      task: text(record.taskId),
      setup: text(asRecord(record.setup).state),
    };
  });
}

export function CodePanel() {
  const read = useCommandRead('code-worktrees', 'worktrees.snapshot');
  const refresh = useRefreshCommandScreens();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean } | null>(null);
  const [removing, setRemoving] = useState<WorktreeRow | null>(null);
  const rows = read.data ? readWorktrees(read.data) : [];

  const run = async (id: 'worktree.setup' | 'worktree.discard', row: WorktreeRow) => {
    setBusy(`${id}:${row.path}`);
    try {
      const answer = asRecord(await invokeOwnerMethod('capabilities.run', { id, inputs: { worktree: row.path } }));
      const data = asRecord(answer.data);
      // The method's receipt says when it did not do it (a worktree holding work it cannot save, a path it does not know).
      if (data.ok === false) setSaid({ text: `Not removed: ${text(data.detail) || 'the daemon did not say why'}.`, failed: true });
      else if (id === 'worktree.setup') {
        const setup = asRecord(data.setup);
        const state = text(setup.state);
        setSaid({
          text: state === 'failed' ? `The setup failed in ${row.name}: ${text(setup.error) || 'no reason was given'}.`
            : state === 'skipped' ? `Nothing to set up in ${row.name}: worktree.setup.commands and worktree.setup.carryOverGlobs found nothing to run or copy.`
              : `The setup ran again in ${row.name} and succeeded.`,
          failed: state === 'failed',
        });
      } else {
        const branch = text(data.branch) ? `its branch ${text(data.branch)}` : 'its branch';
        setSaid({ text: `Removed ${row.name}; ${branch} is kept${text(data.preservedCommit) ? ', with what was uncommitted saved on it' : ''}.`, failed: false });
      }
    } catch (error) {
      setSaid({ text: `Not done: ${formatError(error)}`, failed: true });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <CommandScreen
      command="changes"
      title="Code and changes"
      summary="The worktrees of the daemon's project. Changed files, commits, the code index, code lookups and the tests are in Code and changes in the terminal app and the Agent, where the project's folder is."
      testId="code-panel"
    >
      <ReadState read={read} isEmpty={rows.length === 0} empty="No worktrees: parallel work has not made any in the daemon's project." />
      {rows.length > 0 ? (
        <RowList aria-label="Worktrees">
          {rows.map((row) => (
            <Row
              key={row.path}
              leading={<StatusDot tone={row.setup === 'failed' ? 'warn' : row.state === 'paused' ? 'idle' : 'ok'} srLabel={row.setup === 'failed' ? 'Setup failed' : row.state} />}
              title={row.name}
              meta={[
                row.state, row.made, row.session ? `session ${row.session}` : '', row.task ? `task ${row.task}` : '',
                row.setup ? `setup ${row.setup}` : 'setup never run', row.path,
              ].filter(Boolean).join(' · ')}
              trailing={(
                <span className="gv-action-buttons">
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void run('worktree.setup', row); }}>Run setup again</Button>
                  <Button size="sm" variant="quiet-danger" disabled={busy !== null} onClick={() => setRemoving(row)}>Remove</Button>
                </span>
              )}
            />
          ))}
        </RowList>
      ) : null}
      {said ? <p className="gv-command-screen__state" role={said.failed ? 'alert' : 'status'}>{said.text}</p> : null}
      <ConfirmDialog
        open={removing !== null}
        title="Remove this worktree?"
        description={removing ? `${removing.path} is removed from disk; its branch is kept and anything uncommitted is saved on it first. This cannot be undone.` : ''}
        confirmLabel="Remove it"
        tone="danger"
        busy={busy !== null}
        onCancel={() => setRemoving(null)}
        onConfirm={() => { const row = removing; setRemoving(null); if (row) void run('worktree.discard', row); }}
      />
    </CommandScreen>
  );
}

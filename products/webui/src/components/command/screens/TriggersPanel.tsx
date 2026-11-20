/**
 * Triggers: what the daemon watches (a command finishing, a line it prints, a
 * page or a file changing) and what it does when one fires. The screen says
 * who supervises them (this daemon, another process, or nobody yet), lists
 * each trigger with its state, how often it fired and its last error, and
 * carries the `/triggers` actions: watch for something (a form; the daemon
 * reads it into the definition and shows it before it is made), see what one
 * did, start one that gave up, stop one; and the commands triggers may run,
 * with "Let triggers run a command…". This is also where a trigger that
 * stopped after repeated failures is recovered.
 */
import { useState } from 'react';
import { readTriggerOperatorStatus } from '@goodvibes-jev/engine/platform/platform/triggers/browser';
import { asArray, asRecord } from '../../../lib/object';
import { Button } from '../../ui/Button';
import { Row, RowList } from '../../ui/Row';
import { StatusDot } from '../../ui/StatusDot';
import { ActionButtons } from '../ActionButtons';
import { CommandScreen, ReadState, useCommandRead, useRefreshCommandScreens } from './CommandScreen';

interface TriggerRow {
  readonly id: string;
  readonly label: string;
  readonly state: string;
  readonly watching: string;
  readonly fired: number;
  readonly lastError: string;
  readonly gaveUp: boolean;
}

function readTriggers(output: unknown): readonly TriggerRow[] {
  return asArray(asRecord(output).triggers).map((value) => {
    const trigger = asRecord(value);
    return {
      id: String(trigger.id ?? ''),
      label: String(trigger.label ?? trigger.id ?? ''),
      state: String(trigger.state ?? ''),
      watching: String(trigger.watching ?? ''),
      fired: typeof trigger.firedCount === 'number' ? trigger.firedCount : 0,
      lastError: typeof trigger.lastError === 'string' ? trigger.lastError : '',
      gaveUp: trigger.state === 'circuit-open',
    };
  }).filter((row) => row.id);
}

function Runs({ id }: { readonly id: string }) {
  const read = useCommandRead(`trigger-runs-${id}`, 'watchers.triggers.history', { id, limit: 10 });
  const runs = asArray(asRecord(read.data).runs).map(asRecord);
  return (
    <div className="gv-command-screen__nested">
      <ReadState read={read} isEmpty={runs.length === 0} empty="It has not fired yet." />
      {runs.length > 0 ? (
        <ul className="gv-command-screen__runs" aria-label="Its newest runs">
          {runs.map((run, index) => (
            <li key={`${String(run.at)}-${index}`}>
              <span className="gv-command-screen__run-at">{run.at ? new Date(String(run.at)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : ''}</span>
              {' '}{String(run.outcome ?? '')}{run.detail !== undefined ? `: ${String(run.detail)}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function TriggersPanel() {
  const status = useCommandRead('trigger-status', 'watchers.triggers.status');
  const triggers = useCommandRead('triggers', 'watchers.triggers.list');
  const grants = useCommandRead('trigger-grants', 'watchers.triggers.grant.list');
  const refresh = useRefreshCommandScreens();
  const [openRuns, setOpenRuns] = useState<string | null>(null);
  const rows = triggers.data ? readTriggers(triggers.data) : [];
  const grantRows = asArray(asRecord(grants.data).grants).map(asRecord);
  let supervisor = '';
  try { supervisor = status.data ? readTriggerOperatorStatus(status.data).message : ''; } catch { supervisor = ''; }
  return (
    <CommandScreen
      command="triggers"
      testId="triggers-panel"
      actions={<ActionButtons command="triggers" actions={['watch']} primary onDone={refresh} />}
    >
      {supervisor ? <p className="gv-command-screen__summary">{supervisor}</p> : null}
      <ReadState read={triggers} isEmpty={rows.length === 0} empty="No triggers yet. Watch for something, and the daemon acts each time it happens." />
      {rows.length > 0 ? (
        <RowList aria-label="Triggers">
          {rows.map((row) => (
            <li key={row.id} className="gv-command-screen__group">
              <ul className="gv-rows">
                <Row
                  leading={<StatusDot tone={row.gaveUp || row.state === 'failed' ? 'bad' : row.lastError || row.state === 'backoff' ? 'warn' : row.state === 'running' || row.state === 'firing' || row.state === 'idle' ? 'ok' : 'idle'} srLabel={row.state} />}
                  title={row.label}
                  meta={[row.watching, row.state, `fired ${row.fired}`, row.lastError ? `last error: ${row.lastError}` : ''].filter(Boolean).join(' · ')}
                  trailing={(
                    <span className="gv-action-buttons">
                      <Button size="sm" variant="secondary" aria-expanded={openRuns === row.id} onClick={() => setOpenRuns((now) => (now === row.id ? null : row.id))}>
                        {openRuns === row.id ? 'Hide runs' : 'Runs'}
                      </Button>
                      <ActionButtons
                        command="triggers"
                        short
                        actions={row.gaveUp ? ['restart'] : []}
                        menu={['stop']}
                        menuLabel={`More for ${row.label}`}
                        prefill={{ trigger: row.id }}
                        onDone={refresh}
                      />
                    </span>
                  )}
                />
              </ul>
              {openRuns === row.id ? <Runs id={row.id} /> : null}
            </li>
          ))}
        </RowList>
      ) : null}
      <div className="gv-command-screen__subhead">
        <h4>Commands triggers may run</h4>
        <ActionButtons command="triggers" actions={['allow-command']} onDone={refresh} />
      </div>
      <ReadState read={grants} isEmpty={grantRows.length === 0} empty="None yet. A trigger asks the agent to look at what happened unless you let it run one of your commands." />
      {grantRows.length > 0 ? (
        <RowList aria-label="Commands triggers may run">
          {grantRows.map((grant) => (
            <Row
              key={String(grant.id)}
              title={String(grant.id ?? '')}
              meta={[[grant.command, ...asArray(grant.args)].map(String).join(' '), grant.cwd ? `in ${String(grant.cwd)}` : ''].filter(Boolean).join(' · ')}
            />
          ))}
        </RowList>
      ) : null}
    </CommandScreen>
  );
}

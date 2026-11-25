/**
 * Tools and extensions: the web view of the place (terminal-shell
 * places/tools-place.ts), its daemon side. The hooks of the daemon's project
 * (`hooks.contracts`), each switched on or off or removed in place; the trace
 * of which hooks ran, when, on what, in which program and what each did
 * (`hooks.trace`, read again on LIST_CHANGED `hook-trace`); the tool servers
 * the MCP config files name (`mcp.files`) and the daemon's own connections
 * (McpServers.tsx); then the skills, presets and managed settings
 * (ToolsSkillsSections.tsx). Every button runs its capability as the owner's
 * own press; only what cannot be undone asks first. The tools the model can
 * call and a block for one session are a terminal program's own, so they are
 * there, not here.
 */
import { useState } from 'react';
import { formatError } from '../../../lib/errors';
import { invokeOwnerMethod } from '../../../lib/goodvibes';
import { asArray, asRecord } from '../../../lib/object';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Row, RowList } from '../../ui/Row';
import { StatusDot } from '../../ui/StatusDot';
import { ActionButtons } from '../ActionButtons';
import { CommandScreen, ReadState, useCommandRead, useRefreshCommandScreens } from './CommandScreen';
import { McpServers } from './McpServers';
import { ToolsSkillsSections } from './ToolsSkillsSections';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}
const run = (id: string, inputs: Readonly<Record<string, string>> = {}) => ({ id, inputs });
const dataOf = (answer: unknown) => asRecord(asRecord(answer).data);

const HOOK_KIND_WORDS: Readonly<Record<string, string>> = {
  command: 'runs a command', prompt: 'asks the model', agent: 'starts an agent', http: 'calls a web address', ts: 'runs a TypeScript file',
};
const PROGRAM_WORDS: Readonly<Record<string, string>> = { tui: 'the terminal app', agent: 'the Agent', daemon: 'the daemon' };

interface HookRow { readonly name: string; readonly kind: 'hook' | 'chain'; readonly on: boolean; readonly at: string; readonly does: string }

function Hooks({ onDone }: { readonly onDone: () => void }) {
  const read = useCommandRead('tools-hooks', 'capabilities.run', run('hooks.contracts'));
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ readonly text: string; readonly failed: boolean } | null>(null);
  const [removing, setRemoving] = useState<HookRow | null>(null);
  const data = dataOf(read.data);
  const rows: readonly HookRow[] = [
    ...asArray(data.managed).map(asRecord).filter((hook) => text(hook.name)).map((hook): HookRow => ({
      name: text(hook.name), kind: 'hook', on: hook.enabled !== false, at: text(hook.pattern), does: HOOK_KIND_WORDS[text(hook.type)] ?? text(hook.type),
    })),
    ...asArray(data.chains).map(asRecord).filter((chain) => text(chain.name)).map((chain): HookRow => ({
      name: text(chain.name), kind: 'chain', on: true, at: asArray(chain.points).map(text).join(', then '), does: 'a chain of hook points',
    })),
  ];

  const act = async (id: 'hooks.enable' | 'hooks.disable' | 'hooks.remove', row: HookRow) => {
    setBusy(`${id}:${row.name}`);
    try {
      const answer = asRecord(await invokeOwnerMethod('capabilities.run', run(id, { hook: row.name })));
      setSaid({ text: text(answer.text) || 'Done.', failed: false });
    } catch (error) {
      setSaid({ text: `Not done: ${formatError(error)}`, failed: true });
    } finally {
      setBusy(null);
      onDone();
    }
  };

  return (
    <section aria-label="Hooks">
      <div className="gv-command-screen__subhead">
        <h4>Hooks</h4>
        <ActionButtons command="hooks" actions={['scaffold', 'chain']} menu={['simulate', 'export', 'inspect', 'import']} menuLabel="More about hooks" onDone={onDone} />
      </div>
      <ReadState read={read} isEmpty={rows.length === 0} empty="No hooks yet: nothing of yours runs when a tool runs or a turn ends." />
      {rows.length > 0 ? (
        <RowList aria-label="Hooks">
          {rows.map((row) => (
            <Row
              key={`${row.kind}:${row.name}`}
              leading={<StatusDot tone={row.on ? 'ok' : 'idle'} srLabel={row.on ? 'On' : 'Off'} />}
              title={row.name}
              meta={[row.at ? `at ${row.at}` : '', row.does, row.kind === 'hook' && !row.on ? 'switched off' : ''].filter(Boolean).join(' · ')}
              trailing={(
                <span className="gv-action-buttons">
                  {row.kind === 'hook' ? (
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void act(row.on ? 'hooks.disable' : 'hooks.enable', row); }}>
                      {row.on ? 'Switch off' : 'Switch on'}
                    </Button>
                  ) : null}
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
        title={removing?.kind === 'chain' ? 'Remove this chain?' : 'Remove this hook?'}
        description={removing ? `${removing.name} is deleted from the hooks file; save the hooks to a file first to keep a copy. This cannot be undone.` : ''}
        confirmLabel="Remove it"
        tone="danger"
        busy={busy !== null}
        onCancel={() => setRemoving(null)}
        onConfirm={() => { const row = removing; setRemoving(null); if (row) void act('hooks.remove', row); }}
      />
    </section>
  );
}

function HookRuns() {
  const read = useCommandRead('tools-hook-runs', 'capabilities.run', run('hooks.trace', { limit: '50' }));
  const runs = asArray(dataOf(read.data).runs).map(asRecord).filter((entry) => text(entry.id));
  return (
    <section aria-label="Hook runs">
      <div className="gv-command-screen__subhead"><h4>Hook runs</h4></div>
      <ReadState read={read} isEmpty={runs.length === 0} empty="No hook has run here yet." />
      {runs.length > 0 ? (
        <RowList aria-label="Hook runs">
          {runs.map((entry) => {
            const failed = entry.ok !== true;
            const refused = text(entry.decision) === 'deny';
            return (
              <Row
                key={text(entry.id)}
                leading={<StatusDot tone={failed ? 'warn' : refused ? 'idle' : 'ok'} srLabel={failed ? 'Failed' : refused ? 'Refused it' : 'Ran'} />}
                title={`${text(entry.hook)} at ${text(entry.point)}${text(entry.on) ? ` on ${text(entry.on)}` : ''}`}
                meta={[
                  typeof entry.at === 'number' ? new Date(entry.at).toLocaleString() : '', `in ${PROGRAM_WORDS[text(entry.program)] ?? text(entry.program)}`,
                  text(entry.did), typeof entry.durationMs === 'number' ? `${entry.durationMs} ms` : '',
                ].filter(Boolean).join(' · ')}
              />
            );
          })}
        </RowList>
      ) : null}
    </section>
  );
}

function ServerFiles({ onDone }: { readonly onDone: () => void }) {
  const read = useCommandRead('tools-server-files', 'capabilities.run', run('mcp.files'));
  const servers = asArray(dataOf(read.data).servers).map(asRecord).filter((server) => text(server.name));
  return (
    <section aria-label="Server files">
      <div className="gv-command-screen__subhead">
        <h4>Where your tool servers are kept</h4>
        <ActionButtons command="mcp" actions={['add-server']} onDone={onDone} />
      </div>
      <ReadState read={read} isEmpty={servers.length === 0} empty="No MCP config file names a server yet." />
      {servers.length > 0 ? (
        <RowList aria-label="Server files">
          {servers.map((server) => {
            const waits = server.waitsForTrust === true;
            const theirs = server.writable === false || text(server.scope) === 'external';
            const name = text(server.name);
            return (
              <Row
                key={`${text(server.path)}#${name}`}
                leading={<StatusDot tone={waits ? 'warn' : theirs ? 'idle' : 'ok'} srLabel={waits ? 'Waits for the folder\'s trust' : theirs ? 'Another program\'s file' : 'Kept'} />}
                title={name}
                meta={[text(server.endpoint), text(server.path), waits ? 'waits until this folder is trusted' : theirs ? 'another program\'s file' : ''].filter(Boolean).join(' · ')}
                trailing={theirs ? undefined : (
                  <ActionButtons command="mcp" short actions={['set-trust', 'set-role']} menu={['exempt-tool', 'unexempt-tool', 'remove-server']} menuLabel={`More for ${name}`} prefill={{ server: name }} onDone={onDone} />
                )}
              />
            );
          })}
        </RowList>
      ) : null}
    </section>
  );
}

export function ToolsPanel() {
  const refresh = useRefreshCommandScreens();
  return (
    <CommandScreen
      command="mcp"
      title="Tools and extensions"
      summary="Your hooks and what they did, your tool servers, skills, presets and managed settings. The tools the model can call, and a block or a trust level for one session, are in Tools and extensions in the terminal app and the Agent."
      testId="tools-panel"
    >
      <Hooks onDone={refresh} />
      <HookRuns />
      <ServerFiles onDone={refresh} />
      <McpServers />
      <ToolsSkillsSections onDone={refresh} />
    </CommandScreen>
  );
}

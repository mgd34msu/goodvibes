/**
 * MCP servers: the servers that connect tools from other programs, each with
 * whether it is connected, its trust level and role, where it is kept, and
 * the `/mcp` actions that apply to it (trust, role, accepting changed tools,
 * removing it); opened, its tools with their rules (block, stop blocking, let
 * one go beyond the server's limits, or make it follow them again). "Add a
 * server…" and "Reconnect every server…" head the screen. Every button opens
 * the sheet drawn from the command's description; a rule that lasts one
 * terminal session is shown, and changed only from that terminal.
 */
import { useMemo, useState } from 'react';
import { asArray, asRecord } from '../../../lib/object';
import { Button } from '../../ui/Button';
import { Row, RowList } from '../../ui/Row';
import { StatusDot } from '../../ui/StatusDot';
import { ActionButtons } from '../ActionButtons';
import { CommandScreen, ReadState, useCommandRead, useRefreshCommandScreens } from './CommandScreen';

interface ToolView {
  readonly name: string;
  readonly description: string;
  /** The kept rule, or the session's. */
  readonly rule?: { readonly kind: 'allow' | 'deny'; readonly source: 'session' | 'stored' } | undefined;
}

interface ServerView {
  readonly name: string;
  readonly connected: boolean;
  readonly trust: string;
  readonly role: string;
  readonly heldBack: string | undefined;
  /** Named in a project file of a folder the owner has not trusted: kept, not started. */
  readonly waitsForTrust: boolean;
  readonly where: string;
  readonly tools: readonly ToolView[];
}

function readServers(config: unknown, servers: unknown, tools: unknown): readonly ServerView[] {
  const security = new Map<string, Record<string, unknown>>();
  for (const entry of asArray(asRecord(servers).security)) {
    const record = asRecord(entry);
    if (typeof record.name === 'string') security.set(record.name, record);
  }
  const listed = asArray(asRecord(tools).tools).map(asRecord);
  const waiting = new Set(asArray(asRecord(config).heldForTrust).map(String));
  return asArray(asRecord(config).servers).map((value) => {
    const server = asRecord(value);
    const name = String(server.name ?? '');
    const record = security.get(name) ?? {};
    const source = asRecord(server.source);
    const rules = new Map<string, ToolView['rule']>();
    for (const entry of asArray(record.toolRules)) {
      const rule = asRecord(entry);
      if (typeof rule.toolName !== 'string' || (rule.rule !== 'allow' && rule.rule !== 'deny')) continue;
      const kind: 'allow' | 'deny' = rule.rule;
      // A denial wins over an allow; a kept rule is shown over the session's.
      const known = rules.get(rule.toolName);
      if (!known || kind === 'deny') rules.set(rule.toolName, { kind, source: rule.source === 'session' ? 'session' : 'stored' });
    }
    for (const toolName of asArray(server.deniedTools)) if (typeof toolName === 'string') rules.set(toolName, { kind: 'deny', source: 'stored' });
    for (const toolName of asArray(server.allowedTools)) if (typeof toolName === 'string' && !rules.has(toolName)) rules.set(toolName, { kind: 'allow', source: 'stored' });
    const names = new Set<string>([...listed.filter((tool) => tool.serverName === name).map((tool) => String(tool.toolName ?? '')), ...rules.keys()]);
    return {
      name,
      connected: record.connected === true,
      trust: String(record.trustMode ?? server.trustMode ?? ''),
      role: String(record.role ?? server.role ?? ''),
      waitsForTrust: waiting.has(name),
      heldBack: record.schemaFreshness === 'quarantined' ? String(record.quarantineReason ?? 'its tools changed') : undefined,
      where: [source.scope ? `${String(source.scope)} config` : '', typeof source.path === 'string' ? source.path : ''].filter(Boolean).join(' · '),
      tools: [...names].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((toolName) => ({
        name: toolName,
        description: String(listed.find((tool) => tool.serverName === name && tool.toolName === toolName)?.description ?? ''),
        rule: rules.get(toolName),
      })),
    };
  }).filter((server) => server.name);
}

function ruleWords(rule: ToolView['rule'], server: string): string {
  if (!rule) return `follows ${server}'s limits`;
  const lasts = rule.source === 'session' ? 'for a terminal session' : 'kept';
  return rule.kind === 'deny' ? `blocked, ${lasts}` : `goes beyond ${server}'s limits, ${lasts}`;
}

function ServerTools({ server, onDone }: { readonly server: ServerView; readonly onDone: () => void }) {
  if (server.tools.length === 0) return <p className="gv-command-screen__state">{server.connected ? 'This server offers no tools.' : server.waitsForTrust ? 'Its tools show once this folder is trusted and it connects.' : 'Its tools show once it connects.'}</p>;
  return (
    <RowList aria-label={`Tools of ${server.name}`}>
      {server.tools.map((tool) => {
        const session = tool.rule?.source === 'session';
        return (
          <Row
            key={tool.name}
            className="gv-command-screen__tool"
            title={tool.name}
            meta={[ruleWords(tool.rule, server.name), tool.description].filter(Boolean).join(' · ')}
            trailing={session ? <span className="gv-command-screen__hint">Changed from that terminal app</span> : (
              <ActionButtons
                command="mcp"
                short
                actions={[tool.rule?.kind === 'deny' ? 'unblock-tool' : 'block-tool']}
                menu={tool.rule?.kind === 'deny' ? [] : [tool.rule?.kind === 'allow' ? 'unexempt-tool' : 'exempt-tool']}
                menuLabel={`More for ${tool.name}`}
                prefill={{ server: server.name, tool: tool.name }}
                onDone={onDone}
              />
            )}
          />
        );
      })}
    </RowList>
  );
}

export function McpServers() {
  const config = useCommandRead('mcp-config', 'mcp.config.get');
  const servers = useCommandRead('mcp-servers', 'mcp.servers.list');
  const tools = useCommandRead('mcp-tools', 'mcp.tools.list');
  const refresh = useRefreshCommandScreens();
  const [openServer, setOpenServer] = useState<string | null>(null);
  const views = useMemo(() => readServers(config.data, servers.data, tools.data), [config.data, servers.data, tools.data]);
  return (
    <CommandScreen
      command="mcp"
      testId="mcp-servers"
      actions={<ActionButtons command="mcp" actions={['add-server', 'reload']} primary onDone={refresh} />}
    >
      <ReadState read={config} isEmpty={views.length === 0} empty="No servers yet. Add one to connect the tools of another program." />
      {views.length > 0 ? (
        <RowList aria-label="MCP servers">
          {views.map((server) => (
            <li key={server.name} className="gv-command-screen__group">
              <ul className="gv-rows">
                <Row
                  leading={<StatusDot tone={server.heldBack || server.waitsForTrust ? 'warn' : server.connected ? 'ok' : 'idle'} srLabel={server.waitsForTrust ? 'Waits for this folder to be trusted' : server.heldBack ? 'Tools held back' : server.connected ? 'Connected' : 'Not connected'} />}
                  title={server.name}
                  meta={[
                    server.waitsForTrust ? 'not started: this folder is not trusted yet (Trust this folder, /security trust-folder, in the app that opened it)'
                      : server.heldBack ? `tools held back: ${server.heldBack}` : server.connected ? 'connected' : 'not connected',
                    server.trust ? `trust: ${server.trust}` : '',
                    server.role ? `role: ${server.role}` : '',
                    server.where,
                  ].filter(Boolean).join(' · ')}
                  trailing={(
                    <span className="gv-action-buttons">
                      <Button size="sm" variant="secondary" aria-expanded={openServer === server.name} onClick={() => setOpenServer((now) => (now === server.name ? null : server.name))}>
                        {openServer === server.name ? 'Hide tools' : `Tools (${server.tools.length})`}
                      </Button>
                      <ActionButtons
                        command="mcp"
                        short
                        actions={server.heldBack ? ['accept-tools'] : []}
                        menu={['set-trust', 'set-role', 'remove-server']}
                        menuLabel={`More for ${server.name}`}
                        prefill={{ server: server.name }}
                        current={{ mode: server.trust, role: server.role }}
                        onDone={refresh}
                      />
                    </span>
                  )}
                />
              </ul>
              {openServer === server.name ? <div className="gv-command-screen__nested"><ServerTools server={server} onDone={refresh} /></div> : null}
            </li>
          ))}
        </RowList>
      ) : null}
    </CommandScreen>
  );
}

/**
 * MCP tool rules, in Settings > Permissions: for each configured MCP server,
 * its tools and the allow or denial each one carries, with where it came from
 * (kept in the server's MCP config, or denied for this session with /mcp deny
 * in a terminal app). The owner keeps a denial (mcp.servers.tools.deny), an
 * allow past the server's path and host scope (mcp.servers.tools.allow, asked
 * once here, and only in his global MCP config), or clears the kept rule
 * (mcp.servers.tools.clear). Allow and clear are the owner's own acts: the
 * daemon refuses them for the Agent's model on every route.
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { invokeMethod } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { useConfirm } from '../ui/ConfirmDialog';
import { Row, RowList } from '../ui/Row';
import { StatusDot } from '../ui/StatusDot';
import { SettingsBlock } from './dialog/parts';

type ToolRuleAction = 'deny' | 'allow' | 'clear';

/** One per-tool rule as the daemon's server security record reports it. */
interface ToolRuleView {
  readonly toolName: string;
  readonly rule: 'allow' | 'deny';
  readonly source: 'session' | 'stored';
  readonly inEffect: boolean;
}

interface ServerView {
  readonly name: string;
  readonly connected: boolean;
  /** Where the server's entry is kept: `global`, `project`, or `external` (a file another program owns). */
  readonly scope: string;
  readonly path: string;
  readonly writable: boolean;
  readonly tools: readonly string[];
  readonly rules: readonly ToolRuleView[];
}

function readToolRules(value: unknown): ToolRuleView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ToolRuleView[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const toolName = record.toolName;
    const rule = record.rule;
    const source = record.source;
    if (typeof toolName !== 'string' || (rule !== 'allow' && rule !== 'deny') || (source !== 'session' && source !== 'stored')) return [];
    return [{ toolName, rule, source, inEffect: record.inEffect !== false }];
  });
}

/** The state of one tool, in words: what decides its calls and where that came from. */
function describeToolRules(rules: readonly ToolRuleView[]): { readonly text: string; readonly tone: 'ok' | 'bad' | 'idle' } {
  if (rules.length === 0) return { text: 'Trust mode and scope decide', tone: 'idle' };
  const parts = rules.map((rule) => `${rule.rule === 'deny' ? 'Denied' : 'Allowed past scope'} (${rule.source === 'session' ? 'this session' : 'kept in config'}${rule.inEffect ? '' : ', overridden by a denial'})`);
  return { text: parts.join(' · '), tone: rules.some((rule) => rule.rule === 'deny') ? 'bad' : 'ok' };
}

export function McpToolRules() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const config = useQuery({ queryKey: queryKeys.mcpConfig, queryFn: () => invokeMethod('mcp.config.get') });
  const servers = useQuery({ queryKey: queryKeys.mcpServers, queryFn: () => invokeMethod('mcp.servers.list') });
  const tools = useQuery({ queryKey: queryKeys.mcpTools, queryFn: () => invokeMethod('mcp.tools.list') });

  const views = useMemo((): ServerView[] => {
    const security = new Map<string, Record<string, unknown>>();
    for (const entry of servers.data?.security ?? []) {
      if (typeof entry.name === 'string') security.set(entry.name, entry);
    }
    return (config.data?.servers ?? []).map((server) => {
      const record = security.get(server.name);
      const rules = readToolRules(record?.toolRules);
      const listed = (tools.data?.tools ?? []).filter((tool) => tool.serverName === server.name).map((tool) => tool.toolName);
      const named = rules.map((rule) => rule.toolName);
      return {
        name: server.name,
        connected: record?.connected === true,
        scope: server.source.scope,
        path: server.source.path,
        writable: server.source.writable && server.source.scope !== 'external',
        tools: [...new Set([...listed, ...named])].sort((a, b) => a.localeCompare(b)),
        rules,
      };
    });
  }, [config.data, servers.data, tools.data]);

  const change = useMutation({
    mutationFn: ({ action, serverName, toolName }: { action: ToolRuleAction; serverName: string; toolName: string }) => {
      if (action === 'deny') return invokeMethod('mcp.servers.tools.deny', { serverName, toolName });
      if (action === 'allow') return invokeMethod('mcp.servers.tools.allow', { serverName, toolName });
      return invokeMethod('mcp.servers.tools.clear', { serverName, toolName });
    },
    onSuccess: async (result, { action, serverName, toolName }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcp });
      const where = `${result.scope} MCP config (${result.path})`;
      toast(!result.changed
        ? { title: 'Nothing changed', description: `${toolName} on ${serverName} already had that rule in the ${where}.`, tone: 'info' }
        : action === 'deny'
          ? { title: `${toolName} denied`, description: `Every call to it is refused, kept in the ${where}.`, tone: 'success' }
          : action === 'allow'
            ? { title: `${toolName} allowed past scope`, description: `Kept in the ${where}. A blocked server, a quarantined schema or a denial still refuses it.`, tone: 'success' }
            : { title: `Rule for ${toolName} cleared`, description: `Its trust mode and scope decide each call again (${where}).`, tone: 'success' });
    },
    onError: (error: unknown, { toolName }) => toast({ title: `${toolName} not changed`, description: formatError(error), tone: 'danger' }),
  });

  async function handle(action: ToolRuleAction, server: ServerView, toolName: string): Promise<void> {
    if (action === 'allow') {
      const ok = await confirm.ask({
        title: `Allow ${toolName} past ${server.name}'s scope?`,
        target: `${server.name} · ${toolName}`,
        description: 'Calls to this tool pass the server\'s path and host scope, kept in your global MCP config until you clear it. A blocked server, a quarantined schema or a denial of the tool still refuses it.',
        confirmLabel: 'Allow',
        tone: 'danger',
      });
      if (!ok) return;
    }
    if (action === 'clear' && server.rules.some((rule) => rule.toolName === toolName && rule.rule === 'deny' && rule.source === 'stored')) {
      const ok = await confirm.ask({
        title: `Lift the denial of ${toolName}?`,
        target: `${server.name} · ${toolName}`,
        description: 'Calls to this tool are no longer refused by the kept denial; the server\'s trust mode and scope decide them again.',
        confirmLabel: 'Lift',
        tone: 'danger',
      });
      if (!ok) return;
    }
    change.mutate({ action, serverName: server.name, toolName });
  }

  const pending = config.isPending || servers.isPending;
  const failed = config.error ?? servers.error;
  const refetch = () => { void config.refetch(); void servers.refetch(); void tools.refetch(); };

  return (
    <SettingsBlock
      title="MCP tool rules"
      description="Deny one tool of an MCP server, or allow it past the server's path and host scope. Rules here are kept with the server's entry in its MCP config; a denial set with /mcp deny in a terminal app lasts that app's session, or until /mcp clear there."
      actions={<IconButton label="Refresh MCP tool rules" icon={<RefreshCw />} onClick={refetch} />}
      testId="mcp-tool-rules"
    >
      {confirm.element}
      {pending && <p className="settings-empty">Loading MCP servers…</p>}
      {failed && (
        <p className="settings-empty" role="alert">
          Could not load MCP servers: {formatError(failed)}{' '}
          <Button size="sm" variant="ghost" onClick={refetch}>Retry</Button>
        </p>
      )}
      {!pending && !failed && views.length === 0 && <p className="settings-empty">No MCP servers are configured.</p>}
      {tools.isError && <p className="settings-empty" role="alert">The tool list could not be read ({formatError(tools.error)}); only tools that already carry a rule are shown.</p>}
      {views.map((server) => (
        <RowList key={server.name} aria-label={`Tools of ${server.name}`}>
          <Row
            leading={<StatusDot tone={server.connected ? 'ok' : 'idle'} srLabel={server.connected ? 'connected' : 'not connected'} />}
            title={server.name}
            meta={server.writable
              ? `${server.scope} config · ${server.path}${server.scope === 'project' ? ' · an allow is kept only in your global config' : ''}`
              : `${server.path} belongs to another program: rules cannot be kept there`}
          />
          {server.tools.length === 0 && (
            <Row title={server.connected ? 'This server lists no tools.' : 'Its tools show once it is connected.'} />
          )}
          {server.tools.map((toolName) => {
            const rules = server.rules.filter((rule) => rule.toolName === toolName);
            const kept = rules.find((rule) => rule.source === 'stored');
            const state = describeToolRules(rules);
            const busy = change.isPending && change.variables.serverName === server.name && change.variables.toolName === toolName;
            return (
              <Row
                key={toolName}
                leading={<StatusDot tone={state.tone} srLabel={state.text} />}
                title={toolName}
                meta={state.text}
                trailing={server.writable ? (
                  <span className="mcp-tool-rule__actions">
                    {kept?.rule !== 'deny' && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void handle('deny', server, toolName)}
                        title="Refuse every call to this tool, kept in the server's MCP config">Deny</Button>
                    )}
                    {kept?.rule !== 'allow' && server.scope === 'global' && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void handle('allow', server, toolName)}
                        title="Let this tool past the server's path and host scope, kept in your global MCP config">Allow</Button>
                    )}
                    {kept && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void handle('clear', server, toolName)}
                        title="Drop the kept rule; the trust mode and scope decide again">Clear</Button>
                    )}
                  </span>
                ) : undefined}
              />
            );
          })}
        </RowList>
      ))}
    </SettingsBlock>
  );
}

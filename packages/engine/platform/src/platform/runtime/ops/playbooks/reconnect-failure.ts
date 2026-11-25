/**
 * Playbook: Reconnect Failure
 *
 * MCP servers that keep dropping or will not connect, and a daemon
 * connection that does not come back.
 */
import type { Playbook } from '../types.js';
import { safeCheck } from '../safe-check.js';

/** Reconnect failure resolution playbook. */
export const reconnectFailurePlaybook: Playbook = {
  id: 'reconnect-failure',
  name: 'Reconnect Failure',
  description: 'Diagnoses MCP servers that keep dropping or will not connect, and a daemon connection that does not come back.',
  symptoms: [
    'An MCP server keeps disconnecting or reconnecting',
    'MCP tools are missing or unavailable',
    'MCP server needs sign-in again',
    'Lost the connection to the daemon',
  ],
  checks: [
    {
      id: 'transport.endpoint-reachable',
      label: 'MCP servers not connected',
      description: 'Configured MCP servers that are not connected, with their state and last error.',
      run: (ctx) => safeCheck(() => {
        const { mcp } = ctx.store.getState();
        const down = [...mcp.servers.values()].filter((server) => server.status !== 'connected' && server.status !== 'configured');
        return {
          passed: down.length === 0,
          summary: down.length === 0
            ? `${mcp.connectedServerNames.length} MCP server(s) connected.`
            : down.slice(0, 5).map((server) => `${server.name}: ${server.status}${server.reconnectAttempts ? ` after ${server.reconnectAttempts} attempt(s)` : ''}${server.lastError ? ` (${server.lastError})` : ''}`).join('; '),
          severity: down.length === 0 ? 'info' : 'error',
          context: { notConnected: down.length, connected: mcp.connectedServerNames.length },
        };
      }),
    },
    {
      id: 'transport.auth-valid',
      label: 'MCP servers needing sign-in or held',
      description: 'Servers waiting for sign-in, and servers whose tools are held because their schema changed.',
      run: (ctx) => safeCheck(() => {
        const { mcp } = ctx.store.getState();
        const servers = [...mcp.servers.values()];
        const auth = servers.filter((server) => server.status === 'auth_required').map((server) => server.name);
        const quarantined = servers.filter((server) => server.quarantineReason !== undefined && !server.quarantineApprovedBy).map((server) => server.name);
        const passed = auth.length === 0 && quarantined.length === 0;
        return {
          passed,
          summary: passed ? 'No MCP server needs sign-in or review.' : [
            auth.length ? `needs sign-in: ${auth.join(', ')}` : '',
            quarantined.length ? `tools held for review: ${quarantined.join(', ')}` : '',
          ].filter(Boolean).join('; '),
          severity: passed ? 'info' : 'warning',
        };
      }),
    },
    {
      id: 'transport.retry-budget',
      label: 'Daemon connection',
      description: "The state of this app's connection to the daemon.",
      run: (ctx) => safeCheck(() => {
        const { daemon } = ctx.store.getState();
        const failed = daemon.transportState === 'terminal_failure' || daemon.transportState === 'disconnected';
        const unsettled = daemon.transportState === 'reconnecting' || daemon.transportState === 'degraded';
        return {
          passed: !failed && !unsettled,
          summary: `Daemon connection is ${daemon.transportState}${daemon.lastError ? ` (${daemon.lastError})` : ''}.`,
          severity: failed ? 'error' : unsettled ? 'warning' : 'info',
        };
      }),
    },
  ],
  steps: [
    { step: 1, title: 'Repair the server', action: 'Run /mcp repair <server> to see what stops it and the steps that fix it (a sign-in, a command or address), then /mcp reload.', kind: 'command', command: '/mcp repair <server>', expectedOutcome: 'The server is connected and its tools are offered.', automatable: false },
    { step: 2, title: 'Review held tools', action: 'Run /mcp review to approve or reject the changed tools of a held server.', kind: 'command', command: '/mcp review', expectedOutcome: 'The server\'s tools are offered again.', automatable: false },
    { step: 3, title: 'Reload the configuration', action: 'After fixing a server\'s command or address, run /mcp reload.', kind: 'command', command: '/mcp reload', expectedOutcome: 'Every configured server is started again.', automatable: false },
    { step: 4, title: 'Check the daemon', action: 'In the System place, Health, check one area: Services, to see whether the daemon is running and reachable.', kind: 'observe', expectedOutcome: 'The daemon is reachable.', automatable: false },
  ],
  escalationCriteria: [
    'A server keeps failing after repair and reload',
    'The daemon stays unreachable while it is running',
  ],
  tags: ['transport', 'mcp', 'reconnect', 'network', 'daemon'],
};

import type { Secret } from '@goodvibes-jev/engine/platform/platform/security';
import type { CommandContext } from '../input/command-registry.ts';
import { isInvokableContractMethod, operatorContractMethods } from '../tools/agent-harness-personal-ops-discovery.ts';
import type { McpServerPosture, PresenceReading } from './capability-probe-runner.ts';

/**
 * Adapters that turn this app's live state into probe inputs.
 *
 * Each one fails closed and quietly: a source that cannot be read contributes
 * nothing rather than throwing, because a capability check must never be the
 * reason a session fails to start. What it must never do is turn "I could not
 * read this" into "this is not available": each answers present, absent, or
 * unreadable with a short reason, and the runner words the third as "cannot be
 * confirmed: <reason>".
 */

interface ConfigManagerLike {
  readonly get: (key: string) => unknown;
}

/**
 * Whether a config key holds a usable value: present, absent, or unreadable
 * with the reason.
 *
 * Never carries the value itself, so a probe result can be shown to the model
 * or written to a log without leaking a password or a token.
 */
export function configValueIsPresent(configManager: unknown, key: string): PresenceReading {
  const manager = configManager as ConfigManagerLike | null;
  if (!manager || typeof manager.get !== 'function') return { state: 'unreadable', reason: 'no settings reader in this session' };
  let value: unknown;
  try {
    value = manager.get(key);
  } catch {
    return { state: 'unreadable', reason: 'settings could not be read' };
  }
  return valueIsUsable(value) ? PRESENT : ABSENT;
}

function valueIsUsable(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

const PRESENT: PresenceReading = { state: 'present' };
const ABSENT: PresenceReading = { state: 'absent' };

interface SecretsManagerLike {
  readonly resolveLocalCredentialSnapshot: (key: string) => { readonly state: string; readonly value?: Secret; readonly reason?: string };
}

/**
 * Whether a secret-store entry holds a value, never the value. A store the
 * snapshot could not observe (unreadable, a write pending, the same name set
 * in the environment) is `unreadable` with that reason, not `absent`: the
 * capability is not reported ready, and the agent is not told the credential
 * is missing when nobody could look.
 */
export function secretValueIsPresent(secretsManager: unknown, key: string): PresenceReading {
  const manager = secretsManager as SecretsManagerLike | null;
  if (!manager || typeof manager.resolveLocalCredentialSnapshot !== 'function') return { state: 'unreadable', reason: 'no secret store in this session' };
  try {
    const snapshot = manager.resolveLocalCredentialSnapshot(key);
    if (snapshot.state === 'resolved') return snapshot.value !== undefined && snapshot.value.reveal('owner-screen').trim().length > 0 ? PRESENT : ABSENT;
    if (snapshot.state === 'absent') return ABSENT;
    return { state: 'unreadable', reason: snapshot.reason ?? 'store unreadable' };
  } catch {
    return { state: 'unreadable', reason: 'store unreadable' };
  }
}

/** Live MCP server posture, or why it could not be read; empty when this session has no MCP client. */
export function safeMcpServerPosture(context: CommandContext): McpServerPosture {
  try {
    const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
    const servers = api?.listServerSecurity?.() ?? [];
    return {
      servers: servers.map((server) => ({
        name: server.name,
        connected: server.connected,
        trustMode: server.trustMode,
        schemaFreshness: server.schemaFreshness,
      })),
    };
  } catch {
    return { servers: [], unreadable: 'the MCP server list could not be read' };
  }
}

/**
 * Operator methods the daemon actually serves.
 *
 * The contract catalogs more methods than the daemon routes; the ones it does
 * not route carry invokable:false and cannot be called. Only served methods
 * count as a capability's invocation route, which is why every `email.*` entry
 * is correctly absent here today.
 */
export function servedOperatorMethodIds(): readonly string[] {
  try {
    return operatorContractMethods()
      .filter(isInvokableContractMethod)
      .map((method) => method.id);
  } catch {
    return [];
  }
}

/**
 * security-here.ts: what a terminal program gives the security reviews that run where its conversation is
 * (capabilities/builtin/security-review.ts: what needs attention, the whole review, risky routes through MCP servers,
 * the sandbox probe). Its own live state (the MCP servers and plugins its turns use, its subscriptions, the settings
 * its sandbox reads) comes from the program; the daemon's facts (the paired devices' tokens, the policies, this
 * folder's trust) are asked of the daemon through the program's binding. Both terminal programs use this one builder.
 */
import type { SecurityDaemonFacts, SecurityHereServices } from '@goodvibes/engine/platform/platform/capabilities';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext } from './command-actions/types.js';

type Here = NonNullable<SecurityHereServices['securityHere']>;

/** This program's own live state, as the reviews read it. */
export type SecurityHereLive = Pick<Here, 'mcp' | 'plugins' | 'subscriptions' | 'sandboxConfig'>;

function rows(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object') : [];
}

/** The daemon's facts a review names, each said as unreadable on its own when the daemon could not give it. */
async function daemonFacts<Ctx extends CommandActionContext>(ctx: Ctx, binding: DaemonCapabilityBinding<Ctx>): Promise<SecurityDaemonFacts> {
  const ask = async (id: string): Promise<Readonly<Record<string, unknown>> | { readonly unreadable: string }> => {
    try {
      return (await runDaemonCapability(id, {}, ctx, binding)).data ?? {};
    } catch (error) {
      return { unreadable: summarizeError(error) };
    }
  };
  const [tokens, policy, folder] = await Promise.all([ask('security.tokens'), ask('security.policy'), ask('security.folder')]);
  const tokenRows = 'unreadable' in tokens && typeof tokens.unreadable === 'string' ? null : rows((tokens as Record<string, unknown>).tokens);
  return {
    tokens: tokenRows === null ? { unreadable: String((tokens as { unreadable: string }).unreadable) } : {
      total: tokenRows.length,
      blocked: tokenRows.filter((row) => row.blocked === true).length,
      outOfScope: tokenRows.filter((row) => row.scope === 'violation').length,
      overdue: tokenRows.filter((row) => row.rotation === 'overdue').length,
      dueSoon: tokenRows.filter((row) => row.rotation === 'warning').length,
    },
    policy: 'unreadable' in policy && typeof policy.unreadable === 'string' ? { unreadable: policy.unreadable } : {
      lintFindings: typeof (policy as Record<string, unknown>).lintFindings === 'number' ? (policy as { lintFindings: number }).lintFindings : 0,
      preflight: typeof (policy as Record<string, unknown>).preflight === 'string' ? (policy as { preflight: string }).preflight : null,
    },
    ...(typeof (folder as Record<string, unknown>).state === 'string' ? { folderDecided: (folder as { state: string }).state !== 'undecided' && (folder as { state: string }).state !== 'unreadable' } : {}),
  };
}

/** The reviews' services for one program's conversation. */
export function securityHereServices<Ctx extends CommandActionContext>(ctx: Ctx, binding: DaemonCapabilityBinding<Ctx>, live: SecurityHereLive): SecurityHereServices {
  return { securityHere: { ...live, daemonFacts: () => daemonFacts(ctx, binding) } };
}

/**
 * list-changes.ts, one notice from a store when a list a client shows changed
 * (a memory record, a workspace checkpoint, a CI watch, a check-in setting or
 * receipt, a person or device in the people list), so a client reads the list
 * again on the event instead of showing it stale.
 *
 * A store calls `noteListChanged` after its write is durable; the daemon
 * forwards every notice as the runtime event LIST_CHANGED (workspace domain).
 * Process-wide like the stores it serves; a notice costs one call per listener
 * and nothing with none.
 */

/**
 * The lists that announce their changes: also the mailbox (mail arrived or a
 * message was changed), the calendar (an event written, a feed read with
 * changes), dates (occasions, their plans and gifts), paired devices (a pairing
 * token issued or revoked), delegated Telegram messages held for review, the
 * local voice install, and Tailscale (its serve state changed), and the
 * daemon's remote runners (a runner started or stopped, a pool or an artifact
 * changed).
 */
export type ChangedList = 'memory' | 'checkpoints' | 'ci-watches' | 'check-ins' | 'people'
  | 'mail' | 'calendar' | 'dates' | 'paired-devices' | 'telegram-intake' | 'voice' | 'tailscale' | 'relay'
  | 'remote-runners'
  // Work and agents: a research run or a source in the research queue changed, or work was handed to the terminal app
  // (terminal-shell agent-turn/agent-store-research.ts, agent-store-handoff.ts).
  | 'research' | 'handed-off'
  // Work: a piece of work's plan before it runs was written, changed, approved, thrown away or started (workflow/work-ledger/work-plans.ts).
  | 'work'
  // The hook trace: a hook ran in any program (hooks/trace.ts).
  | 'hook-trace'
  // Tools and extensions: the hooks file, a tool server's config, a plugin or an install changed through the daemon (capabilities/builtin/hooks.ts, mcp.ts, plugins.ts, marketplace.ts).
  | 'tools'
  // Automation: a trigger made, stopped, started again or changed state, or a command triggers may run (triggers/manager.ts).
  | 'triggers'
  // Permissions and safety: a permission rule, a secret, a folder's trust, a local sign-in, the policy or the sandbox.
  | 'safety'
  // Money: a card added or removed, a repeat purchase allowed or stopped (payments/host), an address set (capabilities/builtin/money.ts).
  | 'payments'
  // Money: the daemon recorded what a model call cost (runtime/cost/attribution.ts).
  | 'spending'
  // Memory and knowledge: the Agent's own stores, changed by the daemon (terminal-shell agent-turn/agent-store-runner.ts).
  | 'notes' | 'personas' | 'routines' | 'documents' | 'artifacts'
  // Memory and knowledge: what is known about you, written or edited by hand (owner-profile/store.ts), and a template
  // deleted through the daemon (capabilities/builtin/templates.ts).
  | 'profile' | 'templates'
  // Models and providers: a pin, a backup, the routing, a provider of your own, a sign-in or the services list changed through the daemon (capabilities/builtin/models.ts, services.ts).
  | 'models' | 'services'
  // Devices and network: the network-scan decision changed, or the daemon's scan of your network finished (discovery/network-scan.ts).
  | 'network-scan'
  // Devices and network: a settings sync bundle pulled or a setting that disagreed settled through the daemon (capabilities/builtin/settings-sync.ts).
  | 'settings-sync'
  // This conversation: a model's context window size set or cleared through the daemon (capabilities/builtin/context-windows.ts);
  // each running program reads the daemon's file again on it (terminal-shell context-windows-follow.ts).
  | 'context-windows'
  // Mail, calendar and channels: the daemon's webhook addresses changed, or a notification failed (capabilities/builtin/notify.ts).
  | 'notifications';

export interface ListChange {
  readonly list: ChangedList;
  readonly change: 'created' | 'changed' | 'deleted';
  /** The record that changed, when the store names one. */
  readonly id?: string | undefined;
}

const listeners = new Set<(change: ListChange) => void>();

/** Told of every list change in this process; returns the unsubscribe. */
export function onListChanged(listener: (change: ListChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Say a list changed; never throws into the store that wrote. */
export function noteListChanged(change: ListChange): void {
  for (const listener of [...listeners]) {
    try { listener(change); } catch { /* A listener cannot fail a store's write. */ }
  }
}

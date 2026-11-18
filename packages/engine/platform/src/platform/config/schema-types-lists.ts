/**
 * The list-valued settings: each holds an array, read and written as one value
 * like `judgment.fallbacks`. Each is a ConfigKey like any other leaf of
 * GoodVibesConfig; this names the ones whose rows are in schema-domain-lists.ts.
 */

export type ListConfigKey =
  | 'cluster.peers'
  | 'conversationGate.gatedSurfaces'
  | 'contract.gates'
  | 'notifications.webhookUrls'
  | 'provider.fallbackModels'
  | 'sandbox.egressAllowlist'
  | 'sandbox.workspaceWritable'
  | 'surfaces.email.imap.authservIds'
  | 'worktree.setup.commands'
  | 'worktree.setup.carryOverGlobs';

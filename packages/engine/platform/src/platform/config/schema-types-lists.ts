/**
 * The list-valued settings: each holds an array, read and written as one value
 * like `judgment.fallbacks`. Rows in schema-domain-lists.ts.
 */
import type { QualityGate } from '../contract/gates.js';

export type ListConfigKey =
  | 'cluster.peers'
  | 'conversationGate.gatedSurfaces'
  | 'contract.gates'
  | 'sandbox.egressAllowlist'
  | 'sandbox.workspaceWritable'
  | 'worktree.setup.commands'
  | 'worktree.setup.carryOverGlobs';

export interface ListConfigValueMap {
  'cluster.peers': string[];
  'conversationGate.gatedSurfaces': string[];
  'contract.gates': QualityGate[];
  'sandbox.egressAllowlist': string[];
  'sandbox.workspaceWritable': string[];
  'worktree.setup.commands': string[];
  'worktree.setup.carryOverGlobs': string[];
}

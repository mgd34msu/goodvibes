import type { ToolDefinition } from '../../types/tools.js';

export const REMOTE_TRIGGER_TOOL_SCHEMA: ToolDefinition = {
  name: 'remote',
  description: 'Manage remote runner pools, contracts, and portable artifacts.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['create-pool', 'pools', 'assign', 'unassign', 'contracts', 'artifacts', 'review', 'import-artifact'], description: 'create-pool makes a runner pool; pools, contracts and artifacts list them; assign moves a runner into a pool (out of any pool it was in, named as movedFrom) and unassign removes it; review summarizes one artifact; import-artifact reads one from a file in the project.' },
      view: { type: 'string', enum: ['summary', 'full'], description: 'For pools, contracts and artifacts: summary (the default) or each full record.' },
      poolId: { type: 'string', description: 'The pool: required for create-pool, assign and unassign.' },
      label: { type: 'string', description: 'A display name for the pool create-pool makes.' },
      runnerId: { type: 'string', description: 'The runner to assign or unassign, as mode contracts lists it.' },
      artifactId: { type: 'string', description: 'The artifact review summarizes, as mode artifacts lists it.' },
      path: { type: 'string', description: 'The artifact file import-artifact reads; it must be inside the project.' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
};

export interface RemoteTriggerToolInput {
  readonly mode: 'create-pool' | 'pools' | 'assign' | 'unassign' | 'contracts' | 'artifacts' | 'review' | 'import-artifact';
  readonly view?: 'summary' | 'full' | undefined;
  readonly poolId?: string | undefined;
  readonly label?: string | undefined;
  readonly runnerId?: string | undefined;
  readonly artifactId?: string | undefined;
  readonly path?: string | undefined;
}

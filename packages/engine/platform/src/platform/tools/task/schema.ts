export const TASK_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['create', 'list', 'show', 'status', 'depend', 'cancel', 'handoff', 'handoffs', 'acknowledge', 'withdraw'],
      description: 'create a task ref; list or show refs; status moves one; depend records that it waits on another; cancel; handoff passes one to another session; handoffs lists the pending ones; acknowledge accepts one; withdraw takes one back.',
    },
    view: { type: 'string', enum: ['summary', 'full'], description: 'For list, show and handoffs: summary (the default) or each full record.' },
    sessionId: {
      type: 'string',
      description:
        'READ-ONLY selector, used by list and show to view another session\'s task refs. Defaults to the current session. '
        + 'It does NOT set ownership: refs created or modified by this tool are always owned by the current session, and '
        + 'this field is ignored by create, status, depend, cancel, handoff, acknowledge and withdraw.',
    },
    taskId: { type: 'string', description: 'The task ref, chosen at create: required for create, show, status, depend and handoff; for cancel, the task to start from.' },
    title: { type: 'string', description: 'create: what the task is.' },
    label: { type: 'string', description: 'create: an optional short label.' },
    status: {
      type: 'string',
      enum: ['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'],
      description: 'create: the starting status (default queued). status: the status to move the task to; it is refused when the task cannot move there.',
    },
    dependsOnSessionId: { type: 'string', description: 'depend: the session that owns the task waited on (default this session).' },
    dependsOnTaskId: { type: 'string', description: 'depend: the task waited on.' },
    reason: { type: 'string', description: 'depend, cancel, handoff: why, recorded with the change.' },
    toSessionId: { type: 'string', description: 'handoff: the session the task is passed to.' },
    handoffId: {
      type: 'string',
      description: 'acknowledge: the handoff (from mode=handoffs) this session, its destination, accepts. withdraw: the handoff this session, its source, takes back.',
    },
    scope: {
      type: 'string',
      enum: ['task', 'subtree', 'session'],
      description: 'cancel: the task alone (the default), the task and every task that depends on it, or every task of this session.',
    },
  },
  required: ['mode'],
  additionalProperties: false,
} as const;

export type TaskToolInput = {
  mode: 'create' | 'list' | 'show' | 'status' | 'depend' | 'cancel' | 'handoff' | 'handoffs' | 'acknowledge' | 'withdraw';
  view?: 'summary' | 'full' | undefined;
  sessionId?: string | undefined;
  taskId?: string | undefined;
  title?: string | undefined;
  label?: string | undefined;
  status?: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled' | undefined;
  dependsOnSessionId?: string | undefined;
  dependsOnTaskId?: string | undefined;
  reason?: string | undefined;
  toSessionId?: string | undefined;
  handoffId?: string | undefined;
  scope?: 'task' | 'subtree' | 'session' | undefined;
};

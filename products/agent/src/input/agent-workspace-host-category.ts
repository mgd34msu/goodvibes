import type { AgentWorkspaceCategory } from './agent-workspace-types.ts';
import { actRow } from './agent-workspace-category-actions.ts';

export const AGENT_WORKSPACE_HOST_CATEGORY: AgentWorkspaceCategory = {
  id: 'host',
  group: 'OPERATIONS',
  label: 'Connected Host',
  summary: 'The connected host: its tasks, sessions, providers and sign-ins.',
  detail: 'Use this workspace to inspect the GoodVibes host surfaces that Agent can see: system health, remote routes, host tasks, sessions, channels, schedules, knowledge, media, MCP, provider auth, support bundles, and telemetry/config posture.',
  actions: [
    actRow('host-task-filter', 'work tasks'),
    actRow('host-task-show', 'work task'),
    actRow('host-task-output', 'work task-output'),
    actRow('host-session-graph', 'session graph'),
    actRow('host-provider-detail', 'accounts see-account'),
    actRow('host-provider-routes', 'accounts see-routes'),
    actRow('host-provider-repair', 'accounts fix-account'),
    actRow('host-auth-detail', 'auth see-sign-in'),
    actRow('host-auth-repair', 'auth fix-sign-in'),
    actRow('host-auth-bundle-export', 'auth save-summary'),
    actRow('host-auth-bundle-inspect', 'auth read-summary'),
    actRow('host-subscription-bundle-export', 'provider save-sign-ins'),
    actRow('host-subscription-bundle-inspect', 'provider check-sign-ins'),
    actRow('host-support-bundle-export', 'bundle save'),
    actRow('host-support-bundle-inspect', 'bundle check'),
    actRow('host-support-bundle-import', 'bundle load'),
    { id: 'host-safety', label: 'What the Agent does on the host', detail: 'The Agent reads the connected host and changes it only when you run a row here or ask; it never creates tasks, sends messages, changes sign-ins or starts schedules on its own.', kind: 'guidance', safety: 'blocked' },
  ],
};

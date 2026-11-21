/**
 * The gate's policy surface shared by the terminal apps: the functions the
 * `/permissions` command (terminal-shell/src/permissions-command.ts) calls, the
 * policy-bundle workflow `/security` runs, the Agent's read admission and
 * settings write wrappers, the state tool's read-only surface and the
 * execution ledger. The operator policy the Agent sends is in
 * terminal-shell/src/agent-turn/operator-policy.ts.
 */
export * from './permissions-provenance.js';
export * from './permissions-runtime.js';
export * from './policy-dispatch.js';
export * from './read-policy.js';
export * from './state-policy.js';
export * from './settings-write-policy.js';
export { agentSettingsWriteRefusal } from './agent-settings-refusals.js';
export * from './execution-ledger.js';
export * from './tool-permission-safety.js';

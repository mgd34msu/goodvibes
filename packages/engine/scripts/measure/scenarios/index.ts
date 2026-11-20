/** Every in-process scenario, by name, with the module that defines it (loaded only in the worker). */
import type { Scenario } from '../harness.ts';

type Loader = () => Promise<Scenario[]>;
const tools: Loader = async () => (await import('./tools.ts')).scenarios;
const stores: Loader = async () => (await import('./stores.ts')).scenarios;
const agent: Loader = async () => (await import('./agent.ts')).scenarios;
const inbound: Loader = async () => (await import('./inbound.ts')).scenarios;
const state: Loader = async () => (await import('./state.ts')).scenarios;
const mail: Loader = async () => (await import('./mail.ts')).scenarios;
const hosted: Loader = async () => (await import('./hosted.ts')).scenarios;
const find: Loader = async () => (await import('./find.ts')).scenarios;
const acknowledge: Loader = async () => (await import('./acknowledge.ts')).scenarios;

export interface ScenarioEntry {
  readonly name: string;
  readonly load: Loader;
  /** Scenario-specific counts (returned by its op) held to its budget like the standard counts: at or below the recorded figure. */
  readonly budgeted?: readonly string[];
  /** Scenario-specific byte totals held to its budget like bytes written: at most 10% above the recorded figure. */
  readonly budgetedBytes?: readonly string[];
}

export const SCENARIOS: readonly ScenarioEntry[] = [
  { name: 'tool-read', load: tools },
  { name: 'tool-exec-remembered', load: tools },
  { name: 'turn-0-tools', load: tools, budgeted: ['toolDefinitionsSent'], budgetedBytes: ['toolDefinitionBytesSent'] },
  { name: 'turn-12-tools', load: tools },
  { name: 'turn-8-reads', load: tools },
  { name: 'turn-8-slow-reads', load: tools },
  { name: 'permission-decision-10-rules', load: tools },
  { name: 'permission-decision-100-rules', load: tools },
  { name: 'find-content-first', load: find, budgeted: ['readdirs', 'stats'] },
  { name: 'find-content-repeat', load: find, budgeted: ['readdirs', 'stats'] },
  { name: 'find-content-repeat-ripgrep', load: find, budgeted: ['readdirs', 'stats'] },
  { name: 'find-content-after-edit', load: find, budgeted: ['readdirs', 'stats'] },
  { name: 'find-files-first', load: find, budgeted: ['readdirs', 'stats'] },
  { name: 'find-files-repeat', load: find, budgeted: ['readdirs', 'stats'] },
  { name: 'session-heartbeat', load: stores },
  { name: 'session-append-message', load: stores },
  { name: 'knowledge-list-200', load: stores },
  { name: 'knowledge-search-200', load: stores },
  { name: 'knowledge-search-200-repeat', load: stores },
  { name: 'memory-add', load: stores },
  { name: 'inbound-message', load: inbound },
  { name: 'inbound-email-store', load: stores },
  { name: 'config-get', load: stores },
  { name: 'config-set', load: stores },
  { name: 'agent-route-plan', load: agent },
  { name: 'agent-catalog-search', load: agent },
  { name: 'contract-save-100-files', load: state },
  { name: 'contract-save-5000-files', load: state },
  { name: 'owner-inbox-question-answer', load: state },
  { name: 'work-plan-edit-200', load: state },
  { name: 'config-set-5-keys', load: state },
  { name: 'mailbox-poll-nothing-new', load: mail, budgeted: ['imapCommands', 'imapLogins', 'imapConnections'] },
  { name: 'companion-message-post', load: acknowledge },
  { name: 'channel-reply-final', load: acknowledge, budgeted: ['fixtureRequests'] },
  { name: 'automation-run-settle', load: acknowledge, budgeted: ['fixtureRequests'] },
  { name: 'approval-raise-answer', load: acknowledge },
  { name: 'hosted-agent-request', load: hosted, budgeted: ['toolDefinitionsSent', 'toolDefinitionsWithParameters'], budgetedBytes: ['toolDefinitionBytesSent'] },
];

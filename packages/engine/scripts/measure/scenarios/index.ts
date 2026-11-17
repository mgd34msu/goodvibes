/** Every in-process scenario, by name, with the module that defines it (loaded only in the worker). */
import type { Scenario } from '../harness.ts';

type Loader = () => Promise<Scenario[]>;
const tools: Loader = async () => (await import('./tools.ts')).scenarios;
const stores: Loader = async () => (await import('./stores.ts')).scenarios;
const agent: Loader = async () => (await import('./agent.ts')).scenarios;
const inbound: Loader = async () => (await import('./inbound.ts')).scenarios;

export const SCENARIOS: ReadonlyArray<{ readonly name: string; readonly load: Loader }> = [
  { name: 'tool-read', load: tools },
  { name: 'tool-exec-remembered', load: tools },
  { name: 'turn-0-tools', load: tools },
  { name: 'turn-12-tools', load: tools },
  { name: 'turn-8-reads', load: tools },
  { name: 'turn-8-slow-reads', load: tools },
  { name: 'permission-decision-10-rules', load: tools },
  { name: 'permission-decision-100-rules', load: tools },
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
];

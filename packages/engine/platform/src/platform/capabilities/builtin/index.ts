/**
 * The capabilities that have moved beside their handlers, with the command
 * each still answers to as a slash command. Home `daemon` ones run in the
 * daemon (routes/capabilities.ts); home `session` ones in the program
 * holding the conversation.
 */
import { entryOfDefinition, type CapabilityEntry } from '../catalog.js';
import type { CapabilityDefinition } from '../types.js';
import { CONVERSATION_CLEAR, CONVERSATION_COMPACT, CONVERSATION_UNDO } from './conversation.js';
import { HOOKS_CONTRACTS, HOOKS_DISABLE, HOOKS_ENABLE, type HooksCapabilityServices } from './hooks.js';
import { KEYS_BIND, KEYS_RESET, KEYS_RESET_ALL } from './keys.js';
import { MEMORY_EXPLAIN, type MemoryCapabilityServices } from './memory.js';
import { SECRETS_SET, type SecretsCapabilityServices } from './secrets.js';

export * from './conversation.js';
export * from './hooks.js';
export * from './keys.js';
export * from './memory.js';
export * from './secrets.js';

/** What the daemon hands the capabilities that run there. */
export type DaemonCapabilityServices = HooksCapabilityServices & SecretsCapabilityServices & MemoryCapabilityServices;

interface Moved<Services> {
  readonly definition: CapabilityDefinition<Services>;
  readonly command: { readonly name: string; readonly title: string };
}

const HOOKS = { name: 'hooks', title: 'Hooks' };
const SECRETS = { name: 'secrets', title: 'Secrets' };
const MEMORY = { name: 'memory', title: 'Memory' };
const KEYS = { name: 'keys', title: 'Keys' };

export const DAEMON_CAPABILITIES: readonly Moved<DaemonCapabilityServices>[] = [
  { definition: HOOKS_CONTRACTS, command: HOOKS },
  { definition: HOOKS_ENABLE, command: HOOKS },
  { definition: HOOKS_DISABLE, command: HOOKS },
  { definition: SECRETS_SET, command: SECRETS },
  { definition: MEMORY_EXPLAIN, command: MEMORY },
];

export const SESSION_CAPABILITIES: readonly Moved<never>[] = [
  { definition: CONVERSATION_CLEAR as CapabilityDefinition<never>, command: { name: 'clear', title: 'Start a fresh conversation' } },
  { definition: CONVERSATION_COMPACT as CapabilityDefinition<never>, command: { name: 'compact', title: 'Compact the conversation' } },
  { definition: CONVERSATION_UNDO as CapabilityDefinition<never>, command: { name: 'undo', title: 'Undo' } },
  // The program's key table (builtin/keys.ts): the Keys place and the model run these; no slash command carries them.
  { definition: KEYS_BIND as CapabilityDefinition<never>, command: KEYS },
  { definition: KEYS_RESET as CapabilityDefinition<never>, command: KEYS },
  { definition: KEYS_RESET_ALL as CapabilityDefinition<never>, command: KEYS },
];

/** A moved daemon capability by id. */
export function daemonCapability(id: string): CapabilityDefinition<DaemonCapabilityServices> | undefined {
  return DAEMON_CAPABILITIES.find((moved) => moved.definition.capability.id === id)?.definition;
}

/** The catalog entries of every moved capability. */
export function movedCapabilityEntries(): readonly CapabilityEntry[] {
  return [...DAEMON_CAPABILITIES, ...SESSION_CAPABILITIES].map((moved) => entryOfDefinition(moved.definition as CapabilityDefinition<never>, moved.command));
}

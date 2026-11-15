import type { QueryClient } from '@tanstack/react-query';
import type { ClientLifetime } from '../lib/client-lifetime';

/**
 * One user intent (close a session, cancel a contract) kept per account
 * lifetime and target, so closing and reopening a pane neither starts a second
 * flight nor discards an unknown outcome. Neither keys nor values hold
 * credentials, and weak lifetime keys retire the receipts with the account.
 */
export interface ActionIntent<S extends object> {
  snapshot: S;
  listeners: Set<() => void>;
  abort?: AbortController | undefined;
}

export interface ActionIntentStore<S extends object> {
  intentFor(client: QueryClient, lifetime: ClientLifetime, id: string): ActionIntent<S>;
  /** Merge a change into the snapshot and notify subscribers. */
  update(intent: ActionIntent<S>, value: Partial<S>): void;
  /** The `useSyncExternalStore` pair for one intent. */
  store(intent: ActionIntent<S>): { subscribe: (listener: () => void) => () => void; read: () => S };
}

export function createActionIntent<S extends object>(initial: () => S): ActionIntentStore<S> {
  const clients = new WeakMap<QueryClient, WeakMap<ClientLifetime, Map<string, ActionIntent<S>>>>();
  return {
    intentFor(client, lifetime, id) {
      let scopes = clients.get(client);
      if (!scopes) { scopes = new WeakMap(); clients.set(client, scopes); }
      let intents = scopes.get(lifetime);
      if (!intents) { intents = new Map(); scopes.set(lifetime, intents); }
      let intent = intents.get(id);
      if (!intent) { intent = { snapshot: initial(), listeners: new Set() }; intents.set(id, intent); }
      return intent;
    },
    update(intent, value) {
      intent.snapshot = { ...intent.snapshot, ...value };
      for (const listener of intent.listeners) listener();
    },
    store(intent) {
      return {
        subscribe: (listener) => { intent.listeners.add(listener); return () => { intent.listeners.delete(listener); }; },
        read: () => intent.snapshot,
      };
    },
  };
}

/**
 * method-catalog-flags-status.ts
 *
 * The flags.status descriptor: which restart-gated features run in a state
 * other than their saved setting. config.get answers with saved values only,
 * so this is the one place a client learns what the daemon is running.
 * ws-only invoke verb (no REST binding, so no gateway-rest-routes parity
 * entry). Handler: routes/flags-status.ts, registered by the daemon, which owns
 * the feature gate manager.
 */
import { methodDescriptor } from './method-catalog-shared.js';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  FLAGS_STATUS_INPUT_SCHEMA,
  FLAGS_STATUS_OUTPUT_SCHEMA,
} from './operator-contract-schemas-flags-status.js';

export const builtinGatewayFlagsStatusMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'flags.status',
    title: 'Feature Restart Status',
    description:
      'Return the features whose saved setting the running daemon has not applied yet. A feature that only changes at daemon start keeps its running state when its setting is saved; each entry names the feature id (the id settings surfaces render), the state it is running in and the saved state that takes effect at the next daemon restart. An empty list means every feature runs as saved. config.get returns saved values only; read this beside it to learn what is running.',
    category: 'flags',
    scopes: ['read:config'],
    access: 'admin',
    transport: ['ws'],
    inputSchema: FLAGS_STATUS_INPUT_SCHEMA,
    outputSchema: FLAGS_STATUS_OUTPUT_SCHEMA,
  }),
];

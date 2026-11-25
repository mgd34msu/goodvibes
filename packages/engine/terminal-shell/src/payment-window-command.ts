/**
 * What a terminal program supplies to reach the daemon it is paired with as
 * its owner: the context a command runs in and the host-selection policy. The
 * Telegram cursor review (telegram-cursor-command.ts) takes them. Money is a
 * place of the daemon's capabilities (places/money-place.ts), with no slash
 * command. The purchases waiting for an answer are
 * Waiting for you's Purchases tab (platform capabilities/builtin/purchases.ts),
 * run through the daemon's `capabilities.run`.
 */
import type { ConcealedInputRequest } from './concealed-input.js';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { OwnedSelectionObservation } from '@goodvibes/engine/platform/platform/runtime/client';
import type { RetainedOperatorConnectionPolicy, SelectedOperatorConnection } from './retained-operator-connection.js';
import type { OpenSelection } from './selection-modal.js';

export interface PaymentWindowCommandContext {
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
  readonly openSelection?: OpenSelection;
  /** One masked composer line. */
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
}
export interface PaymentWindowCommandPolicy<Context> {
  readonly isOwner: (context: Context) => boolean;
  readonly owner: (context: Context) => ConfigManager;
  readonly home: (context: Context) => string;
  readonly read: (context: Context, observation: OwnedSelectionObservation) => SelectedOperatorConnection | null;
  readonly files: (selection: SelectedOperatorConnection, home: string) => readonly string[];
  readonly environment?: RetainedOperatorConnectionPolicy['environment'];
  readonly fetchImpl?: RetainedOperatorConnectionPolicy['fetchImpl'];
}

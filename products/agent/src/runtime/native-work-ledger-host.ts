import { createBoundNativeWorkLedgerView } from '@goodvibes/engine/terminal-shell/native/bound-work-ledger-host';
import { AGENT_NATIVE_INTAKE_POLICY } from '@goodvibes/engine/terminal-shell/native-intake';
export {
  discoverNativeLedgerProject,
  type NativeLedgerHost,
} from '@goodvibes/engine/terminal-shell/native/bound-work-ledger-host';
/**
 * Agent admits hosted turns but never selected-diff execution, and preserves
 * paired journal identities.
 */
export const createNativeWorkLedgerView = (
  resolve: Parameters<typeof createBoundNativeWorkLedgerView>[0],
  discover?: Parameters<typeof createBoundNativeWorkLedgerView>[2],
  bindSubmission?: Parameters<typeof createBoundNativeWorkLedgerView>[3],
) =>
  createBoundNativeWorkLedgerView(
    resolve,
    { identityFormat: 'paired', intake: AGENT_NATIVE_INTAKE_POLICY },
    discover,
    bindSubmission,
  );

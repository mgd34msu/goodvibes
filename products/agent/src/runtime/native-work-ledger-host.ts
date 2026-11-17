import { createBoundNativeWorkLedgerView } from '@goodvibes-jev/engine/terminal-shell/native/bound-work-ledger-host';
import { AGENT_NATIVE_INTAKE_POLICY } from '@goodvibes-jev/engine/terminal-shell/native-intake';
export {
  createNativeLedgerBinding,
  discoverNativeLedgerProject,
  type NativeLedgerHost,
  type NativeLedgerBindingFactory,
} from '@goodvibes-jev/engine/terminal-shell/native/bound-work-ledger-host';
/**
 * Agent admits hosted turns but never selected-diff execution, and preserves
 * paired journal identities.
 */
export const createNativeWorkLedgerView = (
  resolve: Parameters<typeof createBoundNativeWorkLedgerView>[0],
  changed: Parameters<typeof createBoundNativeWorkLedgerView>[1],
  bind?: Parameters<typeof createBoundNativeWorkLedgerView>[3],
  discover?: Parameters<typeof createBoundNativeWorkLedgerView>[4],
  bindSubmission?: Parameters<typeof createBoundNativeWorkLedgerView>[5],
) =>
  createBoundNativeWorkLedgerView(
    resolve,
    changed,
    { identityFormat: 'paired', intake: AGENT_NATIVE_INTAKE_POLICY },
    bind,
    discover,
    bindSubmission,
  );

import { createBoundNativeWorkLedgerView } from '@goodvibes-jev/engine/terminal-shell/native/bound-work-ledger-host';
export {
  createNativeLedgerBinding,
  discoverNativeLedgerProject,
  type NativeLedgerHost,
  type NativeLedgerBindingFactory,
} from '@goodvibes-jev/engine/terminal-shell/native/bound-work-ledger-host';
/**
 * Agent admits hosted turns but never selected-diff execution, and preserves
 * paired journal identities. `prepare` runs before discovery while the host
 * has no credential (the automatic pairing with a daemon on this machine).
 */
export const createNativeWorkLedgerView = (
  resolve: Parameters<typeof createBoundNativeWorkLedgerView>[0],
  changed: Parameters<typeof createBoundNativeWorkLedgerView>[1],
  bind?: Parameters<typeof createBoundNativeWorkLedgerView>[3],
  discover?: Parameters<typeof createBoundNativeWorkLedgerView>[4],
  bindSubmission?: Parameters<typeof createBoundNativeWorkLedgerView>[5],
  prepare?: () => Promise<void>,
) =>
  createBoundNativeWorkLedgerView(
    resolve,
    changed,
    { identityFormat: 'paired', intake: { allowHosted: true, allowSelectedDiff: false }, prepare },
    bind,
    discover,
    bindSubmission,
  );

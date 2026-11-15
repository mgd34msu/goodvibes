/** The startup typeahead gate lives in the shared terminal package, beside the approval card's use of the same rule. */
export {
  TYPEAHEAD_BURST_GAP_MS,
  TYPEAHEAD_SETTLE_MS,
  createStartupTypeaheadGate,
  type StartupTypeaheadGate,
  type StartupTypeaheadGateOptions,
} from '@goodvibes-jev/engine/terminal-shell/blocking-permission-input';

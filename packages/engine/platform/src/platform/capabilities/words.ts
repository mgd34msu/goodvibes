/**
 * The capability words every surface reads, the web UI's browser bundle
 * included: the risk, lifetime and done words, the sentence filled from its
 * values, an action's risk with its chosen values, and the method input its
 * fields make. Nothing here reaches a Node module, so a browser may load it.
 */
export { LASTS_WORDS, REPLACED_DONE, RISK_DONE_WORDS, RISK_WORDS } from './types.js';
export type { ActionLasts, ActionRisk, ActionTouches, ActionValues, FixedChoice, InputDescription, InputKind, ListChoices, ListName } from './types.js';
export { fillSentence, lastsWords, riskDoneLine } from './outcome.js';
export { operatorInputFromValues } from './operator-input.js';
export { effectiveRisk } from './risk.js';
// The fourteen function groups and the id rule, for the web UI's places and its find (one definition).
export { CAPABILITY_GROUPS, CAPABILITY_GROUP_IDS, isCapabilityGroupId, type CapabilityGroupId } from './groups.js';
export { capabilityGroupOf, capabilityIdOf } from './command-groups.js';

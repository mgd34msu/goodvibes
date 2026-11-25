/**
 * Capabilities: everything a person, a model or a script can have GoodVibes
 * do, defined once (types.ts), placed in one of fourteen function groups
 * (groups.ts), found by need (find.ts) and run where it lives: the daemon
 * (`capabilities.run`, control-plane/routes/capabilities.ts) or the program
 * holding the conversation.
 */
export * from './types.js';
export * from './groups.js';
export { capabilityGroupOf, capabilityIdOf } from './command-groups.js';
export {
  CapabilityCatalog, capabilityEffects, capabilityReads, effectiveRisk, entryOfDefinition, modelNeverRuns, OWNER_DECIDED_EFFECTS, ownerDecidesForModel, withDefaults,
  type CapabilityEntry, type CapabilityEntryHome, type CatalogActionSource, type CatalogCommandSource,
} from './catalog.js';
export { checkCapabilityInputs, type CapabilityInputCheck } from './validate.js';
export { capabilityOutcomeText, fillSentence, hiddenSecret, lastsWords, shownValues } from './outcome.js';
export { methodBodyOf, operatorInputFromValues, type CapabilityMethod } from './operator-input.js';
export {
  capabilityGroupSelection, findCapabilities, foundCapability, readCapabilityGroup,
  type CapabilityFindResult, type CapabilityGroupReading, type FoundCapability,
} from './find.js';
export * from './builtin/index.js';
export { daemonCapabilityCatalog, loadedDaemonCapabilityCatalog, preloadDaemonCapabilityCatalog } from './daemon-catalog.js';
export { createDaemonCapabilityServices, type DaemonCapabilityServiceSources } from './daemon-services.js';
export {
  CAPABILITY_FIND_METHOD_ID, CAPABILITY_METHOD_IDS, CAPABILITY_RUN_METHOD_ID, builtinGatewayCapabilityMethodDescriptors,
} from '../control-plane/method-catalog-capabilities.js';
export {
  CAPABILITY_FIND_TOOL, CAPABILITY_RUN_TOOL, capabilityFindDefinition, capabilityRunDefinition, type CapabilityRunMethodDeclarations,
} from '../tools/capability/definitions.js';
export { createSecretInputProjector, revealSecretInputs } from '../tools/capability/secret-inputs.js';

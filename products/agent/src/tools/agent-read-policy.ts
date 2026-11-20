/** Agent read surface: the engine owns the admission check. */
export {
  AGENT_READ_ADMISSION_DENIAL_MESSAGE,
  wrapReadToolForAdmittedAgentPolicy as wrapReadToolForAgentPolicy,
} from '@goodvibes/engine/platform/platform/gate/policy';

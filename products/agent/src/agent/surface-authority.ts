/**
 * surface-authority.ts, which surfaces can tell the agent what to do.
 *
 * The table and every rule over it live in the engine gate
 * (`@goodvibes/engine/platform/platform/gate`), the module the runtime
 * boundary actually consults. This file only re-exports it, so the agent's
 * rendering of "command authority" for the model can never disagree with what
 * the gate will let a surface confirm. A surface is added, or moved between
 * categories, in the engine table and nowhere else.
 */
export {
  DEFAULT_SURFACE_COMMAND_AUTHORITY,
  assertCanConfirm,
  effectPermittedForProvenance,
  listCommandAuthoritySurfaces,
  listDeclaredSurfaces,
  normalizeSurfaceId,
  surfaceAuthority,
  surfaceCarriesCommandAuthority,
  surfaceRequestsReachOwner,
  type ActingProvenance,
  type AgentEffect,
  type ConfirmationAuthorityDecision,
  type EffectDecision,
  type SurfaceCommandAuthority,
} from '@goodvibes/engine/platform/platform/gate';

export type {
  AuthenticatedPrincipal,
  AuthenticatedPrincipalKind,
  AuthenticatedPrincipalResolver,
  CredentialKind,
  ElevatedPrivateHostFetchConfig,
  PrivateHostFetchConfig,
  RequestContext,
  RequestPrincipal,
} from '@goodvibes-jev/engine/daemon-api';
export {
  buildMissingScopeBody,
  principalHasScope,
  resolveAuthenticatedPrincipal,
  resolvePrivateHostFetchOptions,
} from '@goodvibes-jev/engine/daemon-api';

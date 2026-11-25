/** Private bridge across the runtime/server construction order; no authority escapes. */
import type { GatewayMethodCatalog } from '@goodvibes/engine/platform/platform/control-plane';
import type { DaemonHostedSessionsOptions } from '@goodvibes/engine/platform/platform/daemon';
type Owner = NonNullable<DaemonHostedSessionsOptions['nativeConversation']>;
/** Every other project's native turns: the routed catalog and that project's turn dependencies. */
type Projects = NonNullable<DaemonHostedSessionsOptions['nativeConversationProjects']>;
const owners = new WeakMap<GatewayMethodCatalog, Owner>();
const projectOwners = new WeakMap<GatewayMethodCatalog, Projects>();
export function installNativeHostedConversationOwner(catalog: GatewayMethodCatalog, owner: Owner, projects?: Projects): () => void {
  if (owners.has(catalog)) throw new Error('Native hosted conversation owner already installed');
  owners.set(catalog, owner);
  if (projects) projectOwners.set(catalog, projects);
  return () => { owners.delete(catalog); projectOwners.delete(catalog); };
}
export function nativeHostedConversationOwner(catalog: GatewayMethodCatalog): Owner | undefined { return owners.get(catalog); }
export function nativeHostedConversationProjects(catalog: GatewayMethodCatalog): Projects | undefined { return projectOwners.get(catalog); }

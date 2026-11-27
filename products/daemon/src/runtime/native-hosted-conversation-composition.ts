/** Private bridge across the runtime/server construction order; no authority escapes. */
import type { GatewayMethodCatalog } from '@goodvibes/engine/platform/platform/control-plane';
import type { DaemonHostedSessionsOptions } from '@goodvibes/engine/platform/platform/daemon';
type Owner = NonNullable<DaemonHostedSessionsOptions['nativeConversation']>;
/** Each project's native turns: the routed catalog and that project's turn dependencies. */
type Projects = NonNullable<DaemonHostedSessionsOptions['nativeConversationProjects']>;
const projectOwners = new WeakMap<GatewayMethodCatalog, Projects>();
/** The daemon's own folder is no project and has no native turns of its own: every native turn is a project's. */
export function installNativeHostedConversationProjects(catalog: GatewayMethodCatalog, projects: Projects): () => void {
  if (projectOwners.has(catalog)) throw new Error('Native hosted conversation projects already installed');
  projectOwners.set(catalog, projects);
  return () => { projectOwners.delete(catalog); };
}
export function nativeHostedConversationProjects(catalog: GatewayMethodCatalog): Projects | undefined { return projectOwners.get(catalog); }
/** One project's native turn dependencies, as `Projects.forProject` gives them (with the turn host's adoption). */
export type NativeHostedProjectOwner = Owner & ReturnType<Projects['forProject']>;

import { prepareConfiguredProjectContext } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { createRuntimeServices, type RuntimeServices, type RuntimeServicesOptions } from '../../runtime/services.ts';

/** Perform the same explicit project activation as Agent bootstrap, on the fixture's real owner. */
export async function createPreparedAgentRuntimeServices(options: RuntimeServicesOptions): Promise<RuntimeServices> {
  await prepareConfiguredProjectContext(options.configManager, options.workingDir, 'knowledge-agent.sqlite', { activate: true });
  return createRuntimeServices(options);
}

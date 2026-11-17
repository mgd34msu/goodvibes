import type { ForensicsRegistry } from './forensics/index.js';
import type { PolicyRuntimeState } from './permissions/policy-runtime.js';
import type { MemoryRegistry } from '../state/memory-store.js';
import type { IntegrationHelperService } from './integration/helpers.js';
import type { KnowledgeService } from '../knowledge/index.js';
import type { PluginManager } from '../plugins/manager.js';
import type { HookWorkbench } from '../hooks/workbench.js';

export interface CommandExtensionShellServices {
  readonly forensicsRegistry?: ForensicsRegistry | undefined;
  readonly policyRuntimeState?: PolicyRuntimeState | undefined;
  readonly memoryRegistry?: MemoryRegistry | undefined;
  readonly integrationHelpers?: IntegrationHelperService | undefined;
  readonly knowledgeService?: KnowledgeService | undefined;
  readonly pluginManager?: PluginManager | undefined;
  readonly hookWorkbench?: HookWorkbench | undefined;
}

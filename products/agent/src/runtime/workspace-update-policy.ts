import manifest from '../../package.json';
import { workspaceProductUpdatePolicy } from '@goodvibes-jev/engine/platform/platform/utils/product-identity';
export const { isWorkspaceDistribution: IS_WORKSPACE_DISTRIBUTION, rebuildCommand: WORKSPACE_REBUILD_COMMAND, guidance: WORKSPACE_UPDATE_GUIDANCE } = workspaceProductUpdatePolicy(manifest, '@goodvibes-jev/agent', 'Agent');

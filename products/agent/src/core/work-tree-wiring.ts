import { wireWorkTree as wire, type WorkTreeWiringDeps } from '@goodvibes/engine/terminal-shell/work-tree-wiring';
export * from '@goodvibes/engine/terminal-shell/work-tree-wiring';
export const wireWorkTree = (deps: WorkTreeWiringDeps) => wire({ ...deps, includeContractOnlyAgents: true });

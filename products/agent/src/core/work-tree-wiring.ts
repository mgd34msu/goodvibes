import { wireWorkTree as wire, type WorkTreeWiringDeps } from '@goodvibes-jev/engine/terminal-shell/work-tree-wiring';
export * from '@goodvibes-jev/engine/terminal-shell/work-tree-wiring';
export const wireWorkTree = (deps: WorkTreeWiringDeps) => wire({ ...deps, includeContractOnlyAgents: true });

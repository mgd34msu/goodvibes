import { projectContractTree as project } from '@goodvibes-jev/engine/terminal-shell/work-tree-contract';
export * from '@goodvibes-jev/engine/terminal-shell/work-tree-contract';
export const projectContractTree = (contract: Parameters<typeof project>[0]) => project(contract, true);

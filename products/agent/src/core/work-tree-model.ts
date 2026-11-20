import { createWorkTreeModelAdapter } from '@goodvibes/engine/terminal-shell/work-tree-model';
export * from '@goodvibes/engine/terminal-shell/work-tree-model';
const adapter = createWorkTreeModelAdapter({ showUnverifiedOutput: true });
export const { buildTurnModel, buildContractOwnerModel } = adapter;

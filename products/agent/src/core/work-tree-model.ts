import { createWorkTreeModelAdapter } from '@goodvibes-jev/engine/terminal-shell/work-tree-model';
import { friendlyToolLabel } from '../renderer/tool-labels.ts';
export * from '@goodvibes-jev/engine/terminal-shell/work-tree-model';
const adapter = createWorkTreeModelAdapter({ toolLabel: friendlyToolLabel, showUnverifiedOutput: true });
export const { buildTurnModel, buildContractOwnerModel } = adapter;

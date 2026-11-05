import { renderTurn as paint, renderStreamingContinuation as stream, type TurnRenderOptions, type TurnRender } from '@goodvibes-jev/engine/terminal-shell/work-tree-render';
import type { TurnModel } from '@goodvibes-jev/engine/terminal-shell/work-tree-model';
import type { TreeGlyphSetName } from '@goodvibes-jev/engine/terminal-shell/lane-graph';
export * from '@goodvibes-jev/engine/terminal-shell/work-tree-render';
export const renderTurn = (model: TurnModel, options: TurnRenderOptions) => paint(model, options, { paragraphSpacing: false, systemAccent: 'info' });
export const renderStreamingContinuation = (content: string, width: number, tail: TurnRender['tail'], glyphs: TreeGlyphSetName) => stream(content, width, tail, glyphs, false);

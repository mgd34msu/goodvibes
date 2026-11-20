import { renderSystemMessage as paint, type SystemMessageType } from '@goodvibes/engine/terminal-shell/system-message';
export * from '@goodvibes/engine/terminal-shell/system-message';
export const renderSystemMessage = (content: string, width: number, type?: SystemMessageType) => paint(content, width, type, 'info');

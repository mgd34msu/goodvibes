import { handleWorkTreeToken as handle, type WorkTreeRouteState as PlatformState } from '@goodvibes-jev/engine/terminal-shell/work-tree-input';
import type { ConversationManager } from '../core/conversation.ts';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { handleBlockCopy } from './handler-content-actions.ts';
export type WorkTreeRouteState = PlatformState<ConversationManager>;
export const handleWorkTreeToken = (state: WorkTreeRouteState, token: InputToken) => handle(state, token, handleBlockCopy);

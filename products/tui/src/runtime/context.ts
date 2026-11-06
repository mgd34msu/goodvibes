import type { TerminalRuntimeContext, BootstrapOptions as PlatformBootstrapOptions } from '@goodvibes-jev/engine/terminal-shell/runtime-context';
import type { RuntimeServices } from './services.ts';
import type { ConversationManager } from '../core/conversation.ts';
export type RuntimeContext = TerminalRuntimeContext<RuntimeServices, ConversationManager>;
export type BootstrapOptions = PlatformBootstrapOptions;

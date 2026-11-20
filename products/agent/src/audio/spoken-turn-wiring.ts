import { wireSpokenTurnRuntime as wire, type WireSpokenTurnRuntimeOptions } from '@goodvibes/engine/terminal-shell/spoken-turn-wiring';
export * from '@goodvibes/engine/terminal-shell/spoken-turn-wiring';
export const wireSpokenTurnRuntime = (options: WireSpokenTurnRuntimeOptions) => wire(options, 'goodvibes-agent');

import { wireSpokenTurnRuntime as wire, type WireSpokenTurnRuntimeOptions } from '@goodvibes-jev/engine/terminal-shell/spoken-turn-wiring';
export * from '@goodvibes-jev/engine/terminal-shell/spoken-turn-wiring';
export const wireSpokenTurnRuntime = (options: WireSpokenTurnRuntimeOptions) => wire(options, 'goodvibes-tui');

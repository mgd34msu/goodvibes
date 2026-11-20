import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { UiRuntimeEvents } from '@goodvibes/engine/platform/platform/runtime/ui';
import type { VoiceService } from '@goodvibes/engine/platform/platform/voice';
import type { StreamingAudioPlayer } from './player.js';
import { sharedStreamingAudioPlayer } from './player.js';
import { SpokenTurnController } from '@goodvibes/engine/platform/platform/voice';
export interface SpokenTurnRuntime {
    readonly unsubs: readonly (() => void)[];
    /** Returns whether speech was actually active (see controller.stop). */
    stop(message?: string | undefined): boolean;
    /** Exit-path stop: lets the audio already playing drain, bounded (see controller.stopForExit). */
    stopForExit(drainTimeoutMs?: number | undefined): Promise<void>;
}
export interface WireSpokenTurnRuntimeOptions {
    readonly voiceService: Pick<VoiceService, 'synthesizeStream'>;
    /** `subscribe`, when present, lets a `tts.*` setting change stop the reply being spoken. */
    readonly configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'subscribe'>>;
    readonly events: UiRuntimeEvents;
    readonly notify: (message: string) => void;
    /**
     * Optional player factory, injected in tests to avoid spawning real
     * subprocesses. Defaults to the process's one terminal player, the same
     * one the wake chime uses, so a stop or quit cuts both.
     */
    readonly playerFactory?: (() => StreamingAudioPlayer) | undefined;
    /** Injectable timers for the synthesis retry backoff, so tests do not wait in real time. */
    readonly setTimeout?: typeof setTimeout | undefined;
    readonly clearTimeout?: typeof clearTimeout | undefined;
}
/**
 * wireSpokenTurnRuntime, wires the spoken-turn pipeline against the runtime
 * event bus.
 *
 * A turn is spoken when its own origin asks for speech (a /voice speak prompt or a
 * spoken prompt), or, in always-speak mode (`ui.voiceEnabled`), every turn.
 * The availability check inside SpokenTurnController still gates gracefully
 * when no player is found.
 */
export function wireSpokenTurnRuntime(options: WireSpokenTurnRuntimeOptions, source: string): SpokenTurnRuntime {
    const player = options.playerFactory ? options.playerFactory() : sharedStreamingAudioPlayer();
    // The terminal platform's subprocess-based player already satisfies the platform's AudioSink
    // interface unchanged (see docs/decisions/2026-07-06-spoken-turn-tts-policy-platform-hoist.md
    // in the platform repo), only the option name (`sink` not `player`) and the
    // attribution `source` are new.
    const controller = new SpokenTurnController({
        voiceService: options.voiceService,
        configManager: options.configManager,
        speakAllTurns: () => Boolean(options.configManager.get('ui.voiceEnabled')),
        sink: player,
        source,
        notify: options.notify,
        ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
        ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
    });
    const turns = options.events.turns;
    const unsubs = [
        turns.on('TURN_SUBMITTED', (event) => { void controller.handleTurnEvent(event); }),
        turns.on('PREFLIGHT_FAIL', (event) => { void controller.handleTurnEvent(event); }),
        turns.on('STREAM_DELTA', (event) => { void controller.handleTurnEvent(event); }),
        turns.on('DRAFT_WITHDRAWN', (event) => { void controller.handleTurnEvent(event); }),
        turns.on('STREAM_END', (event) => { void controller.handleTurnEvent(event); }),
        turns.on('TURN_COMPLETED', (event) => { void controller.handleTurnEvent(event); }),
        turns.on('TURN_ERROR', (event) => { void controller.handleTurnEvent(event); }),
        turns.on('TURN_CANCEL', (event) => { void controller.handleTurnEvent(event); }),
    ];
    return {
        unsubs,
        stop: (message) => controller.stop(message),
        stopForExit: (drainTimeoutMs) => controller.stopForExit(drainTimeoutMs),
    };
}

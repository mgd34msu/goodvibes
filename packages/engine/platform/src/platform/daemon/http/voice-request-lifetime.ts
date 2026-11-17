import { LOCAL_VOICE_RUN_TIMEOUT_MS } from '../../voice/providers/local.js';

/** Speech verbs that answer only once the whole clip is synthesized or transcribed. */
const VOICE_WORK_METHODS: ReadonlySet<string> = new Set(['voice.stt', 'voice.tts']);
const VOICE_WORK_PATHS: ReadonlySet<string> = new Set(['/api/voice/stt', '/api/voice/tts']);
const INVOKE_PATH = /^\/api\/control-plane\/methods\/([^/]+)\/invoke$/;

/**
 * The listener's idle limit is sized for event streams (about 35 s), and a
 * request that sends no byte for that long has its socket closed while the
 * work behind it goes on. Transcribing or synthesizing a long clip with the
 * local engine can take up to that engine's own run limit, so these requests
 * get that limit plus a margin for decoding and the answer. Bun caps the value
 * at 255 seconds. Every other request keeps the listener's limit.
 */
export const VOICE_REQUEST_LIFETIME_SECONDS = Math.min(255, Math.ceil(LOCAL_VOICE_RUN_TIMEOUT_MS / 1_000) + 30);

export function configureVoiceRequestLifetime(request: Request, server: { timeout?(request: Request, seconds: number): void }): void {
  if (request.method !== 'POST') return;
  const { pathname } = new URL(request.url);
  const invoked = INVOKE_PATH.exec(pathname)?.[1];
  const isVoiceWork = VOICE_WORK_PATHS.has(pathname)
    || (invoked !== undefined && VOICE_WORK_METHODS.has(invoked.replace(/%2E/gi, '.')));
  if (isVoiceWork) server.timeout?.(request, VOICE_REQUEST_LIFETIME_SECONDS);
}

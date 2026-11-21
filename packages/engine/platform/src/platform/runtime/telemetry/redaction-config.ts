/**
 * Telemetry prompt/response redaction configuration.
 *
 * Privacy model (what actually ships):
 *
 * - RuntimeEventBus carries raw prompt/response strings. In-process
 *   consumers (conversation reducer, channel reply pipeline, stream UI)
 *   require raw content to render and advance state.
 *
 * - TelemetryApiService ring buffer stores raw payloads.
 *
 * - Egress boundary: `listEvents({view: 'safe'})` (the default) runs records
 *   and spans through `sanitizeRecord` / `sanitizeSpan`, which apply the
 *   field classes in `event-content.ts`, declared for every event field:
 *   content fields (prompts, streamed chunks, tool arguments and output,
 *   bodies, goals, plan titles, progress prose) are withheld, credential and
 *   owner-profile fields are withheld whole, and everything else (tool,
 *   provider, model, ids, statuses, counts, error text) is shown with
 *   credential-shaped text masked.
 *
 * - Raw reads require the serving TelemetryApiService's live
 *   `telemetry.includeRawPrompts` opt-in. The HTTP boundary additionally
 *   requires `admin` or `read:telemetry-sensitive`, plus `read:telemetry`.
 *   Disabled raw reads fail with TELEMETRY_RAW_DISABLED; they never fall back
 *   to safe data labeled as raw. Raw SSE streams recheck the opt-in before
 *   every event and heartbeat and terminate when it is revoked.
 *
 * This module only words the opt-in warning; the daemon logs it at start and
 * each time the setting is turned on. DaemonHttpRouter gives each service a
 * getter for its own config manager, and a service constructed without an
 * owning config getter disables raw reads.
 */
import { logger } from '../../utils/logger.js';

/** Log that the raw-prompt opt-in is on, so an operator sees it is active. */
export function warnTelemetryRawPromptsEnabled(): void {
  logger.warn(
    'telemetry.includeRawPrompts is ENABLED, authorized raw telemetry reads may expose prompt/response content. '
    + 'This setting is for debugging only. Disable in production to avoid PII/secret exfiltration.'
  );
}

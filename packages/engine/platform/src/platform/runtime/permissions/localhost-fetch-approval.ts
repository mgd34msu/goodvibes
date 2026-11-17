/**
 * Localhost fetch admission: ordinary interactive callers get the one-tap
 * "allow localhost fetches" ask, and so does a model's run when a person is at
 * the surface to answer it. An unattended model's run requires one
 * exact-hop, recorded capability instead, and never writes the persistent grant.
 *
 * STANDING RULE (same as sandbox escalations and MCP elicitations): the ask
 * rides the ONE approval broker so every surface's existing approval UI
 * renders it. Approving persists `fetch.allowLocalhost` in the user's own
 * settings (a project file cannot turn it on), so the question is asked once
 * and never again, including across restarts. Denying refuses this fetch with an honest
 * tool-result reason; a later fetch may ask again.
 *
 * Private-IP and cloud-metadata blocking is untouched by this flow: those
 * targets are refused absolutely, with the reason in the tool result and no
 * ask, notification, or any other user-facing surface.
 */
import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import type { FetchUrlInput } from '../../tools/fetch/schema.js';
import type { AutonomousToolPromptHost } from './autonomous-tool-prompts.js';
import { admitLocalhostFetch } from './autonomous-localhost-fetch.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { ConfigManager } from '../../config/manager.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';

export interface LocalhostFetchApprovalDeps {
  readonly autonomousHost?: AutonomousToolPromptHost | undefined;
  /**
   * Whether a person can answer on this surface now. Read when a model's run
   * fetches localhost: attended, the person gets the one-tap ask (no decision
   * model request); absent or false, the hop is admitted on its own.
   */
  readonly attended?: (() => boolean) | undefined;
  readonly requestApproval: (input: {
    readonly request: PermissionPromptRequest;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => Promise<PermissionPromptDecision>;
  readonly configManager: Pick<ConfigManager, 'get' | 'set'>;
}

/** A live, one-use capability, retained until response consumption completes. */
export interface LocalhostFetchPermit {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  claim(): void;
  close(): void;
}
export interface LocalhostFetchApprovalInput {
  readonly url: string;
  readonly host: string;
  readonly request?: FetchUrlInput | undefined;
  readonly originalRequest?: FetchUrlInput | undefined;
  readonly credentialHeaders?: readonly string[] | undefined;
}
export interface LocalhostFetchExecutionContext {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export type LocalhostFetchApproval = (input: LocalhostFetchApprovalInput,
  context?: LocalhostFetchExecutionContext) => Promise<boolean | LocalhostFetchPermit>;

export function buildLocalhostFetchApproval(deps: LocalhostFetchApprovalDeps): LocalhostFetchApproval {
  let inFlight: Promise<boolean> | null = null;

  return async (input, context) => {
    // An unattended autonomous hop never consumes a human grant or persists a new one.
    if (currentExternalOperationSource() && deps.attended?.() !== true) {
      return deps.autonomousHost ? admitLocalhostFetch(deps.autonomousHost, input, context) : false;
    }
    // Already approved for this project (possibly by a concurrent ask).
    if (deps.configManager.get('fetch.allowLocalhost') === true) return true;
    // Single-flight: concurrent URLs in one batch share the ask.
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const request: PermissionPromptRequest = {
          callId: `fetch-localhost-${randomUUID().slice(0, 8)}`,
          tool: 'fetch',
          args: { url: input.url, host: input.host },
          category: 'read',
          analysis: {
            classification: 'fetch-localhost',
            riskLevel: 'medium',
            summary: `Fetch a localhost dev server: ${input.url}`,
            reasons: [
              `The fetch tool wants to reach the loopback host "${input.host}" (a local dev server).`,
              'Approving allows localhost fetches in all your projects and will not ask again (fetch.allowLocalhost in your own settings).',
              'Private-IP and cloud-metadata targets stay blocked regardless of this approval.',
            ],
            target: input.url,
            targetKind: 'url',
            surface: 'network',
            blastRadius: 'local',
            host: input.host,
          },
          attribution: { kind: 'fetch-localhost', host: input.host, url: input.url },
        };
        const decision = await deps.requestApproval({
          request,
          metadata: { source: 'fetch-localhost', host: input.host, url: input.url },
        });
        if (decision.approved) {
          // A project file cannot turn this on (it is repository content), so the grant is saved in the user's own settings.
          try {
            deps.configManager.set('fetch.allowLocalhost', true);
            logger.info('[fetch] localhost fetches allowed (fetch.allowLocalhost persisted in user settings)', {
              host: input.host,
            });
          } catch (err) {
            // The owner's yes covers this fetch; only remembering it failed, so the next one asks again.
            logger.warn('[fetch] localhost fetch approved for this request, but fetch.allowLocalhost could not be saved, so the next localhost fetch will ask again', {
              host: input.host,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return decision.approved;
      } catch (err) {
        logger.warn('[fetch] localhost fetch ask failed; refusing this fetch', {
          host: input.host,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}

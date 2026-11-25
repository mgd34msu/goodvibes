/**
 * settings-writes.ts, one way for a terminal program to change one of its
 * settings from a picker or a command it runs itself (the theme picker, the
 * voice pickers, the always-speak switch, the decision router's file, the
 * print level): through the daemon's `settings.set`, as the settings screen,
 * the web UI and the model change it, so every open screen follows the change
 * and the same checks apply. The program registers how it reaches the daemon
 * once (`routeSettingWrites`); with none registered (a program run without a
 * daemon), the write goes to the program's own settings, as before.
 *
 * The program reads its own settings file live (ConfigManager.watchConfigFiles),
 * so a change the daemon writes there takes effect here as a local write did.
 */
import { connectionForCode, HttpStatusError } from '@goodvibes/engine/errors';
import { DaemonVerbNotSentError } from './agent-turn/connected-host-verb-error.js';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';

/** What a write needs from the program's context: its settings, and where a refusal is said. */
export interface SettingWriteContext {
  readonly platform: { readonly configManager: { setDynamic(key: never, value: never): void } };
  readonly print?: ((text: string) => void) | undefined;
}

/**
 * No daemon answered at all, by the error's kind, never its words: the call was not sent because no daemon is
 * reachable (DaemonVerbNotSentError), or the transport failed before any response (HttpStatusError of category
 * `network` from the transport, with no HTTP status); itself or as the cause of the refusal a capability run made of
 * it. The one kind of failure on which the program's own settings take the write: a daemon that answered, even with a
 * refusal, has a status, and its refusal is said and nothing is written.
 */
function noAnswerFromDaemon(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 3; at = (at as { readonly cause?: unknown }).cause, depth += 1) {
    if (at instanceof DaemonVerbNotSentError) return true;
    if (at instanceof HttpStatusError && at.category === 'network' && at.source === 'transport' && at.status === undefined) return true;
    // The fetch's own connection failure, by its code (Bun's `ConnectionRefused`, Node's `ECONNREFUSED`, a name that
    // does not resolve): the engine's one table of connection-failure codes reads it.
    const code = (at as { readonly code?: unknown }).code;
    const connection = typeof code === 'string' ? connectionForCode(code) : undefined;
    if (connection === 'refused' || connection === 'dns_failed') return true;
  }
  return false;
}

type Route =(ctx: unknown, key: string, value: unknown) => Promise<void>;
let route: Route | undefined;

/** How this program reaches the daemon's `settings.set` (its capability binding); registered once at start. */
export function routeSettingWrites(write: Route): void {
  route = write;
}

/**
 * Change one setting of this program (or a daemon-owned one) the one way. Resolves once the daemon answered; a
 * refusal is said with `print` (when given) and rejects, so a caller that showed the new value can put it back.
 */
export async function writeSetting(ctx: SettingWriteContext, key: string, value: unknown): Promise<void> {
  // The settings screen hands its pickers settings that already write through the daemon (routesThroughDaemon).
  const settings = ctx.platform.configManager as { setDynamic(key: never, value: never): void; readonly routesThroughDaemon?: boolean };
  if (!route || settings.routesThroughDaemon === true) {
    settings.setDynamic(key as never, value as never);
    return;
  }
  try {
    await route(ctx, key, value);
  } catch (error) {
    // No daemon to answer (a program run on its own), by the error's kind: the program's own settings, as before.
    if (noAnswerFromDaemon(error)) {
      settings.setDynamic(key as never, value as never);
      return;
    }
    ctx.print?.(`Not changed: ${key} (${summarizeError(error)}).`);
    throw error;
  }
}

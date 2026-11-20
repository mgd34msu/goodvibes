/**
 * unattended-run-tools.ts
 *
 * The mail and calendar tool for the runs nobody watches here: scheduled runs
 * and trigger turns. Both are agents this daemon spawns; without this they
 * had the platform's tools only, so a daily "summary of my mail and calendar"
 * could not read either.
 *
 * Two halves, composed once:
 *
 *   - every worker registry this daemon builds gets the `google` tool (Gmail,
 *     and the calendar through this daemon's own `calendar.events.*` verbs, so
 *     the configured CalDAV server or Google calendar answers as it does for
 *     every surface). A tool is offered to a run only when it names it, so a
 *     worker that does not ask for it never sees it.
 *   - a scheduled run or trigger turn names it when the owner has connected
 *     mail or a calendar: a Google account, or a CalDAV server. The reading is kept in memory and refreshed when one of those
 *     settings or credentials changes, so a spawn reads no store.
 *
 * Every call goes through the same permission gate as any other call of the
 * run, and the tool's own rule that a send or an event may not carry content
 * the run read from mail or a calendar.
 */

import type { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { UnattendedRuns } from '@goodvibes-jev/engine/platform/platform/automation';
import { daemonGoogleConnectionOwner, subscribeGoogleCredentialChanges } from '@goodvibes-jev/engine/platform/platform/google';
import { nodeGoogleFilePort } from '@goodvibes-jev/engine/platform/platform/google/node';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { wireAgentGoogleTool } from '@goodvibes-jev/engine/terminal-shell/agent-turn/google-wiring';
import type { GoogleCalendarHost } from '@goodvibes-jev/engine/terminal-shell/agent-turn/google-tool';

/** The tool an unattended run gets when mail or a calendar is connected. */
const MAIL_AND_CALENDAR_TOOL = 'google';

const CALDAV_KEYS = ['surfaces.calendar.caldavUrl', 'surfaces.calendar.caldavUser'] as const;

interface UnattendedRunToolsInput {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly homeDirectory: string;
  readonly artifactStore?: ArtifactStore | undefined;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly unattendedRuns: UnattendedRuns;
}

/**
 * This daemon's `calendar.events.*` verbs, called in process. A list is a
 * read; a create carries no owner's request here (nobody asked at this
 * moment), so the verb refuses it and the tool says why.
 */
function inProcessCalendarHost(methods: GatewayMethodCatalog): () => GoogleCalendarHost | null {
  const host: GoogleCalendarHost = {
    listEvents: async (input, signal) => await methods.invoke('calendar.events.list', { body: input, context: {}, ...(signal ? { signal } : {}) }) as Awaited<ReturnType<GoogleCalendarHost['listEvents']>>,
    createEvent: async (input) => await methods.invoke('calendar.events.create', { body: input, context: {} }) as Awaited<ReturnType<GoogleCalendarHost['createEvent']>>,
    failureOf: (error) => {
      if (!(error instanceof Error)) return undefined;
      return { message: error.message, applied: 'no' };
    },
  };
  return () => (methods.hasHandler('calendar.events.list') ? host : null);
}

function configText(configManager: ConfigManager, key: string): string {
  try {
    const value: unknown = configManager.get(key as never);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Registers the mail and calendar tool on each worker registry and tells the
 * unattended runs when to name it. Returns the worker decoration and the stop.
 */
export function composeUnattendedRunTools(input: UnattendedRunToolsInput): {
  readonly decorateRegistry: (registry: ToolRegistry) => void;
  readonly stop: () => void;
} {
  const { configManager, secretsManager, homeDirectory } = input;
  const calendarHost = inProcessCalendarHost(input.gatewayMethods);
  let connected = false;
  let refreshing: Promise<void> | undefined;
  let again = false;

  const read = async (): Promise<boolean> => {
    if (CALDAV_KEYS.every((key) => configText(configManager, key).length > 0)) return true;
    const owner = daemonGoogleConnectionOwner({ configManager, secretsManager, homeDirectory, files: nodeGoogleFilePort });
    return (await owner.connection()) !== null;
  };
  const refresh = (): void => {
    if (refreshing) { again = true; return; }
    refreshing = read()
      .then((value) => { connected = value; })
      .catch((error: unknown) => {
        connected = false;
        logger.warn('Unattended runs: whether mail or a calendar is connected could not be read; scheduled and trigger runs get no mail or calendar tool until it can', { error: summarizeError(error) });
      })
      .finally(() => {
        refreshing = undefined;
        if (again) { again = false; refresh(); }
      });
  };

  const stops: Array<() => void> = [];
  stops.push(subscribeGoogleCredentialChanges({ config: configManager, secrets: secretsManager }, refresh));
  for (const key of CALDAV_KEYS) stops.push(configManager.subscribe(key as never, refresh));
  stops.push(input.unattendedRuns.attachConnectedTools(() => (connected ? [MAIL_AND_CALENDAR_TOOL] : [])));
  refresh();

  return {
    decorateRegistry: (registry) => {
      wireAgentGoogleTool(registry, {
        configManager,
        secretsManager,
        homeDirectory,
        artifactStore: input.artifactStore,
        calendarHost,
      });
    },
    stop: () => { for (const stop of stops.splice(0)) stop(); },
  };
}

/**
 * The facts a host (the daemon, a channel) words an ask from, so the words
 * travel with the ask: every surface that lists it (the web UI, a chat
 * channel, a terminal attached to the daemon) draws the same question,
 * consequence and choices (ask-presentation.ts).
 *
 * What the host holds: the mode in force (read from settings when an item is
 * worded), a setting's plain name from the settings schema, the title of the
 * chat an ask came from, and its home folder for "~/projects/sample-app". The
 * exec sandbox and the workspace checkpoint are facts of the terminal app that
 * ran the call; a host without them words nothing about reach or a copy.
 *
 * Cost: a few settings reads per item worded, no I/O beyond them.
 */
import { homedir } from 'node:os';
import { CONFIG_SCHEMA } from '../config/schema.js';
import type { ConfigManager } from '../config/manager.js';
import type { OwnerItem } from '../control-plane/owner-inbox.js';
import { presentApprovalAsk, presentInboxAsk, type AskFacts, type AskPresentation, type PurchaseAskFacts } from './ask-presentation.js';
import { describeModeInForceWords } from './decision-model-readiness.js';
import type { PermissionPromptRequest } from './prompt.js';

let labels: Map<string, string> | null = null;

/** A setting's plain name ("Run commands in a sandbox"); undefined for a key the schema does not hold. */
export function settingLabelOf(key: string): string | undefined {
  labels ??= new Map(CONFIG_SCHEMA.map((setting) => [setting.key as string, setting.label]));
  const label = labels.get(key);
  return label !== undefined && label.trim() !== '' ? label : undefined;
}

export interface HostAskFactsSource {
  readonly configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>;
  readonly homeDirectory?: string | undefined;
  /** The title of a chat by its session id ("Tidy the seed notes"). */
  readonly sessionTitle?: ((sessionId: string) => string | undefined) | undefined;
  /** A purchase window's facts by purchase id. */
  readonly purchase?: ((purchaseId: string) => PurchaseAskFacts | undefined) | undefined;
}

/** The facts as the host holds them now. No chat is "this one" for a host: every ask names the chat it came from. */
export function hostAskFacts(source: HostAskFactsSource, sessionId?: string | undefined): AskFacts {
  return {
    homeDirectory: source.homeDirectory ?? homedir(),
    modeInForce: describeModeInForceWords(source.configManager),
    settingLabel: settingLabelOf,
    ...(source.sessionTitle ? { sessionTitle: source.sessionTitle } : {}),
    ...(source.purchase ? { purchase: source.purchase } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/** Word an owner-inbox item (an approval from its request) with the host's facts. */
export function hostItemPresenter(source: HostAskFactsSource): (item: OwnerItem, request?: PermissionPromptRequest) => AskPresentation {
  return (item, request) => presentInboxAsk(item, hostAskFacts(source, item.sessionId), request);
}

/** Word an approval's request with the host's facts (a channel's message, an approvals list row). */
export function hostApprovalPresentation(source: HostAskFactsSource, request: PermissionPromptRequest, sessionId?: string | undefined): AskPresentation {
  return presentApprovalAsk(request, hostAskFacts(source, sessionId));
}

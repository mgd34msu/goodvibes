/**
 * permission-prompt-facts.ts, the facts both terminal programs word an ask
 * from (permissions/ask-presentation.ts AskFacts), and the ask's words for a
 * card, computed once per ask.
 *
 * The facts are the ones the program already holds: the folder it works in,
 * the home folder (for "~/projects/sample-app"), the mode in force as the
 * status bar shows it, the chat it is in, a setting's plain name, and the
 * exec sandbox the gate annotated the request with. Nothing here reads a file
 * or asks anything.
 *
 * Cost: one presentation per ask and per change of the mode words (cached on
 * the request object), never one per frame.
 */
import { homedir } from 'node:os';
import {
  presentApprovalAsk,
  settingLabelOf,
  type AskFacts,
  type AskPresentation,
  type ModeInForceWords,
  type PermissionPromptRequest,
  type SandboxFact,
} from '@goodvibes/engine/platform/platform/permissions';

/** What a terminal program holds when it draws an ask. */
export interface TerminalAskContext {
  readonly workingDirectory: string;
  readonly homeDirectory?: string | undefined;
  /** The mode in force, as the status bar's mode segment holds it (session-permission-mode.ts). */
  readonly modeInForce: ModeInForceWords;
  /** The chat this program shows. */
  readonly currentSessionId?: string | undefined;
  readonly sessionTitle?: ((sessionId: string) => string | undefined) | undefined;
}

/** A setting's plain name ("Run commands in a sandbox"), from the settings schema. */
export const settingLabel = settingLabelOf;

/**
 * The exec sandbox a request runs in, from the annotation the terminal app's
 * sandbox gate attaches (products/tui permissions/sandbox-exec-gate.ts): the
 * working folder is writable, plus every writable path the ask grants; the
 * network is reached only when the ask grants it. Undefined when the gate did
 * not annotate it (not sandboxed, or the Agent, which has no exec sandbox gate).
 */
export function sandboxFactOf(request: PermissionPromptRequest): SandboxFact | undefined {
  const annotated = request as PermissionPromptRequest & { readonly sandboxed?: unknown; readonly sandboxEscalations?: unknown };
  if (annotated.sandboxed !== true || !Array.isArray(annotated.sandboxEscalations) || !request.workingDirectory) return undefined;
  const escalations = annotated.sandboxEscalations.filter((entry): entry is string => typeof entry === 'string');
  const extras = escalations.flatMap((entry) => {
    const match = /^writable path outside workspace: (.+)$/.exec(entry);
    return match ? [match[1]!] : [];
  });
  return {
    enforced: true,
    writableRoots: [request.workingDirectory, ...extras],
    network: escalations.some((entry) => /network/i.test(entry)),
  };
}

/** The AskFacts for one request in a terminal program. */
export function terminalAskFacts(context: TerminalAskContext, request?: PermissionPromptRequest | undefined): AskFacts {
  const sandbox = request ? sandboxFactOf(request) : undefined;
  return {
    workingDirectory: context.workingDirectory,
    homeDirectory: context.homeDirectory ?? homedir(),
    modeInForce: context.modeInForce,
    settingLabel,
    ...(sandbox ? { sandbox } : {}),
    ...(context.currentSessionId !== undefined ? { currentSessionId: context.currentSessionId } : {}),
    ...(context.sessionTitle ? { sessionTitle: context.sessionTitle } : {}),
  };
}

const cache = new WeakMap<object, { readonly mode: ModeInForceWords; readonly presentation: AskPresentation }>();

/** The context the card was last drawn with: the keys read the same choices the card shows. */
let lastContext: TerminalAskContext | null = null;

/** Mode words for an ask read before any card was drawn; they change no choice, only the "why" sentence. */
const UNDRAWN: ModeInForceWords = { chosen: '', sentence: '', asksBefore: '' };

/**
 * The ask's words for its card: computed when the card first draws and again
 * only when the mode words change (the cache is keyed on the request object
 * the pending card holds). Without a context, the one the card was last drawn
 * with: the choices depend on the ask alone, never on the mode words.
 */
export function askPresentationFor(request: PermissionPromptRequest, context?: TerminalAskContext | undefined): AskPresentation {
  if (context) lastContext = context;
  const using = context ?? lastContext;
  const mode = using?.modeInForce ?? UNDRAWN;
  const cached = cache.get(request);
  if (cached && (cached.mode === mode || context === undefined)) return cached.presentation;
  const presentation = presentApprovalAsk(request, using ? terminalAskFacts(using, request) : { modeInForce: UNDRAWN, settingLabel });
  cache.set(request, { mode, presentation });
  return presentation;
}

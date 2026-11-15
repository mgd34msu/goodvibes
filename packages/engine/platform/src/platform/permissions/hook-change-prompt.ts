import type { HookChangeRequest } from '../tools/state/index.js';
import type { PermissionRequestAnalysis } from './types.js';

const VERB: Record<HookChangeRequest['action'], string> = {
  add: 'adds',
  enable: 'enables',
  disable: 'disables',
  remove: 'removes',
};

/**
 * What the owner is asked when a hook is added, changed, enabled, disabled or removed.
 * The text is built from the whole hook definition: what it runs, every field that changes when
 * or how it fires, and for a Pre event what its output can do to the call. Header values are
 * never shown, only their names; an http hook sends every event it fires on (tool arguments and
 * results included) to its URL, so the text says so.
 */
export function describeHookChange(request: HookChangeRequest): {
  readonly args: Record<string, unknown>;
  readonly analysis: PermissionRequestAnalysis;
} {
  const { action, eventPattern, hook } = request;
  const events = hook.match && hook.match !== eventPattern ? `${eventPattern} (match ${hook.match})` : eventPattern;
  const headerNames = Object.keys(hook.headers ?? {});
  const what = hook.type === 'command' ? `runs the command: ${hook.command ?? '(none)'}`
    : hook.type === 'ts' ? `runs the script: ${hook.path ?? '(none)'}`
    : hook.type === 'http' ? `sends the full event, including tool arguments and results, to ${hook.url ?? '(no url)'}`
    : hook.type === 'agent' ? `starts an agent with tools on each event, with the instructions: ${hook.prompt ?? '(none)'}`
    : `runs a model prompt on each event: ${hook.prompt ?? '(none)'}`;
  const deadline = hook.timeout === undefined ? undefined : hook.timeout === 0 ? 'It has no deadline.' : `Its deadline is ${hook.timeout} s.`;
  const reasons = [
    `This ${hook.type} hook${hook.name ? ` "${hook.name}"` : ''} fires on ${events}; it ${what}.`,
    hook.matcher !== undefined ? `It fires only for "${hook.matcher}" within ${eventPattern}.` : `It fires on every event under ${eventPattern}.`,
    ...(eventPattern.startsWith('Pre:') ? ['Its output can block the call, change its arguments, or add text to the conversation.'] : []),
    ...(hook.model !== undefined ? [`It uses the model ${hook.model}.`] : []),
    ...(hook.async === true ? ['It runs in the background without holding the event.'] : []),
    ...(hook.once === true ? ['It runs once and then removes itself.'] : []),
    ...(deadline ? [deadline] : []),
    ...(hook.type === 'http' ? [
      `Headers sent: ${headerNames.length > 0 ? headerNames.join(', ') : 'none beyond Content-Type'} (values not shown).`,
      hook.allowInternal === true
        ? 'allowInternal is on: the request may reach private and loopback hosts.'
        : 'allowInternal is off: private and loopback hosts are refused.',
    ] : []),
    'You are asked every time; approving this does not approve anything else.',
  ];
  const summary = `${action === 'add' ? 'Add' : action === 'enable' ? 'Enable' : action === 'disable' ? 'Disable' : 'Remove'} a ${hook.type} hook on ${events}`;
  const target = hook.type === 'http' ? { target: hook.url, targetKind: 'url' as const }
    : hook.type === 'ts' ? { target: hook.path, targetKind: 'path' as const }
    : hook.type === 'command' ? { target: hook.command, targetKind: 'command' as const }
    : { target: hook.prompt, targetKind: 'task' as const };
  return {
    args: {
      mode: 'hooks',
      hookAction: action,
      eventPattern,
      hookType: hook.type,
      ...(hook.name !== undefined ? { hookName: hook.name } : {}),
      ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
      ...(hook.command !== undefined ? { command: hook.command } : {}),
      ...(hook.path !== undefined ? { path: hook.path } : {}),
      ...(hook.url !== undefined ? { url: hook.url } : {}),
      ...(hook.prompt !== undefined ? { prompt: hook.prompt } : {}),
      ...(hook.model !== undefined ? { model: hook.model } : {}),
      ...(hook.async !== undefined ? { async: hook.async } : {}),
      ...(hook.once !== undefined ? { once: hook.once } : {}),
      ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}),
      ...(hook.type === 'http' ? { headerNames, allowInternal: hook.allowInternal === true } : {}),
      effect: `${VERB[action]} a hook`,
    },
    analysis: {
      classification: 'hook-change',
      riskLevel: 'high',
      summary,
      reasons,
      ...target,
      surface: 'platform',
      blastRadius: 'platform',
    },
  };
}

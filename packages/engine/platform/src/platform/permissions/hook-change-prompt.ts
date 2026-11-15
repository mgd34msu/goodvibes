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
 * Header values are never shown, only their names; an http hook sends every event it fires on
 * (tool arguments and results included) to its URL, so the text says so.
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
    : `runs a model prompt on each event: ${hook.prompt ?? '(none)'}`;
  const reasons = [
    `This ${hook.type} hook${hook.name ? ` "${hook.name}"` : ''} fires on ${events}; it ${what}.`,
    ...(hook.type === 'http' ? [
      `Headers sent: ${headerNames.length > 0 ? headerNames.join(', ') : 'none beyond Content-Type'} (values not shown).`,
      hook.allowInternal === true
        ? 'allowInternal is on: the request may reach private and loopback hosts.'
        : 'allowInternal is off: private and loopback hosts are refused.',
    ] : []),
    'You are asked every time; approving this does not approve anything else.',
  ];
  const summary = `${action === 'add' ? 'Add' : action === 'enable' ? 'Enable' : action === 'disable' ? 'Disable' : 'Remove'} a ${hook.type} hook on ${events}`;
  return {
    args: {
      mode: 'hooks',
      hookAction: action,
      eventPattern,
      hookType: hook.type,
      ...(hook.name !== undefined ? { hookName: hook.name } : {}),
      ...(hook.command !== undefined ? { command: hook.command } : {}),
      ...(hook.path !== undefined ? { path: hook.path } : {}),
      ...(hook.url !== undefined ? { url: hook.url } : {}),
      ...(hook.prompt !== undefined ? { prompt: hook.prompt } : {}),
      ...(hook.type === 'http' ? { headerNames, allowInternal: hook.allowInternal === true } : {}),
      effect: `${VERB[action]} a hook`,
    },
    analysis: {
      classification: 'hook-change',
      riskLevel: 'high',
      summary,
      reasons,
      target: hook.type === 'http' ? hook.url : hook.command ?? hook.path ?? hook.name,
      targetKind: hook.type === 'http' ? 'url' : 'command',
      surface: 'platform',
      blastRadius: 'platform',
    },
  };
}

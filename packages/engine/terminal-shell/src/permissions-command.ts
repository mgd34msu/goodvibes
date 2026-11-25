/**
 * `/permissions`, described once (command-actions/) for both terminal apps:
 * what GoodVibes asks you about now and the permission settings in force (this
 * conversation's, read here), and the rules that decide calls without asking
 * (one file every program reads; the daemon lists, adds and removes them:
 * capabilities/builtin/permissions.ts and safety-methods.ts). It stays a
 * typed command that opens Permissions and safety; its actions are the place's
 * controls too.
 */
import { buildPermissionProvenance, renderPermissionProvenance, type PermissionsCommandContext } from '@goodvibes/engine/platform/platform/gate/policy';
import { describeModeInForceWords } from '@goodvibes/engine/platform/platform/permissions';
import {
  PERMISSIONS_ADD, PERMISSIONS_MODE, PERMISSIONS_NEVER, PERMISSIONS_REVOKE, PERMISSIONS_RULES, PERMISSIONS_SHOW, ruleWords,
  type PermissionsSessionServices,
} from '@goodvibes/engine/platform/platform/capabilities';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { daemonCapabilityAction, runDaemonCapability, sessionCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext } from './command-actions/types.js';

/** This app's settings and rule count, as the two reads of this conversation's permissions take them. */
export type PermissionsDeps<Ctx> = (ctx: Ctx) => Omit<PermissionsCommandContext, 'print' | 'openSelection'>;

/** This conversation's permissions, from what the app keeps (the model's `capability_run` takes the same). */
export function permissionsHereOf(deps: Omit<PermissionsCommandContext, 'print' | 'openSelection'>): NonNullable<PermissionsSessionServices['permissionsHere']> {
  return {
    modeWords: () => describeModeInForceWords(deps.configManager),
    settingsInForce: () => {
      const reported = deps.modeInForce?.();
      return renderPermissionProvenance(buildPermissionProvenance(deps.configManager, { evaluatorInForce: deps.evaluatorInForce?.(), ...(reported ? { modeInForce: reported } : {}) }));
    },
    ruleCount: () => deps.ruleStore?.list().length ?? 0,
  };
}

/** How the rule list reaches the daemon: set when a program registers the command. */
let listBinding: DaemonCapabilityBinding<CommandActionContext> | undefined;

/** The rules in force, as the daemon lists them (the list "Remove a permission rule" chooses from). */
defineList<CommandActionContext>({
  name: 'permissions.rules',
  async read(ctx) {
    if (!listBinding) return [];
    const answer = await runDaemonCapability('permissions.rules', {}, ctx, listBinding);
    const rules = Array.isArray(answer.data?.['rules']) ? answer.data['rules'] as Record<string, unknown>[] : [];
    return rules.filter((rule) => typeof rule['id'] === 'string').map((rule): ListRow => {
      const words = ruleWords(rule);
      return { value: rule['id'] as string, label: words.title, detail: words.detail, ...(typeof rule['effect'] === 'string' ? { state: rule['effect'] } : {}) };
    });
  },
  operator: { method: 'permissions.rules.list', input: {}, rows: { from: 'rules', value: 'id', label: 'description', state: 'effect' } },
});

/** Register `/permissions` with this app's settings and how it reaches the daemon. */
export function registerPermissionsCommand<Ctx extends CommandActionContext>(
  registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, deps: PermissionsDeps<Ctx>, binding: DaemonCapabilityBinding<Ctx>,
): void {
  listBinding = binding as DaemonCapabilityBinding<CommandActionContext>;
  const here = (ctx: Ctx): PermissionsSessionServices => ({ permissionsHere: permissionsHereOf(deps(ctx)) });
  const terminalOnly = 'It reads the permissions of the terminal app\'s own conversation.';
  registry.register(defineCommand<Ctx>({
    name: 'permissions',
    title: 'Permissions',
    summary: 'See which permission settings are in force, and the rules that decide calls without asking',
    group: 'Permissions',
    // Typed bare by a person, it opens Permissions and safety; a model or a script gets the mode in force.
    opens: 'safety',
    report: 'mode',
    actions: [
      sessionCapabilityAction<Ctx, PermissionsSessionServices>(PERMISSIONS_MODE, here, { terminalOnly }),
      sessionCapabilityAction<Ctx, PermissionsSessionServices>(PERMISSIONS_SHOW, here, { terminalOnly }),
      daemonCapabilityAction<Ctx>(PERMISSIONS_RULES, binding),
      daemonCapabilityAction<Ctx>(PERMISSIONS_NEVER, binding),
      daemonCapabilityAction<Ctx>(PERMISSIONS_ADD, binding),
      daemonCapabilityAction<Ctx>(PERMISSIONS_REVOKE, binding),
    ],
  }));
}

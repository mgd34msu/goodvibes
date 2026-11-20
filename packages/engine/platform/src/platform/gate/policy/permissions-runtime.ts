/**
 * `/permissions`, the permission settings surface, as engine logic shared by
 * the terminal apps. Each product registers `PERMISSIONS_COMMAND` with a
 * handler that hands this module a narrow context: a print sink, the
 * remembered-rule store, the config manager, the evaluator in force and, when
 * the surface has one, a selection picker.
 *
 * With no arguments it prints the mode in force and every permission-relevant
 * setting in effect and where each value came from (provenance; read-only).
 * `rules` lists the durable rules with a Delete-key revoke; `revoke <id>`
 * removes one by id; `add` writes one directly: a "never run commands
 * matching" rule, or an allow, deny or "always ask me" rule of any remember
 * tier. Every change hits the same in-process rule store the gate reads, so it
 * takes effect live.
 */
import { projectIdentity, type StoredUserPermissionRule, type UserPermissionRuleStore } from '../../permissions/user-rule-store.js';
import { buildDurableRuleForDecision } from '../../permissions/approval-rules.js';
import { parseNeverRunPattern } from '../never-run.js';
import type { PolicyRule } from '../../runtime/permissions/types.js';
import { summarizeError } from '../../utils/error-display.js';
import type { PermissionModeInForce } from '../../permissions/decision-model-readiness.js';
import { buildPermissionProvenance, renderPermissionProvenance, type ConfigProvenanceManager } from './permissions-provenance.js';

/** One row the rule picker shows. */
export interface PermissionRuleSelectionItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly actions: string;
}

/** What the picker hands back: the row and the action pressed on it. */
export interface PermissionRuleSelectionResult {
  readonly item: { readonly id: string; readonly label: string };
  readonly action: string;
}

/** The rule store operations the command uses; a store without `add` lists and revokes only. */
export type RememberedRuleStore = Pick<UserPermissionRuleStore, 'list' | 'delete'> & Partial<Pick<UserPermissionRuleStore, 'add'>>;

export interface PermissionsCommandContext {
  print(text: string): void;
  /** Absent on a surface without remembered rules. */
  readonly ruleStore?: RememberedRuleStore | undefined;
  readonly configManager: ConfigProvenanceManager;
  /** The permission evaluator the running process uses (it changes only at a restart). */
  readonly evaluatorInForce?: (() => 'baseline' | 'policy-engine' | undefined) | undefined;
  /** The mode in force as this surface's owner reports it (a hosted session's host); read from settings when absent or undefined. */
  readonly modeInForce?: (() => PermissionModeInForce | undefined) | undefined;
  /** The project a rule added here is scoped to (the working directory); absent or null: only never-run rules can be added. */
  readonly projectRoot?: (() => string | null) | undefined;
  /** The surface's selection picker, when it has one. */
  readonly openSelection?: ((
    title: string,
    items: PermissionRuleSelectionItem[],
    options: { readonly allowSearch: boolean; readonly customActions: Map<string, 'delete'> },
    onResult: (result: PermissionRuleSelectionResult | null) => void,
  ) => void) | undefined;
}

/** The command's registration fields; the product adds the handler. */
export const PERMISSIONS_COMMAND = {
  name: 'permissions',
  aliases: ['perms'],
  description: 'Show permission settings and provenance, and list or revoke remembered approval rules',
  usage: '[rules | revoke <rule-id> | add never <command> | add <allow|deny|ask> <command|class|path|tool> <target>]',
  argsHint: '[rules|revoke|add]',
  subcommands: { rules: '', revoke: '<rule-id>', add: 'never <command> | <allow|deny|ask> <command|class|path|tool> <target>' },
  // Showing the settings and the rules reads; adding or revoking one changes what runs unasked.
  effect: 'mixed',
  readVerbs: ['', 'rules'],
} as const;

/** One remembered-rule row: what it does, and how/when it was remembered. */
function describeRuleRow(record: Pick<StoredUserPermissionRule, 'rule' | 'tier' | 'tool' | 'createdAt'> & { readonly project?: string | undefined }): { label: string; detail: string } {
  const what = record.rule.description ?? record.rule.id;
  const kind = record.tier === 'never-run' ? 'never run, every mode' : `${record.rule.id.startsWith('owner-') ? 'added' : 'remembered'} ${record.tier}`;
  return {
    label: `${record.tool === '*' ? 'any tool' : record.tool}: ${what}`,
    detail: `${record.rule.effect} · ${kind} · ${record.project === undefined ? 'every project' : `in ${record.project}`} · ${new Date(record.createdAt).toLocaleString()}`,
  };
}

function showRememberedRules(ctx: PermissionsCommandContext): void {
  const store = ctx.ruleStore;
  if (!store) {
    ctx.print('Remembered permission rules are not available on this surface.');
    return;
  }
  const records = store.list();
  if (records.length === 0) {
    ctx.print('No permission rules. Approving an ask with a remember tier stores one here; /permissions add writes one directly.');
    return;
  }
  if (ctx.openSelection) {
    const revoke = new Map<string, 'delete'>([['d', 'delete']]);
    const items: PermissionRuleSelectionItem[] = records.map((record) => {
      const { label, detail } = describeRuleRow(record);
      return { id: record.rule.id, label, detail, actions: '[Del] revoke' };
    });
    ctx.openSelection('Permission rules', items, { allowSearch: true, customActions: revoke }, (result) => {
      if (!result || result.action !== 'delete') return;
      void (async () => {
        try {
          const removed = await store.delete(result.item.id);
          ctx.print(removed ? `Revoked remembered rule: ${result.item.label}` : `Rule already gone: ${result.item.label}`);
        } catch (error) {
          ctx.print(`Could not revoke the rule: ${summarizeError(error)}`);
        }
      })();
    });
    return;
  }
  // No selection surface: list them honestly with the revoke command to run.
  ctx.print([
    'Permission rules:',
    ...records.map((record) => {
      const { label, detail } = describeRuleRow(record);
      return `  ${record.rule.id}  ${label}  (${detail})`;
    }),
    '',
    'Revoke one with: /permissions revoke <rule-id>',
  ].join('\n'));
}

async function revokeRememberedRule(ctx: PermissionsCommandContext, ruleId: string): Promise<void> {
  const store = ctx.ruleStore;
  if (!store) {
    ctx.print('Remembered permission rules are not available on this surface.');
    return;
  }
  if (!ruleId) {
    ctx.print('Usage: /permissions revoke <rule-id>  (see /permissions rules for ids)');
    return;
  }
  try {
    const removed = await store.delete(ruleId);
    ctx.print(removed ? `Revoked remembered rule: ${ruleId}` : `No remembered rule with id: ${ruleId}`);
  } catch (error) {
    ctx.print(`Could not revoke the rule: ${summarizeError(error)}`);
  }
}

const ADD_USAGE = [
  'Usage:',
  '  /permissions add never <command>                    never run commands matching, e.g. never git push (every tool, every mode, every project)',
  '  /permissions add <allow|deny|ask> command <command>  this exact exec command, in this project',
  '  /permissions add <allow|deny|ask> class <word>       every exec command starting with <word>, in this project',
  '  /permissions add <allow|deny|ask> path <directory>   write and edit under a directory, in this project',
  '  /permissions add <allow|deny|ask> tool <tool>        every call of a tool, in this project',
].join('\n');

/** A rule id for a rule the owner added himself, apart from remembered answers' `user-...` ids. */
function ownerRuleId(kind: string, tool: string, now: number): string {
  return `owner-${kind}-${tool.replace(/[^A-Za-z0-9_.-]/g, '')}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The record `/permissions add` writes, or the reason it cannot. */
function ownerRuleRecord(args: readonly string[], projectRoot: string | null, now: number): StoredUserPermissionRule | string {
  const first = (args[0] ?? '').toLowerCase();
  if (first === 'never') {
    const command = args.slice(1).join(' ').trim();
    const pattern = parseNeverRunPattern(command);
    if (!pattern) return ADD_USAGE;
    const rule: PolicyRule = { type: 'never-run', id: ownerRuleId('never-run', pattern.program, now), origin: 'user', effect: 'deny',
      toolPattern: '*', commands: [command], description: `never run: ${command}` };
    return { rule, tier: 'never-run', tool: '*', createdAt: now };
  }
  if (first !== 'allow' && first !== 'deny' && first !== 'ask') return ADD_USAGE;
  const kind = (args[1] ?? '').toLowerCase();
  const target = args.slice(2).join(' ').trim();
  if (!target) return ADD_USAGE;
  if (!projectRoot) return 'There is no working directory to scope the rule to; run this from a project. A never-run rule needs none.';
  const tier = kind === 'command' ? 'exact' : kind === 'class' ? 'command-class' : kind === 'path' ? 'path' : kind === 'tool' ? 'tool' : undefined;
  if (tier === undefined) return ADD_USAGE;
  if (tier === 'command-class' && /\s/.test(target)) return 'A command class is one word, for example: /permissions add allow class git';
  const toolName = tier === 'tool' ? target : tier === 'path' ? 'edit' : 'exec';
  const built = buildDurableRuleForDecision({
    toolName, tier, effect: first, now,
    // The path tier covers the directory of the path it is given: a placeholder file inside the directory names it.
    args: tier === 'path' ? { path: `${target.replace(/\/+$/, '')}/*` } : tier === 'tool' ? {} : { command: target },
  });
  if (!built) return ADD_USAGE;
  return { rule: { ...built, id: ownerRuleId(tier, toolName, now) }, tier, tool: toolName, createdAt: now, project: projectIdentity(projectRoot) };
}

async function addOwnerRule(ctx: PermissionsCommandContext, args: readonly string[]): Promise<void> {
  const store = ctx.ruleStore;
  if (!store?.add) {
    ctx.print('Permission rules cannot be added on this surface.');
    return;
  }
  const record = ownerRuleRecord(args, ctx.projectRoot?.() ?? null, Date.now());
  if (typeof record === 'string') {
    ctx.print(record);
    return;
  }
  try {
    await store.add(record);
    ctx.print(record.tier === 'never-run'
      ? `Added rule ${record.rule.id}: ${record.rule.description}. Every tool that can reach a shell is refused a command that runs it, in every permission mode including yolo, in every project. Remove it with /permissions revoke ${record.rule.id}.`
      : `Added rule ${record.rule.id}: ${record.rule.description} (in ${record.project}). Remove it with /permissions revoke ${record.rule.id}.`);
  } catch (error) {
    ctx.print(`Could not add the rule: ${summarizeError(error)}`);
  }
}

/** Runs `/permissions [rules | revoke <rule-id> | add ...]`. */
export async function runPermissionsCommand(args: readonly string[], ctx: PermissionsCommandContext): Promise<void> {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub === 'rules' || sub === 'rule') {
    showRememberedRules(ctx);
    return;
  }
  if (sub === 'revoke' || sub === 'forget' || sub === 'remove') {
    await revokeRememberedRule(ctx, args[1] ?? '');
    return;
  }
  if (sub === 'add') {
    await addOwnerRule(ctx, args.slice(1));
    return;
  }
  const reported = ctx.modeInForce?.();
  const provenance = buildPermissionProvenance(ctx.configManager, { evaluatorInForce: ctx.evaluatorInForce?.(), ...(reported ? { modeInForce: reported } : {}) });
  ctx.print(renderPermissionProvenance(provenance));
  const ruleCount = ctx.ruleStore?.list().length ?? 0;
  ctx.print(ruleCount > 0
    ? `\n${ruleCount} permission rule${ruleCount === 1 ? '' : 's'} in effect. Use /permissions rules to review or revoke them, /permissions add to add one.`
    : '\nNo permission rules. Use /permissions add to add one (for example: /permissions add never git push).');
}

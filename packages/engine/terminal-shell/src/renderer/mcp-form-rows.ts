import { activeTokens } from './theme.js';
import type { KitRow } from './surface-kit-list.js';
import { formatArgs, parseArgs, type McpWorkspaceFormField } from '../mcp-workspace-model.js';
const MASK = '••••';
/** A value that points at a secret rather than holding one: a stored-secret URI or an env var reference. */
function isReferenceValue(value: string): boolean {
  const v = value.trim();
  return v.startsWith('goodvibes://secrets/') || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v);
}
const SECRET_FLAG = /token|secret|key|password|passwd|credential|auth/i;

/** Display copy of "KEY=VALUE, KEY=VALUE" with every literal value hidden; references stay readable. */
export function maskEnvText(text: string): string {
  return text
    .split(/,(?=\s*[A-Za-z_][A-Za-z0-9_.-]*=)/)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0) return entry;
      return entry.slice(eq + 1).trim() === '' || isReferenceValue(entry.slice(eq + 1)) ? entry : `${entry.slice(0, eq + 1)}${MASK}`;
    })
    .join(',');
}

/** Display copy of launch arguments with the value of a secret-looking flag (--token x, --api-key=x) hidden. */
export function maskLaunchArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const arg of args) {
    if (hideNext) {
      out.push(isReferenceValue(arg) ? arg : MASK);
      hideNext = false;
      continue;
    }
    const flag = /^(-{1,2}[^=\s]+)(=(.*))?$/.exec(arg);
    if (flag && SECRET_FLAG.test(flag[1]!)) {
      if (flag[2] === undefined) { out.push(arg); hideNext = true; }
      else out.push(isReferenceValue(flag[3] ?? '') ? arg : `${flag[1]}=${MASK}`);
      continue;
    }
    out.push(arg);
  }
  return out;
}

export function formRows(workspace: {
  readonly formIndex: number;
  readonly formFields: readonly McpWorkspaceFormField<string>[];
}): KitRow[] {
  const t = activeTokens();
  return workspace.formFields.map((field, index) => {
    const selected = index === workspace.formIndex;
    const isAction = field.id === 'save' || field.id === 'cancel';
    // Environment values and secret-looking launch arguments stay hidden on
    // every row, the one being edited included: a value typed there is masked
    // as it is typed, and a saved one is replaced by typing over it, never shown.
    const shown = field.id === 'env' ? maskEnvText(field.value) : field.id === 'args' ? formatArgs(maskLaunchArgs(parseArgs(field.value))) : field.value;
    const value = isAction ? undefined : shown.length > 0 ? shown : '(empty)';
    return {
      label: field.label,
      desc: value !== undefined && selected && field.editable ? `${shown}▏` : value,
      right: !isAction && !field.editable ? '←→' : undefined,
      labelFg: field.id === 'save' ? t.success : field.id === 'cancel' ? t.warning : undefined,
      bold: isAction,
      selected,
    };
  });
}

export interface McpTrustRowEntry {
  readonly name: string;
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly trustMode: string;
  readonly connected: boolean;
  readonly role: string;
  readonly toolRules?: readonly { readonly rule: 'allow' | 'deny' }[] | undefined;
}
export function mcpTrustRows(
  items: readonly McpTrustRowEntry[],
  selected: number,
  focused: boolean,
  editing: boolean,
  buffer: string,
): KitRow[] {
  const t = activeTokens();
  return items.map((entry, i) => {
    const scope =
      entry.allowedPaths.length > 0
        ? entry.allowedPaths.join(', ')
        : entry.allowedHosts.length > 0
          ? entry.allowedHosts.join(', ')
          : 'no scope';
    const trust = i === selected && editing ? `${buffer}▏` : entry.trustMode;
    const denied = entry.toolRules?.filter((rule) => rule.rule === 'deny').length ?? 0;
    const allowed = entry.toolRules?.filter((rule) => rule.rule === 'allow').length ?? 0;
    const rules = denied + allowed > 0 ? ` · tools${denied > 0 ? ` ${denied} denied` : ''}${allowed > 0 ? ` ${allowed} allowed` : ''}` : '';
    return {
      label: entry.name,
      desc: `${entry.role} · ${scope}${rules}`,
      right: trust,
      mark: entry.connected ? '●' : '○',
      markFg: entry.connected ? t.success : t.textFaint,
      selected: i === selected && focused,
      current: i === selected && !focused,
    };
  });
}

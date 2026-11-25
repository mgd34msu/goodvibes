/**
 * Approval rules, in Settings > Permissions: every decision remembered at a
 * generalizing tier (permissions.rules.list), with revocation
 * (permissions.rules.delete). Rules are only minted by decisions (an approval
 * with a Remember scope); deleting one hands matching calls back to the
 * permission mode: an allow rule's calls may prompt again, a deny rule's calls
 * are no longer refused by it (so deleting a deny rule is confirmed first). A
 * `deleted:false` answer is the daemon's honest "no such rule" (already gone),
 * reported as information, not an error.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2 } from 'lucide-react';
import { client as platformClient } from '../../lib/goodvibes';
import type { PermissionRuleRecord } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { useConfirm } from '../ui/ConfirmDialog';
import { Row, RowList } from '../ui/Row';
import { StatusDot } from '../ui/StatusDot';
import { SettingsBlock } from './dialog/parts';
import { whenLabel } from '../../lib/when-label';
import { projectName } from '../../lib/place-project';

/** One-line reading of a rule: effect, tier, tool. */
export function ruleSummary(rule: PermissionRuleRecord): string {
  const effect = rule.effect === 'deny' ? 'Deny' : 'Allow';
  return `${effect} · ${rule.tier} · ${rule.tool}`;
}

/** The release a refusing rule was carried from to every project (`carried`), read before the client types know the field. */
function carriedFrom(rule: PermissionRuleRecord): string | undefined {
  const carried = (rule as Readonly<Record<string, unknown>>)['carried'];
  return typeof carried === 'string' && carried ? carried : undefined;
}

export function PermissionRules() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const rules = useQuery({
    queryKey: queryKeys.permissionRules,
    queryFn: () => platformClient.operator.permissions.rules.list(),
  });
  const remove = useMutation({
    mutationFn: (ruleId: string) => platformClient.operator.permissions.rules.delete(ruleId),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.permissionRules });
      toast(result.deleted
        ? { title: 'Rule deleted', description: 'Matching calls follow your setting for when GoodVibes asks now.', tone: 'info' }
        : { title: 'Rule already gone', description: 'The daemon reported no such rule.', tone: 'info' });
    },
    onError: (error: unknown) => toast({ title: 'Delete failed', description: formatError(error), tone: 'danger' }),
  });
  const rows = rules.data?.rules ?? [];

  async function deleteRule(rule: PermissionRuleRecord): Promise<void> {
    if (rule.effect === 'deny') {
      const ok = await confirm.ask({
        title: 'Delete this deny rule?',
        description: 'Calls this rule refuses will no longer be refused by it; your setting for when GoodVibes asks decides them, which may allow them without asking.',
        tone: 'danger',
        confirmLabel: 'Delete rule',
      });
      if (!ok) return;
    }
    remove.mutate(rule.id);
  }

  return (
    <SettingsBlock
      title="Approval rules"
      description="Approving with a Remember scope (exact command, command class, path or tool) records a rule here. Delete one and your setting for when GoodVibes asks decides matching calls again: an allow rule's calls may prompt again, a deny rule's calls are no longer refused by it."
      actions={<IconButton label="Refresh rules" icon={<RefreshCw />} onClick={() => void rules.refetch()} />}
      testId="permission-rules"
    >
      {confirm.element}
      {rules.isPending && <p className="settings-empty">Loading rules…</p>}
      {rules.isError && (
        <p className="settings-empty" role="alert">
          Could not load approval rules: {formatError(rules.error)}{' '}
          <Button size="sm" variant="ghost" onClick={() => void rules.refetch()}>Retry</Button>
        </p>
      )}
      {rules.isSuccess && rows.length === 0 && <p className="settings-empty">No approval rules yet.</p>}
      {rows.length > 0 && (
        <RowList aria-label="Approval rules">
          {rows.map((rule) => (
            <Row
              key={rule.id}
              className="permission-rule-row"
              leading={<StatusDot tone={rule.effect === 'deny' ? 'bad' : 'ok'} srLabel={rule.effect} />}
              title={ruleSummary(rule)}
              // Where it is in force: the project by its name, or every project.
              meta={[rule.description ?? '', rule.project ? `in ${projectName(rule.project)}` : carriedFrom(rule) ? `Every project (carried from ${carriedFrom(rule)})` : 'every project', whenLabel(rule.createdAt) && `created ${whenLabel(rule.createdAt)}`].filter(Boolean).join(' · ')}
              trailing={(
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 aria-hidden="true" />}
                  disabled={remove.isPending && remove.variables === rule.id}
                  aria-label={`Delete rule: ${ruleSummary(rule)}`}
                  title="Delete this rule: your setting for when GoodVibes asks decides matching calls again"
                  onClick={() => void deleteRule(rule)}
                >
                  {remove.isPending && remove.variables === rule.id ? 'Deleting…' : 'Delete'}
                </Button>
              )}
            />
          ))}
        </RowList>
      )}
    </SettingsBlock>
  );
}

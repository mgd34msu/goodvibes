/**
 * PrincipalsView, read-first admin over the named-identity registry (principals.*)
 * and per-channel profile bindings (channels.profiles.*).
 *
 * Who is who (the principals registry; the screen never says "principal"):
 * list every person, bot or service with their chat accounts (principals.list);
 * create/update/delete each go through a confirm sheet, these mutate who a channel
 * message resolves to, and delete is permanent (delete-means-delete, an honest
 * `deleted` boolean, never a phantom-removal 200).
 *
 * Channel profiles: list every surface/channel binding (channels.profiles.list), the
 * model/provider/permission defaults a channel's originated sessions inherit, with
 * set (upsert) and delete (behind a confirm sheet).
 *
 * Neither family emits a wire event yet (a standing gap shared with fleet.*,
 * checkpoints.*, ci.*, checkin.*, see queryKeys.principals/channelProfiles), so
 * freshness comes from mutation-driven invalidation and a manual refresh.
 */

import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, Users } from 'lucide-react';
import { ReadAt } from '../../components/data-view/ReadAt';
import { client as platformClient } from '../../lib/goodvibes';
import type { OperatorMethodInput, OperatorMethodOutput } from '../../lib/goodvibes';
import { NO_EVENT_LIST_FRESHNESS, queryKeys } from '../../lib/queries';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { SkeletonBlock } from '../../components/feedback/SkeletonBlock';
import { Button } from '../../components/ui/Button';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { IconButton } from '../../components/ui/IconButton';
import { Row, RowList } from '../../components/ui/Row';
import { SettingsBlock } from '../../components/settings/dialog/parts';
import { formatError, isMethodUnavailableError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Select } from '../../components/ui/Select';
import '../../styles/components/principals.css';
import { GATE_PRESETS, SESSION_GATE_PRESET_NAMES } from '@goodvibes/engine/platform/platform/gate/presets';

type Principal = OperatorMethodOutput<'principals.list'>['principals'][number];
type PrincipalKind = Principal['kind'];
type ChannelBinding = OperatorMethodOutput<'channels.profiles.list'>['bindings'][number];
type PermissionMode = NonNullable<ChannelBinding['permissionMode']>;

const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'bot', 'service', 'token'];
const PERMISSION_MODES: readonly PermissionMode[] = SESSION_GATE_PRESET_NAMES;

/**
 * One "channel:value" pair per line, the simplest phone-friendly encoding for a
 * repeatable field without a dynamic row-add control. Blank lines are skipped; a
 * line that is not a full pair is reported, never dropped, because an update
 * replaces the whole identity list and a dropped line would delete a mapping.
 */
function parseIdentityDraft(draft: string): {
  identities: NonNullable<OperatorMethodInput<'principals.create'>['identities']>;
  invalidLines: string[];
} {
  const identities: { channel: string; value: string }[] = [];
  const invalidLines: string[] = [];
  for (const line of draft.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [channel, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (channel.trim() && value) identities.push({ channel: channel.trim(), value });
    else invalidLines.push(line);
  }
  return { identities, invalidLines };
}

/** "no chat accounts", "1 chat account", "3 chat accounts". */
function identityCount(count: number): string {
  if (count === 0) return 'no chat accounts';
  return `${String(count)} chat ${count === 1 ? 'account' : 'accounts'}`;
}

function identitiesToDraft(identities: Principal['identities']): string {
  return identities.map((i) => `${i.channel}:${i.value}`).join('\n');
}

function PrincipalForm({
  initial,
  onSubmit,
  onCancel,
  submitting,
  submitLabel,
}: {
  initial?: Pick<Principal, 'name' | 'kind' | 'identities'>;
  onSubmit: (input: { name: string; kind: PrincipalKind; identities: OperatorMethodInput<'principals.create'>['identities'] }) => void;
  onCancel: () => void;
  submitting: boolean;
  submitLabel: string;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<PrincipalKind>(initial?.kind ?? 'user');
  const [identitiesDraft, setIdentitiesDraft] = useState(initial ? identitiesToDraft(initial.identities) : '');

  const parsed = parseIdentityDraft(identitiesDraft);
  const identitiesError = parsed.invalidLines.length > 0
    ? `Not a "channel:value" pair: ${parsed.invalidLines.join(', ')}`
    : undefined;

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!name.trim() || identitiesError) return;
    onSubmit({ name: name.trim(), kind, identities: parsed.identities });
  }

  return (
    <form className="principals-form" onSubmit={handleSubmit}>
      <Field label="Name">
        <Input type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={submitting} required />
      </Field>
      <Field label="Kind">
        <Select<PrincipalKind>
          aria-label="Kind"
          value={kind}
          onChange={setKind}
          disabled={submitting}
          options={PRINCIPAL_KINDS.map((k) => ({ value: k, label: k }))}
        />
      </Field>
      <Field label="Chat accounts" help={'One per line, the chat app then the account: "slack:U123ABC".'} error={identitiesError}>
        <Textarea
          value={identitiesDraft}
          onChange={(e) => setIdentitiesDraft(e.target.value)}
          placeholder="slack:U123ABC"
          rows={3}
          disabled={submitting}
        />
      </Field>
      <div className="principals-form__actions">
        <Button type="submit" variant="primary" size="sm" disabled={submitting || !name.trim() || Boolean(identitiesError)}>{submitting ? 'Saving…' : submitLabel}</Button>
        <Button size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
      </div>
    </form>
  );
}

function PrincipalsSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState('');

  const list = useQuery({
    queryKey: queryKeys.principals,
    queryFn: () => platformClient.operator.principals.list(),
    ...NO_EVENT_LIST_FRESHNESS,
  });
  const principals = list.data?.principals ?? [];
  const unavailable = list.isError && isMethodUnavailableError(list.error);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.principals });

  const create = useMutation({
    mutationFn: (input: OperatorMethodInput<'principals.create'>) => platformClient.operator.principals.create(input),
    onSuccess: async () => {
      setShowCreate(false);
      await invalidate();
      toast({ title: 'Added', tone: 'success' });
    },
    onError: (error: unknown) => toast({ title: 'Could not add them', description: formatError(error), tone: 'danger' }),
  });

  const update = useMutation({
    mutationFn: ({ principalId, input }: { principalId: string; input: Omit<OperatorMethodInput<'principals.update'>, 'principalId'> }) =>
      platformClient.operator.principals.update(principalId, input),
    onSuccess: async () => {
      setEditingId('');
      await invalidate();
      toast({ title: 'Changes saved', tone: 'success' });
    },
    onError: (error: unknown) => toast({ title: 'Could not save the changes', description: formatError(error), tone: 'danger' }),
  });

  const remove = useMutation({
    mutationFn: (principalId: string) => platformClient.operator.principals.delete(principalId),
    onSuccess: async (result) => {
      if (!result.deleted) toast({ title: 'Already removed', description: 'Nobody with that id was on the list.', tone: 'info' });
      await invalidate();
    },
    onError: (error: unknown) => toast({ title: 'Could not remove them', description: formatError(error), tone: 'danger' }),
  });

  async function handleCreate(input: { name: string; kind: PrincipalKind; identities: OperatorMethodInput<'principals.create'>['identities'] }): Promise<void> {
    const ok = await confirm.ask({
      title: 'Add them to who is who?',
      target: input.name,
      description: `They are added as a ${input.kind} with ${identityCount(input.identities?.length ?? 0)}.`,
      confirmLabel: 'Add',
    });
    if (!ok) return;
    create.mutate(input);
  }

  async function handleUpdate(principal: Principal, input: { name: string; kind: PrincipalKind; identities: OperatorMethodInput<'principals.create'>['identities'] }): Promise<void> {
    const ok = await confirm.ask({
      title: 'Save these changes?',
      target: principal.name,
      description: `Its channel identities are replaced with the ${identityCount(input.identities?.length ?? 0)} listed here.`,
      confirmLabel: 'Save',
    });
    if (!ok) return;
    update.mutate({ principalId: principal.id, input });
  }

  async function handleDelete(principal: Principal): Promise<void> {
    const ok = await confirm.ask({
      title: 'Remove them from who is who?',
      target: principal.name,
      description: 'Messages from their chat accounts then show as from someone you have not added yet, until you add those accounts to someone again.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    remove.mutate(principal.id);
  }

  return (
    <SettingsBlock
      className="principals-section"
      title="Who is who"
      description="The people, bots and services messages from chat apps are said to come from."
      actions={(
        <div className="principals-section__actions">
          <Button size="sm" icon={<Plus aria-hidden="true" />} onClick={() => setShowCreate((v) => !v)}>
            Add a person, bot or service
          </Button>
          <ReadAt at={list.dataUpdatedAt} onRefresh={() => void list.refetch()} refreshing={list.isFetching} />
        </div>
      )}
    >
      {confirm.element}

      {showCreate && (
        <PrincipalForm submitting={create.isPending} submitLabel="Create" onCancel={() => setShowCreate(false)} onSubmit={(input) => void handleCreate(input)} />
      )}

      {list.isPending && <SkeletonBlock variant="text" lines={4} />}
      {unavailable && <p className="principals-empty" role="note">This daemon does not keep a list of who is who.</p>}
      {list.isError && !unavailable && (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} title="Could not read who is who" />
      )}
      {list.isSuccess && principals.length === 0 && (
        <EmptyState
          icon={<Users size={28} />}
          title="Nobody added yet"
          description="Add a person, bot or service so messages from their chat accounts carry their name."
          action={{ label: 'Add a person, bot or service', onClick: () => setShowCreate(true) }}
        />
      )}

      {principals.length > 0 && (
        <RowList aria-label="Who is who">
          {principals.map((principal) => editingId === principal.id ? (
            <li key={principal.id} className="gv-row principals-row principals-row--editing">
              <PrincipalForm
                initial={principal}
                submitting={update.isPending}
                submitLabel="Save"
                onCancel={() => setEditingId('')}
                onSubmit={(input) => void handleUpdate(principal, input)}
              />
            </li>
          ) : (
            <Row
              key={principal.id}
              className="principals-row"
              title={principal.name}
              meta={[
                principal.kind,
                principal.identities.length === 0
                  ? 'no chat accounts'
                  : principal.identities.map((identity) => `${identity.channel}:${identity.value}`).join(', '),
              ].join(' · ')}
              trailing={(
                <>
                  <IconButton label={`Edit ${principal.name}`} icon={<Pencil aria-hidden="true" />} onClick={() => setEditingId(principal.id)} />
                  <IconButton
                    label={`Remove ${principal.name}`}
                    icon={<Trash2 aria-hidden="true" />}
                    onClick={() => void handleDelete(principal)}
                    disabled={remove.isPending}
                  />
                </>
              )}
            />
          ))}
        </RowList>
      )}
    </SettingsBlock>
  );
}

function ChannelProfileForm({
  initial,
  onSubmit,
  onCancel,
  submitting,
}: {
  initial?: Partial<ChannelBinding>;
  onSubmit: (input: OperatorMethodInput<'channels.profiles.set'>) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [surfaceKind, setSurfaceKind] = useState(initial?.surfaceKind ?? '');
  const [channelId, setChannelId] = useState(initial?.channelId ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [provider, setProvider] = useState(initial?.provider ?? '');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>(initial?.permissionMode ?? '');

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!surfaceKind.trim()) return;
    onSubmit({
      surfaceKind: surfaceKind.trim(),
      ...(channelId.trim() ? { channelId: channelId.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(provider.trim() ? { provider: provider.trim() } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    });
  }

  return (
    <form className="principals-form" onSubmit={handleSubmit}>
      <Field label="Surface kind">
        <Input type="text" value={surfaceKind} onChange={(e) => setSurfaceKind(e.target.value)} placeholder="slack" disabled={submitting || Boolean(initial?.surfaceKind)} required />
      </Field>
      <Field label="Channel id (optional)" help={initial ? 'A binding\'s channel cannot change; add a new binding to scope another channel.' : 'Scopes the binding to one channel.'}>
        <Input type="text" value={channelId} onChange={(e) => setChannelId(e.target.value)} disabled={submitting || Boolean(initial)} />
      </Field>
      <Field label="Model (optional)">
        <Input type="text" value={model} onChange={(e) => setModel(e.target.value)} disabled={submitting} />
      </Field>
      <Field label="Provider (optional)">
        <Input type="text" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={submitting} />
      </Field>
      <Field label="When GoodVibes asks (optional)">
        <Select<PermissionMode | ''>
          aria-label="When GoodVibes asks (optional)"
          value={permissionMode}
          onChange={setPermissionMode}
          disabled={submitting}
          options={[{ value: '', label: 'Unset' }, ...PERMISSION_MODES.map((mode) => ({ value: mode, label: GATE_PRESETS[mode].label }))]}
        />
      </Field>
      <div className="principals-form__actions">
        <Button type="submit" variant="primary" size="sm" disabled={submitting || !surfaceKind.trim()}>{submitting ? 'Saving…' : 'Save'}</Button>
        <Button size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
      </div>
    </form>
  );
}

function ChannelProfilesSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [showCreate, setShowCreate] = useState(false);
  const [editingKey, setEditingKey] = useState('');

  const list = useQuery({
    queryKey: queryKeys.channelProfiles,
    queryFn: () => platformClient.operator.channels.profiles.list(),
    ...NO_EVENT_LIST_FRESHNESS,
  });
  const bindings = list.data?.bindings ?? [];
  const unavailable = list.isError && isMethodUnavailableError(list.error);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.channelProfiles });

  const set = useMutation({
    mutationFn: (input: OperatorMethodInput<'channels.profiles.set'>) => platformClient.operator.channels.profiles.set(input),
    onSuccess: async () => {
      setShowCreate(false);
      setEditingKey('');
      await invalidate();
      toast({ title: 'Channel profile saved', tone: 'success' });
    },
    onError: (error: unknown) => toast({ title: 'Failed to save channel profile', description: formatError(error), tone: 'danger' }),
  });

  const remove = useMutation({
    mutationFn: ({ surfaceKind, channelId }: { surfaceKind: string; channelId?: string }) => platformClient.operator.channels.profiles.delete(surfaceKind, channelId),
    onSuccess: async (result) => {
      if (!result.deleted) toast({ title: 'Binding already gone', description: 'No binding with that key existed.', tone: 'info' });
      await invalidate();
    },
    onError: (error: unknown) => toast({ title: 'Failed to delete channel profile', description: formatError(error), tone: 'danger' }),
  });

  async function handleDelete(binding: ChannelBinding): Promise<void> {
    const ok = await confirm.ask({
      title: 'Delete this channel profile binding?',
      target: binding.channelId ? `${binding.surfaceKind}:${binding.channelId}` : binding.surfaceKind,
      description: 'Sessions this channel originates will no longer inherit these defaults.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    remove.mutate({ surfaceKind: binding.surfaceKind, channelId: binding.channelId });
  }

  return (
    <SettingsBlock
      className="principals-section"
      title="Channel profiles"
      description="The model and permission defaults a channel's sessions start with."
      actions={(
        <div className="principals-section__actions">
          <Button size="sm" icon={<Plus aria-hidden="true" />} onClick={() => setShowCreate((v) => !v)}>
            New binding
          </Button>
          <ReadAt at={list.dataUpdatedAt} onRefresh={() => void list.refetch()} refreshing={list.isFetching} />
        </div>
      )}
    >
      {confirm.element}

      {showCreate && (
        <ChannelProfileForm submitting={set.isPending} onCancel={() => setShowCreate(false)} onSubmit={(input) => set.mutate(input)} />
      )}

      {list.isPending && <SkeletonBlock variant="text" lines={4} />}
      {unavailable && <p className="principals-empty" role="note">Channel profiles are unavailable on this daemon.</p>}
      {list.isError && !unavailable && (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} title="Failed to load channel profiles" />
      )}
      {list.isSuccess && bindings.length === 0 && (
        <EmptyState title="No channel profile bindings yet" description="Bind a surface (and optionally one channel within it) to model and permission defaults." />
      )}

      {bindings.length > 0 && (
        <RowList aria-label="Channel profiles">
          {bindings.map((binding) => {
            const key = `${binding.surfaceKind}:${binding.channelId ?? ''}`;
            const name = `${binding.surfaceKind}${binding.channelId ? `:${binding.channelId}` : ''}`;
            return editingKey === key ? (
              <li key={key} className="gv-row principals-row principals-row--editing">
                <ChannelProfileForm
                  initial={binding}
                  submitting={set.isPending}
                  onCancel={() => setEditingKey('')}
                  onSubmit={(input) => set.mutate(input)}
                />
              </li>
            ) : (
              <Row
                key={key}
                className="principals-row"
                title={name}
                meta={[
                  binding.model && `model: ${binding.model}`,
                  binding.provider && `provider: ${binding.provider}`,
                  binding.permissionMode,
                  binding.invalid && `needs attention: ${binding.invalid.reason}`,
                ].filter(Boolean).join(' · ') || 'Uses the defaults'}
                trailing={(
                  <>
                    <IconButton label={`Edit ${name}`} icon={<Pencil aria-hidden="true" />} onClick={() => setEditingKey(key)} />
                    <IconButton
                      label={`Delete ${name}`}
                      icon={<Trash2 aria-hidden="true" />}
                      onClick={() => void handleDelete(binding)}
                      disabled={remove.isPending}
                    />
                  </>
                )}
              />
            );
          })}
        </RowList>
      )}
    </SettingsBlock>
  );
}

export function PrincipalsView() {
  return (
    <div className="principals-view">
      <PrincipalsSection />
      <ChannelProfilesSection />
    </div>
  );
}

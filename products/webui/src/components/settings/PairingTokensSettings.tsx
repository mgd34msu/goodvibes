/**
 * PairingTokensSettings, the settings/security surface for per-device pairing
 * tokens (platform 1.8.0's pairing.tokens.* family), replacing the old single
 * shared token model. Lists every paired device (pairing.tokens.list: name,
 * created, last-seen), the token secret itself is NEVER served here; it is
 * only ever handed back once, at mint time (create/migrate/handoff.create),
 * which is why this list never shows one.
 *
 * Pair a new device (PairNewDevice) runs the owner's pairing flow from here,
 * the same one `goodvibes pair` runs, and shows its link and QR code once.
 *
 * Two extra affordances, each with a plain-language description of what it
 * actually does:
 *
 *   - This browser: whether it acts as you. Signed in with your password, or
 *     holding a device you paired yourself, there is nothing to migrate and it
 *     says so. Otherwise (the shared token, an automation token) it becomes
 *     yours the one way any device does: you start it on your own screen
 *     (signed in as you: Pair a new device, "Show the sign-in code once") and
 *     type that code here. Nothing here mints a key: a key minted for whoever
 *     asks is never your device.
 *   - Revoke the shared token, gated by a danger confirm naming the exact
 *     consequence: the daemon replaces it, so every device still on the old
 *     value is signed out at once (this browser too if it has not migrated
 *     yet), while the apps on the daemon's machine read the new value and stay
 *     signed in. Once legacySharedRevoked is true the same act replaces the
 *     replacement, for when a copy of it may have left the daemon's machine.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { client as platformClient, getCurrentAuth, setExplicitAuthToken } from '../../lib/goodvibes';
import type { PublicPairingToken, PublicRelayCode, RemotePairRequest } from '../../lib/goodvibes';
import { NO_EVENT_LIST_FRESHNESS, queryKeys } from '../../lib/queries';
import { errorCode, formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { Input } from '../ui/Field';
import { IconButton } from '../ui/IconButton';
import { Row, RowList } from '../ui/Row';
import { EmptyState } from '../feedback/EmptyState';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import { SettingsBlock } from './dialog/parts';
import { PairNewDevice } from '../pairing/PairNewDevice';
import { whenLabel } from '../../lib/when-label';
import { getActiveRoute, unpairRelay } from '../../lib/relay-connection';

/** Who made a credential, in words (the daemon records it from this release on). */
function madeByWords(madeBy: unknown): string {
  const maker = madeBy !== null && typeof madeBy === 'object' ? madeBy as { owner?: unknown; caller?: unknown } : {};
  if (maker.owner === true) return 'made by you';
  if (typeof maker.caller === 'string' && maker.caller) return `made by ${maker.caller}, with your yes`;
  return 'made before this was recorded';
}
import { describeRelayPairingForConfirmation, getStoredRelayPairing } from '../../lib/relay-pairing';
import '../../styles/components/pairing-tokens.css';

export function PairingTokensSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  // Which paired token this browser is signed in with, so a row can say "this browser".
  const auth = useQuery({ queryKey: queryKeys.auth, queryFn: getCurrentAuth });
  const currentPrincipal = typeof auth.data === 'object' && auth.data !== null
    && typeof (auth.data as { principalId?: unknown }).principalId === 'string'
    ? (auth.data as { principalId: string }).principalId : null;

  const tokens = useQuery({
    queryKey: queryKeys.pairingTokens,
    queryFn: () => platformClient.operator.pairing.tokens.list(),
    ...NO_EVENT_LIST_FRESHNESS,
  });

  async function invalidateTokens(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.pairingTokens });
  }

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => platformClient.operator.pairing.tokens.rename(id, name),
    onSuccess: async (result, { id }) => {
      // Close only the editor this save belongs to, never another device's.
      setEditingId((current) => (current === id ? null : current));
      if (!result.renamed) {
        toast({ title: 'Rename failed', description: 'The daemon reported no such token.', tone: 'danger' });
      }
      await invalidateTokens();
    },
    onError: (error: unknown) => toast({ title: 'Rename failed', description: formatError(error), tone: 'danger' }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => platformClient.operator.pairing.tokens.delete(id),
    onSuccess: async (result) => {
      toast(
        result.revoked
          ? { title: 'Device revoked', description: 'It will be signed out the next time it tries to connect.', tone: 'info' }
          : { title: 'Already revoked', description: 'The daemon reported no such token.', tone: 'info' },
      );
      await invalidateTokens();
    },
    onError: (error: unknown) => toast({ title: 'Revoke failed', description: formatError(error), tone: 'danger' }),
  });

  // This browser becomes yours the one way a device does: with the sign-in code your own screen showed (a device you
  // paired yourself, signed in as you). The code is this browser's key; nothing is minted here.
  const [code, setCode] = useState('');
  const makeYours = useMutation({
    mutationFn: async (raw: string) => {
      await setExplicitAuthToken(raw);
      const now = await getCurrentAuth() as { principalId?: unknown };
      const listed = await platformClient.operator.pairing.tokens.list();
      const device = listed.tokens.find((token) => `pairing:${token.id}` === now.principalId);
      return { device };
    },
    onSuccess: async ({ device }) => {
      setCode('');
      await invalidateTokens();
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth });
      toast(device?.origin === 'owner-pairing'
        ? { title: 'This browser is your own device', description: `Signed in as "${device.name}", the device you paired on your own screen: it makes your own changes and answers questions other callers raised.`, tone: 'success' }
        : { title: 'Signed in, but not as your device', description: 'That code was not made on your own screen (signed in as you), so this browser is an ordinary device. Make the code where you are signed in as yourself: Pair a new device, "Show the sign-in code once".', tone: 'warning' });
    },
    onError: (error: unknown) => toast({ title: 'That code did not sign this browser in', description: `${formatError(error)} Each code works once and for 15 minutes: make a new one on your own screen.`, tone: 'danger' }),
  });

  const revokeShared = useMutation({
    mutationFn: (_replacing: boolean) => platformClient.operator.pairing.tokens.revokeShared(),
    onSuccess: async (_result, replacing) => {
      toast(replacing
        ? { title: 'Shared token replaced', description: 'The previous value no longer signs in anywhere; the apps on the daemon\'s machine read the new one.', tone: 'success' }
        : { title: 'Shared token revoked', description: 'Any device still using it is now signed out.', tone: 'success' });
      await invalidateTokens();
    },
    onError: (error: unknown, replacing) => toast({ title: replacing ? 'Replace failed' : 'Revoke failed', description: formatError(error), tone: 'danger' }),
  });

  async function handleRevoke(token: PublicPairingToken): Promise<void> {
    const ok = await confirm.ask({
      title: 'Revoke this device?',
      target: token.name,
      description: 'It is signed out now and has to pair again to reconnect.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    revoke.mutate(token.id);
  }

  async function handleRevokeShared(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Revoke the shared token?',
      description: 'Every device still using it is signed out now, this browser included if it has no token of its own. The daemon writes a new shared token for its own machine, so the terminal, the Agent and the daemon CLI there stay signed in.',
      confirmLabel: 'Revoke the shared token',
      tone: 'danger',
    });
    if (!ok) return;
    revokeShared.mutate(false);
  }

  async function handleReplaceShared(): Promise<void> {
    const ok = await confirm.ask({
      title: 'Replace the shared token?',
      description: 'The value the daemon\'s own machine holds stops signing in everywhere, including any copy that left that machine. The daemon writes a new one there, so the terminal, the Agent and the daemon CLI stay signed in.',
      confirmLabel: 'Replace the shared token',
      tone: 'danger',
    });
    if (!ok) return;
    revokeShared.mutate(true);
  }

  // One relay code per device paired through the relay: listed and revoked like a device token.
  const relayCodes = useQuery({
    queryKey: queryKeys.relayCodes,
    queryFn: () => platformClient.operator.relay.codes.list(),
  });
  const revokeRelayCode = useMutation({
    mutationFn: (id: string) => platformClient.operator.relay.codes.revoke(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.relayCodes });
      toast({ title: 'Relay code revoked', description: 'That device is refused at its next request through the relay. Every other device keeps working.', tone: 'success' });
    },
    onError: (error) => toast({ title: 'Could not revoke the relay code', description: formatError(error), tone: 'danger' }),
  });

  async function handleRevokeRelayCode(code: PublicRelayCode): Promise<void> {
    const ok = await confirm.ask({
      title: 'Revoke this relay code?',
      target: code.name,
      description: 'The device holding it can no longer reach the daemon through the relay; on the home network it still connects directly. It needs a new pairing code to use the relay again.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    revokeRelayCode.mutate(code.id);
  }

  // Devices asking to pair as a node (a browser's Phone node, a peer daemon). Read once when
  // this section opens, then again on the remote-pair-* events (useRealtimeInvalidation).
  const pairRequests = useQuery({
    queryKey: queryKeys.remotePairRequests,
    queryFn: () => platformClient.operator.remote.pairRequests.list(),
  });
  const pendingPairRequests = (pairRequests.data?.requests ?? []).filter((request) => request.status === 'pending');

  const approvePairRequest = useMutation({
    mutationFn: ({ id, confirmReplace }: { id: string; confirmReplace: boolean }) => platformClient.operator.remote.pairRequests.approve(id, confirmReplace),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.remotePairRequests });
      // Another machine's daemon finishes by itself; a phone finishes when Finish pairing is pressed on it.
      toast({
        title: 'Device approved',
        description: result.request.peerKind === 'node'
          ? `"${result.request.label}" finishes pairing by itself.`
          : `Press Finish pairing on "${result.request.label}" to complete it.`,
        tone: 'success',
      });
    },
  });
  const rejectPairRequest = useMutation({
    mutationFn: (id: string) => platformClient.operator.remote.pairRequests.reject(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.remotePairRequests });
      toast({ title: 'Pairing request rejected', description: 'That device is not paired; it has to ask again.', tone: 'info' });
    },
    onError: (error) => toast({ title: 'Could not reject the request', description: formatError(error), tone: 'danger' }),
  });

  async function handleApprovePairRequest(request: RemotePairRequest): Promise<void> {
    try {
      await approvePairRequest.mutateAsync({ id: request.id, confirmReplace: false });
    } catch (error: unknown) {
      if (errorCode(error) !== 'REMOTE_PAIR_REPLACES_PEER') {
        toast({ title: 'Could not approve the request', description: formatError(error), tone: 'danger' });
        return;
      }
      // The request names a device already paired: approving replaces that device's pairing.
      const ok = await confirm.ask({
        title: 'Replace the paired device?',
        target: request.requestedId,
        description: `"${request.label}" asks to pair as ${request.requestedId}, which is already paired. Approve only if it is that same device pairing again: its old pairing stops working.`,
        confirmLabel: 'Approve and replace',
        tone: 'danger',
      });
      if (!ok) return;
      try {
        await approvePairRequest.mutateAsync({ id: request.id, confirmReplace: true });
      } catch (replaceError: unknown) {
        toast({ title: 'Could not approve the request', description: formatError(replaceError), tone: 'danger' });
      }
    }
  }

  async function handleRejectPairRequest(request: RemotePairRequest): Promise<void> {
    const ok = await confirm.ask({
      title: 'Reject this pairing request?',
      target: request.label,
      description: 'The device is not paired and has to ask again.',
      confirmLabel: 'Reject',
      tone: 'danger',
    });
    if (!ok) return;
    rejectPairRequest.mutate(request.id);
  }

  const [relayPairing, setRelayPairing] = useState(() => getStoredRelayPairing());

  async function handleUnpairRelay(): Promise<void> {
    if (!relayPairing) return;
    // Asked only while this browser is reaching the daemon THROUGH the relay: then unpairing
    // cuts it off, and the pairing code that restores it cannot be fetched from here. Over
    // the direct address the relay is only a spare route, so it goes at once.
    if (getActiveRoute() === 'relay') {
      const { relayHost, fingerprint } = describeRelayPairingForConfirmation(relayPairing);
      const ok = await confirm.ask({
        title: 'Unpair from the relay?',
        target: relayHost,
        description: `This browser is connected through the relay (key ${fingerprint}). Unpairing switches it to the direct address, which works only on the daemon's own network; reconnecting through the relay needs a new pairing code from the daemon.`,
        confirmLabel: 'Unpair',
        tone: 'danger',
      });
      if (!ok) return;
    }
    unpairRelay();
    setRelayPairing(getStoredRelayPairing());
    toast({ title: 'Relay unpaired', description: 'This browser now connects directly. Scan a new pairing code from the daemon to use the relay again.', tone: 'success' });
  }

  function startRename(token: PublicPairingToken): void {
    setEditingId(token.id);
    setDraftName(token.name);
  }

  function saveRename(id: string): void {
    const name = draftName.trim();
    if (!name) return;
    rename.mutate({ id, name });
  }

  const rows = tokens.data?.tokens ?? [];
  const legacySharedRevoked = tokens.data?.legacySharedRevoked ?? false;
  // Whether this browser already acts as you: signed in as you (the daemon's own test, never inferred here), or holding
  // a device you paired yourself.
  const signedInAsYou = typeof auth.data === 'object' && auth.data !== null && (auth.data as { ownerHimself?: unknown }).ownerHimself === true;
  const thisBrowsersDevice = rows.find((token) => `pairing:${token.id}` === currentPrincipal);
  const yourDevice = thisBrowsersDevice?.origin === 'owner-pairing';

  return (
    <>
      {confirm.element}
      {pairRequests.isError && (
        <ErrorState error={pairRequests.error} onRetry={() => void pairRequests.refetch()} title="Failed to load pairing requests" />
      )}
      {pendingPairRequests.length > 0 && (
        <SettingsBlock
          testId="remote-pair-requests"
          title="Waiting to pair"
          description="A device asked to pair with this daemon. Approve only a device you recognise: a phone then finishes when Finish pairing is pressed on it; another machine's daemon finishes by itself."
        >
          <RowList aria-label="Waiting to pair">
            {pendingPairRequests.map((request) => (
              <Row
                key={request.id}
                className="pairing-token-row"
                title={request.label}
                meta={[
                  [request.platform, request.deviceFamily].filter(Boolean).join(', '),
                  request.capabilities.length > 0 ? `offers ${request.capabilities.join(', ')}` : 'offers nothing yet',
                  `pairs as ${request.requestedId}`,
                  request.remoteAddress && `asked from ${request.remoteAddress}`,
                  whenLabel(request.createdAt) && `asked ${whenLabel(request.createdAt)}`,
                ].filter(Boolean).join(' · ')}
                trailing={(
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={approvePairRequest.isPending || rejectPairRequest.isPending}
                      onClick={() => void handleApprovePairRequest(request)}
                    >
                      {approvePairRequest.isPending && approvePairRequest.variables?.id === request.id ? 'Approving…' : 'Approve'}
                    </Button>
                    <Button
                      variant="quiet-danger"
                      size="sm"
                      disabled={approvePairRequest.isPending || rejectPairRequest.isPending}
                      onClick={() => void handleRejectPairRequest(request)}
                    >
                      {rejectPairRequest.isPending && rejectPairRequest.variables === request.id ? 'Rejecting…' : 'Reject'}
                    </Button>
                  </>
                )}
              />
            ))}
          </RowList>
        </SettingsBlock>
      )}
      <SettingsBlock
        testId="pairing-tokens"
        title="Paired devices"
        description="Every paired phone or browser has its own token. Renaming or revoking one never affects another. A token is shown once, when it is created, so this list never shows one."
        actions={(
          <IconButton
            label="Refresh devices"
            icon={<RefreshCw aria-hidden="true" />}
            disabled={tokens.isFetching}
            onClick={() => void tokens.refetch()}
          />
        )}
      >
        {tokens.isPending && <SkeletonBlock variant="text" lines={3} />}

        {tokens.isError && (
          <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} title="Failed to load paired devices" />
        )}

        {tokens.isSuccess && rows.length === 0 && (
          <EmptyState
            icon={<Smartphone size={28} />}
            title="No per-device tokens yet"
            description="Pairing a device (goodvibes pair, or the hand-off QR) mints one automatically."
          />
        )}

        {tokens.isSuccess && rows.length > 0 && (
          <RowList aria-label="Paired devices">
            {rows.map((token) => editingId === token.id ? (
              <li key={token.id} className="gv-row pairing-token-row" data-token-id={token.id}>
                <form
                  className="pairing-token-row__rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveRename(token.id);
                  }}
                >
                  <Input
                    id={`pairing-token-rename-${token.id}`}
                    aria-label="Device name"
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    autoFocus
                  />
                  <Button type="submit" variant="primary" size="sm" disabled={rename.isPending || !draftName.trim()}>
                    Save
                  </Button>
                  <Button size="sm" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </form>
              </li>
            ) : (
              <Row
                key={token.id}
                className="pairing-token-row"
                title={token.name}
                meta={[
                  // How it came to exist: paired from a screen where you were signed in, or made as an automation token for a script.
                  token.origin === 'owner-pairing' ? 'paired device' : 'automation token',
                  // Who made it (recorded from this release on).
                  madeByWords((token as { madeBy?: unknown }).madeBy),
                  whenLabel(token.createdAt) && `Created ${whenLabel(token.createdAt)}`,
                  whenLabel(token.lastSeenAt) ? `last seen ${whenLabel(token.lastSeenAt)}` : 'never seen',
                  // What the device may do: its own scope list, or everything.
                  token.scopes && token.scopes.length > 0 ? `limited to ${token.scopes.join(', ')}` : 'full access',
                ].filter(Boolean).join(' · ')}
                trailing={(
                  <>
                    <IconButton
                      label={`Rename ${token.name}`}
                      icon={<Pencil aria-hidden="true" />}
                      onClick={() => startRename(token)}
                    />
                    <Button
                      variant="quiet-danger"
                      size="sm"
                      className="pairing-token-row__revoke"
                      icon={<Trash2 aria-hidden="true" />}
                      disabled={revoke.isPending && revoke.variables === token.id}
                      onClick={() => void handleRevoke(token)}
                    >
                      {revoke.isPending && revoke.variables === token.id ? 'Revoking…' : 'Revoke'}
                    </Button>
                  </>
                )}
              />
            ))}
          </RowList>
        )}

        <PairNewDevice confirm={confirm} />

        {tokens.isSuccess && rows.some((token) => `pairing:${token.id}` === currentPrincipal && token.origin !== 'owner-pairing') && (
          <p className="pairing-token-row__note" role="note">
            This browser is signed in with an automation token: a token made for a script rather than paired from a
            screen. It is yours like every token of this install; revoking it from the list signs this browser out. To give
            this browser a device of its own, use "This browser" below with the sign-in code your own screen shows, then
            revoke the automation token if nothing else uses it.
          </p>
        )}
      </SettingsBlock>

      {auth.isSuccess && (
        <SettingsBlock
          testId="this-browser"
          title="This browser"
          description={signedInAsYou
            ? 'This browser is signed in as you, with your password: it already acts as you. There is nothing to migrate.'
            : yourDevice
              ? `This browser is your own device ("${thisBrowsersDevice?.name ?? ''}"), paired on your own screen. There is nothing to migrate.`
              : 'This browser holds the shared token or an automation token, not a device of its own. To give it one, on a screen where you are signed in press Pair a new device, then "Show the sign-in code once", and type that code here. Or sign in here with your password.'}
        >
          {!signedInAsYou && !yourDevice && (
            <form
              className="pairing-token-row__rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (code.trim()) makeYours.mutate(code.trim());
              }}
            >
              <Input
                id="this-browser-code"
                type="password"
                autoComplete="off"
                aria-label="Sign-in code from your own screen"
                placeholder="Sign-in code from your own screen"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button type="submit" variant="primary" size="sm" disabled={makeYours.isPending || !code.trim()}>
                {makeYours.isPending ? 'Signing in…' : 'Make this browser yours'}
              </Button>
            </form>
          )}
        </SettingsBlock>
      )}

      <SettingsBlock
        title="Shared token"
        description={legacySharedRevoked
          ? 'The shared token was revoked and replaced. Only the apps on the daemon\'s own machine hold the new one; every other device uses its own token. Replace it again if a copy may have left that machine.'
          : 'Older devices may still be signed in with one shared token. Give each its own token before revoking the shared one: revoking signs out every device still using it, while the apps on the daemon\'s own machine get a new one and stay signed in.'}
      >
        {legacySharedRevoked && (
          <div className="pairing-tokens-legacy__actions">
            <Button
              variant="danger"
              className="pairing-tokens-legacy__revoke"
              disabled={revokeShared.isPending}
              onClick={() => void handleReplaceShared()}
            >
              {revokeShared.isPending ? 'Replacing…' : 'Replace the shared token'}
            </Button>
          </div>
        )}
        {!legacySharedRevoked && (
          <div className="pairing-tokens-legacy__actions">
            <Button
              variant="danger"
              className="pairing-tokens-legacy__revoke"
              disabled={revokeShared.isPending}
              onClick={() => void handleRevokeShared()}
            >
              {revokeShared.isPending ? 'Revoking…' : 'Revoke the shared token'}
            </Button>
          </div>
        )}
      </SettingsBlock>

      {relayCodes.isSuccess && relayCodes.data.codes.length > 0 && (
        <SettingsBlock
          testId="relay-codes"
          title="Relay devices"
          description="Every device paired through the relay has its own relay code. Revoking one cuts only that device off the relay, at its next request. A code is shown once, inside its pairing, so this list never shows one."
        >
          <RowList aria-label="Relay devices">
            {relayCodes.data.codes.map((code) => (
              <Row
                key={code.id}
                className="pairing-token-row"
                title={code.name}
                meta={[
                  whenLabel(code.createdAt) && `Created ${whenLabel(code.createdAt)}`,
                  whenLabel(code.lastSeenAt) ? `last used ${whenLabel(code.lastSeenAt)}` : 'not used yet',
                ].filter(Boolean).join(' · ')}
                trailing={(
                  <Button
                    variant="quiet-danger"
                    size="sm"
                    className="pairing-token-row__revoke"
                    icon={<Trash2 aria-hidden="true" />}
                    disabled={revokeRelayCode.isPending && revokeRelayCode.variables === code.id}
                    onClick={() => void handleRevokeRelayCode(code)}
                  >
                    {revokeRelayCode.isPending && revokeRelayCode.variables === code.id ? 'Revoking…' : 'Revoke'}
                  </Button>
                )}
              />
            ))}
          </RowList>
        </SettingsBlock>
      )}

      {relayPairing && (
        <SettingsBlock
          testId="relay-pairing"
          title="Relay"
          description={`This browser reaches its daemon through the relay at ${describeRelayPairingForConfirmation(relayPairing).relayHost}.`}
        >
          <Button variant="danger" onClick={() => void handleUnpairRelay()}>Unpair relay</Button>
        </SettingsBlock>
      )}
    </>
  );
}

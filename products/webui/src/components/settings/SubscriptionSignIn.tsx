/**
 * A subscription sign-in made from this page, through the daemon
 * (`providers.subscription.signIn.begin` / `.finish`, the same path as the
 * terminal's `/provider sign-in`). "Sign in" asks the daemon to start it and
 * shows the provider's sign-in page as a link. When the provider comes back to
 * the daemon's own computer, the daemon finishes by itself; otherwise the page
 * the person ends on shows a code (or an address that does not open), which is
 * pasted here. Either way the daemon announces the provider changed
 * (PROVIDERS_CHANGED, the `providers` frame), the provider list is read again,
 * and this row stops asking: nothing here waits on a timer.
 */
import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invokeOwnerMethod } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { queryKeys } from '../../lib/queries';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';

interface SignInStarted {
  readonly provider: string;
  readonly authorizationUrl: string;
  readonly finishes: 'on-its-own' | 'paste';
  readonly listenerNote?: string;
}

function readStarted(value: unknown): SignInStarted {
  const record = (value ?? {}) as Partial<SignInStarted>;
  if (typeof record.authorizationUrl !== 'string' || !record.authorizationUrl) throw new Error('The daemon did not answer with a sign-in page.');
  return {
    provider: typeof record.provider === 'string' ? record.provider : '',
    authorizationUrl: record.authorizationUrl,
    finishes: record.finishes === 'on-its-own' ? 'on-its-own' : 'paste',
    ...(typeof record.listenerNote === 'string' && record.listenerNote ? { listenerNote: record.listenerNote } : {}),
  };
}

export function SubscriptionSignIn({ provider, label = 'Sign in' }: { provider: string; label?: string }) {
  const queryClient = useQueryClient();
  const [started, setStarted] = useState<SignInStarted | null>(null);
  const [code, setCode] = useState('');
  const reread = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
      queryClient.invalidateQueries({ queryKey: ['models'] }),
      queryClient.invalidateQueries({ queryKey: ['providers', provider] }),
    ]);
  };
  const begin = useMutation({
    mutationFn: async () => readStarted(await invokeOwnerMethod('providers.subscription.signIn.begin', { provider })),
    onSuccess: (answer) => { setStarted(answer); setCode(''); },
  });
  const finish = useMutation({
    mutationFn: (pasted: string) => invokeOwnerMethod('providers.subscription.signIn.finish', { provider, code: pasted }),
    onSuccess: async () => { setStarted(null); setCode(''); await reread(); },
  });

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (code.trim() && !finish.isPending) finish.mutate(code.trim());
  };

  if (!started) {
    return (
      <span className="settings-signin">
        <Button size="sm" variant="outline" disabled={begin.isPending} onClick={(event) => { event.stopPropagation(); begin.mutate(); }}>
          {begin.isPending ? 'Starting…' : label}
        </Button>
        {begin.error != null && <span className="settings-signin__error" role="alert">The sign-in did not start: {formatError(begin.error)}</span>}
      </span>
    );
  }

  return (
    <form className="settings-signin settings-signin--open" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
      <span className="settings-signin__step">
        <a href={started.authorizationUrl} target="_blank" rel="noreferrer noopener">Open {provider}&apos;s sign-in page</a>
        {started.finishes === 'on-its-own'
          ? ' and sign in there. This row updates by itself when it is done. If that page ends on a code or an address that does not open, paste it here:'
          : ' and sign in there, then paste the code (or the whole address) the page ends on:'}
      </span>
      {started.listenerNote && <span className="settings-signin__note">{started.listenerNote}</span>}
      <span className="settings-signin__paste">
        <Input
          aria-label={`The code or address ${provider}'s page ended on`}
          placeholder="Code or address"
          value={code}
          autoComplete="off"
          onChange={(event) => setCode(event.target.value)}
        />
        <Button size="sm" type="submit" variant="primary" disabled={!code.trim() || finish.isPending}>
          {finish.isPending ? 'Finishing…' : 'Finish'}
        </Button>
      </span>
      {finish.error != null && <span className="settings-signin__error" role="alert">Not signed in: {formatError(finish.error)}</span>}
    </form>
  );
}

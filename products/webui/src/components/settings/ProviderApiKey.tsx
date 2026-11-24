/**
 * A provider's API key, given from this page through the daemon
 * (`providers.apiKey.set`): the key goes to the daemon's secret store under the
 * provider's own key name, the daemon reads its credentials again and announces
 * the provider changed (the `providers` frame), so the row turns signed in.
 * The field is a password field, cleared once the daemon has the key; no key is
 * ever read back or shown. Replacing a key is the same field.
 */
import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { invokeOwnerMethod } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { queryKeys } from '../../lib/queries';
import { Button } from '../ui/Button';
import { Input } from '../ui/Field';

export function ProviderApiKey({ provider, title, opener, replacing = false }: {
  /** The provider id `providers.apiKey.set` takes. */
  provider: string;
  /** The provider's name as the page shows it. */
  title: string;
  /** On a row: the field opens from this button. In the provider's detail: none, the field shows at once. */
  opener?: string;
  /** A key is already in use: the field replaces it. */
  replacing?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(!opener);
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (value: string) => invokeOwnerMethod('providers.apiKey.set', { provider, key: value }),
    onSuccess: async () => {
      setKey('');
      setSaved(true);
      if (opener) setOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['providers', provider] }),
      ]);
    },
  });

  if (!open) {
    return (
      <span className="settings-signin">
        <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); setSaved(false); setOpen(true); }}>
          {opener}
        </Button>
      </span>
    );
  }

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (key.trim() && !save.isPending) save.mutate(key.trim());
  };

  return (
    <form className="settings-signin settings-signin--open" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
      <span className="settings-signin__paste">
        <Input
          type="password"
          aria-label={`${title} API key`}
          placeholder={replacing ? 'New API key' : 'API key'}
          value={key}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(event) => { setSaved(false); setKey(event.target.value); }}
        />
        <Button size="sm" type="submit" variant="primary" disabled={!key.trim() || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </span>
      {saved && !opener && <span className="settings-signin__note" role="status">Saved. GoodVibes keeps the key; it is not shown again.</span>}
      {save.error != null && <span className="settings-signin__error" role="alert">The key was not saved: {formatError(save.error)}</span>}
    </form>
  );
}

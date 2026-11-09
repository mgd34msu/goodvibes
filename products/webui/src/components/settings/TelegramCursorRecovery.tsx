import { useEffect, useRef, useState } from 'react';
import type { TelegramCursorPreview } from '@goodvibes-jev/engine/platform/platform/channels/telegram-cursor';
import { client as platformClient } from '../../lib/goodvibes';
import { subscribeClientLifetime } from '../../lib/client-lifetime';
import { formatError } from '../../lib/errors';
import { Button } from '../ui/Button';
import { SettingsBlock } from './dialog/parts';

/** Explicit administrative repair. Neither a refresh nor reconnect writes a
 * cursor, and a lost write response is never automatically retried. */
export function TelegramCursorRecovery() {
  const active = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<TelegramCursorPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => subscribeClientLifetime(() => {
    active.current?.abort(); active.current = null;
    setPreview(null); setConfirmed(false); setPending(false); setMessage('');
  }), []);
  const inspect = async () => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setPending(true); setPreview(null); setConfirmed(false); setMessage('');
    try {
      const result = await platformClient.operator.channels.telegramCursor.preview(controller.signal);
      if (!controller.signal.aborted) setPreview(result);
    } catch (error) { if (!controller.signal.aborted) setMessage(formatError(error)); }
    finally { if (active.current === controller) active.current = null; if (!controller.signal.aborted) setPending(false); }
  };
  const migrate = async () => {
    if (active.current || !confirmed || preview?.state !== 'unbound') return;
    const selected = preview, controller = new AbortController(); active.current = controller;
    setPending(true); setPreview(null); setConfirmed(false); setMessage('');
    try {
      const result = await platformClient.operator.channels.telegramCursor.commit(selected, controller.signal);
      if (!controller.signal.aborted) setMessage(result.message);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(`${formatError(error)} Review the cursor and channel status before trying again.`);
    } finally { if (active.current === controller) active.current = null; if (!controller.signal.aborted) setPending(false); }
  };
  return <SettingsBlock title="Telegram cursor recovery" description="When polling stops because a previous cursor has no bot identity, verify which bot owns that saved position. Selecting the wrong bot can skip its waiting messages.">
    <Button size="sm" disabled={pending} onClick={() => { void inspect(); }}>{pending ? 'Working…' : 'Review saved Telegram cursor'}</Button>
    {preview?.state === 'not-needed' && <p role="status">{preview.message}</p>}
    {preview?.state === 'unbound' && <div>
      <p>Selected bot: @{preview.username} ({preview.accountId})</p>
      <p>Last saved: {new Date(preview.updatedAt).toLocaleString()} · position {preview.offset}</p>
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} /> This saved cursor belongs to this bot.</label>
      <Button disabled={pending || !confirmed} onClick={() => { void migrate(); }}>Keep saved position and restart polling</Button>
    </div>}
    {message && <p role="status">{message}</p>}
  </SettingsBlock>;
}

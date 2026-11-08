import { readTelegramCursorPreview, readTelegramCursorMigrationResult, type TelegramCursorPreview } from '@goodvibes-jev/engine/sdk/platform/channels/telegram-cursor';
import { RetainedOperatorConnection } from './retained-operator-connection.js';
import type { PaymentWindowCommandContext, PaymentWindowCommandPolicy } from './payment-window-command.js';
import type { SelectionItem, SelectionResult } from './selection-modal.js';
import { isPairedOperatorPrincipal } from './native/native-paired-principal.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';

/** One controller shared by both terminals; products only choose their own
 * host/credential policy. Typed owner gestures cannot be supplied by a model. */
export function createTelegramCursorCommand<Context extends PaymentWindowCommandContext>(policy: PaymentWindowCommandPolicy<Context>) {
  return async (context: Context): Promise<void> => {
    if (!policy.isOwner(context)) { context.print('[telegram] Open /channels telegram-cursor directly in the owner terminal.'); return; }
    const open = context.openSelection;
    if (!open) { context.print('[telegram] Cursor recovery needs an owner selection view.'); return; }
    const abort = new AbortController();
    let connection: RetainedOperatorConnection;
    try { connection = new RetainedOperatorConnection({ owner: () => policy.owner(context), home: () => policy.home(context),
      read: observation => policy.read(context, observation), files: policy.files,
      environment: policy.environment, fetchImpl: policy.fetchImpl, signal: abort.signal }); }
    catch { context.print('[telegram] Check the selected host and paired administrative credential, then reopen cursor recovery.'); return; }
    let closed = false, replacing = false, picker: AbortController | undefined, principal: string | undefined;
    const finish = () => { if (closed) return; closed = true; abort.abort(); picker?.abort(); void connection.close(); };
    const report = (message: string) => { if (!closed) { context.print(message); context.renderRequest(); } };
    const show = (title: string, items: SelectionItem[], choose: (result: SelectionResult) => void) => {
      if (closed) return;
      connection.assertCurrent();
      if (context.openSelection !== open) throw new Error('Selection owner changed');
      replacing = true; try { picker?.abort(); } finally { replacing = false; }
      picker = new AbortController();
      open.call(context, title, items, { allowSearch: false, primaryVerbLabel: 'Choose', signal: AbortSignal.any([connection.signal, picker.signal]) }, result => {
        if (closed || replacing) return;
        if (!result || result.action !== 'select') { finish(); return; }
        try { connection.assertCurrent(); choose(result); }
        catch { report('[telegram] The selected host changed. Reopen cursor recovery.'); finish(); }
      });
    };
    const authenticate = async () => {
      const auth = await connection.run((operator, signal) => operator.control.auth.current({}, { signal }));
      if (!isPairedOperatorPrincipal(auth, ['read:channels', 'write:channels'], connection.expectedPrincipalId)
        || principal !== undefined && principal !== auth.principalId) throw new Error('Administrative channel owner required');
      principal = auth.principalId;
    };
    const action = (actionId: string, body: Record<string, unknown> = {}) => connection.run((operator, signal) => operator.invoke(
      'channels.actions.invoke', { surface: 'telegram', actionId, ...body },
      { signal, headers: { 'x-goodvibes-explicit-user-request': 'true' } },
    ));
    const commit = async (preview: Extract<TelegramCursorPreview, { readonly state: 'unbound' }>) => {
      let dispatched = false;
      try {
        show('Saving Telegram cursor — Escape closes this view', [], () => {});
        await authenticate(); dispatched = true;
        const response = await action('cursor-migration-commit', { previewId: preview.previewId, confirm: true });
        const result = readTelegramCursorMigrationResult(response.result);
        if (result.accountId !== preview.accountId || result.offset !== preview.offset) throw new Error('Different cursor acknowledgement');
        report(`[telegram] ${result.message}`); finish();
      } catch {
        report(dispatched ? '[telegram] Could not confirm migration. Refresh cursor recovery and channel status before trying again.'
          : '[telegram] The host or credential changed. Reopen cursor recovery.'); finish();
      }
    };
    try {
      show('Reading Telegram cursor — Escape cancels', [], () => {});
      await authenticate();
      const response = await action('cursor-migration-preview');
      const preview = readTelegramCursorPreview(response.result);
      if (preview.state === 'not-needed') { report(`[telegram] ${preview.message}`); finish(); return; }
      const username = stripDangerousAnsi(preview.username);
      const detail = `Bot: @${username} (${preview.accountId})\nSaved: ${new Date(preview.updatedAt).toLocaleString()}\nSaved position: ${preview.offset}\n\nConfirm only if this saved cursor belongs to this bot. Selecting the wrong bot can skip its waiting messages. The saved position is kept unchanged.`;
      show('Confirm the bot for this saved Telegram cursor', [
        { id: 'keep-blocked', label: 'Leave polling stopped', detail },
        { id: 'migrate', label: `This cursor belongs to @${username} — migrate and restart`, detail },
      ], result => { if (result.item.id === 'migrate') void commit(preview); else finish(); });
    } catch { report('[telegram] Could not prepare cursor recovery. Check polling mode, the selected bot and its locally stored credential.'); finish(); }
  };
}

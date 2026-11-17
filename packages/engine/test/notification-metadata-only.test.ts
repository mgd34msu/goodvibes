// Proves: With notifications set to metadata only (the default), a notification, its retry or its file on disk carries what the turn was about.
// Red when: The envelope or the dead-letter codec writes the full text while the setting is on.
/**
 * Metadata-only notifications exist so a third-party chat service never holds
 * what the owner's work was about. Under the setting (on unless the owner
 * turned it off) neither the message sent, nor a failed notification's file,
 * nor a resend after the setting was turned on carries the turn's name, its
 * reason or its subject. With the setting off the same notification does,
 * which shows the strings are there to leak.
 *
 * Real notifier, delivery queue and dead-letter file; the Slack transport is
 * a stand-in that records or refuses, and the privacy setting is the reader
 * the test controls.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpStatusError } from '@goodvibes-jev/engine/errors';
import { Notifier } from '../platform/src/platform/integrations/notifier.ts';
import type { SlackIntegration } from '../platform/src/platform/integrations/slack.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PRIVATE = ['Plan the Acme merger', 'the merger memo is confidential', 'acme-merger-memo.md'];
const carries = (text: string) => PRIVATE.filter((value) => text.includes(value));

test('under metadata only the sent text, the failed notification\'s file and its resend carry nothing of what the turn was about', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-notify-metadata-'));
  dirs.push(dir);
  const file = join(dir, 'dead-letters.json');
  let metadataOnly: boolean | undefined;
  let refusing = false;
  const sent: string[] = [];
  const slack = {
    postWebhook: async (text: string) => {
      if (refusing) throw new HttpStatusError('HTTP 404: webhook revoked', { status: 404 });
      sent.push(text);
    },
  } as unknown as SlackIntegration;
  const notifier = new Notifier({ slack, metadataOnly: () => metadataOnly });
  notifier.persistDeadLetters(file);
  const turn = () => notifier.notifyNotification({ kind: 'turn', facts: {
    outcome: 'failed', elapsedMs: 42_000, name: PRIVATE[0], reason: PRIVATE[1], subject: PRIVATE[2], toolCalls: 3,
  } });

  try {
    // The owner turned the setting off: the content goes out (the control).
    metadataOnly = false;
    await turn();
    // The default: metadata only.
    metadataOnly = undefined;
    await turn();
    expect(sent.map(carries)).toEqual([PRIVATE.slice(0, 2), []]);

    // Failed while content was allowed: the setting is turned on before the resend.
    metadataOnly = false;
    refusing = true;
    await expect(turn()).rejects.toThrow();
    metadataOnly = undefined;
    refusing = false;
    const [allowedEntry] = notifier.listDeadLetters();
    expect(await notifier.replayDeadLetters([allowedEntry!.id])).toEqual([{ id: allowedEntry!.id, outcome: 'delivered' }]);
    expect(carries(sent.at(-1)!)).toEqual([]);

    // Failed under the setting: nothing of it reaches the file.
    refusing = true;
    await expect(turn()).rejects.toThrow();
    expect(notifier.listDeadLetters()).toHaveLength(1);
    expect(carries(readFileSync(file, 'utf8'))).toEqual([]);
  } finally {
    await notifier.close();
  }
});

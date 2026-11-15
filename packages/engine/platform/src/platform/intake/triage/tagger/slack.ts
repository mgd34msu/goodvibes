import { TAGS, attempt, current, json, notTried, providerCode, request, type TaggerGuard, type TaggerHttp,
  type TriageEffectResult, type TriageTagWrite } from './shared.js';

/** One prepared Slack mark: the label it stands for and its exact reaction name. */
export interface SlackReactionEffect { readonly tag: string; readonly reaction: string }

const SLACK_NEXT: Readonly<Record<string, string>> = {
  missing_scope: 'add the reactions:write scope to the Slack token',
  not_authed: 'replace the Slack token',
  invalid_auth: 'replace the Slack token',
  token_revoked: 'replace the Slack token',
  account_inactive: 'replace the Slack token',
  message_not_found: 'the message was deleted; nothing to label',
  channel_not_found: 'the conversation is gone or this token cannot see it',
  not_in_channel: 'add the Slack app to the conversation',
  ratelimited: 'try again in a minute',
  too_many_reactions: 'the message has the most reactions Slack allows',
};

/**
 * Put each label's reaction on one Slack message, then take off the reactions
 * of `remove` (the other built-in labels). Slack answers `already_reacted` and
 * `no_reaction` for marks that were already so; both are `already`.
 */
export async function applySlackReactions(target: { channel: string; timestamp: string }, add: readonly SlackReactionEffect[],
  remove: readonly SlackReactionEffect[], token: string, guard: TaggerGuard, http: TaggerHttp = fetch): Promise<TriageTagWrite> {
  if (!/^[A-Z0-9]+$/.test(target.channel) || !/^[0-9]+\.[0-9]+$/.test(target.timestamp)) throw new Error('Invalid Slack target');
  const known = (reaction: string) => Object.values(TAGS).some(tag => tag.slack === reaction);
  if ([...add, ...remove].some(effect => !known(effect.reaction))) throw new Error('Invalid Slack triage reaction');
  const effects: TriageEffectResult[] = [];
  const call = async (method: 'reactions.add' | 'reactions.remove', effect: SlackReactionEffect, action: 'add' | 'remove', unchanged: string): Promise<boolean> => {
    const response = await attempt('Slack', guard, () => request(http, `https://slack.com/api/${method}`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: target.channel, timestamp: target.timestamp, name: effect.reaction }) }, guard));
    if (typeof response === 'string') { effects.push({ tag: effect.tag, action, outcome: 'failed', reason: response }); return false; }
    let body: Record<string, unknown>;
    try { body = await json(response, guard, 'Slack'); }
    catch (error) {
      if (guard.signal.aborted) throw error;
      current(guard);
      effects.push({ tag: effect.tag, action, outcome: 'failed', reason: error instanceof Error ? error.message : 'Slack sent an unreadable answer' });
      return false;
    }
    current(guard);
    if (body.ok === true) { effects.push({ tag: effect.tag, action, outcome: 'applied' }); return true; }
    const code = providerCode(body.error);
    if (code === unchanged) { effects.push({ tag: effect.tag, action, outcome: 'already' }); return true; }
    const next = code ? SLACK_NEXT[code] : undefined;
    effects.push({ tag: effect.tag, action, outcome: 'failed',
      reason: `Slack refused the reaction${code ? ` (${code})` : ''}${next ? `; ${next}` : ''}` });
    return false;
  };
  for (const [index, effect] of add.entries()) {
    if (!await call('reactions.add', effect, 'add', 'already_reacted')) {
      effects.push(...notTried([...add.slice(index + 1).map(next => ({ tag: next.tag, action: 'add' as const })),
        ...remove.map(next => ({ tag: next.tag, action: 'remove' as const }))]));
      return { effects };
    }
  }
  for (const effect of remove) await call('reactions.remove', effect, 'remove', 'no_reaction');
  return { effects };
}

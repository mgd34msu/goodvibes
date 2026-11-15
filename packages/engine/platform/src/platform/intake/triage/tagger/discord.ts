import { TAGS, attempt, current, json, notTried, refusedBy, request, type TaggerGuard, type TaggerHttp,
  type TriageEffectResult, type TriageTagWrite } from './shared.js';

/** One prepared Discord mark: the label name, and its reaction when the label has a built-in meaning. */
export interface DiscordTagEffect { readonly name: string; readonly reaction?: string }

/** Read-only protocol observation. No caller-defined name or raw provider text is a semantic grant. */
export async function observeDiscordForumTags(target: { channel: string; message: string }, token: string, guard: TaggerGuard, http: TaggerHttp = fetch): Promise<readonly string[] | null> {
  if (!/^[0-9]+$/.test(target.channel) || !/^[0-9]+$/.test(target.message)) throw new Error('Invalid Discord target');
  const headers = { Authorization: `Bot ${token}` };
  const thread = await json(await request(http, `https://discord.com/api/v10/channels/${target.channel}`, { headers }, guard), guard, 'Discord');
  if (thread.id !== target.channel) throw new Error('Discord answered for a different channel than the one asked for');
  if (thread.type !== 11) return null;
  if (typeof thread.parent_id !== 'string' || !/^[0-9]+$/.test(thread.parent_id)) throw new Error('Discord did not say which forum the thread is in');
  const parent = await json(await request(http, `https://discord.com/api/v10/channels/${thread.parent_id}`, { headers }, guard), guard, 'Discord');
  if (parent.id !== thread.parent_id) throw new Error('Discord answered for a different forum than the one asked for');
  if (parent.type !== 15 && parent.type !== 16) return null;
  if (!Array.isArray(thread.applied_tags) || thread.applied_tags.some(id => typeof id !== 'string' || !/^[0-9]+$/.test(id))) throw new Error('Discord did not list the thread\'s forum tags');
  return Object.freeze([...thread.applied_tags as string[]]);
}

/**
 * Put each label on one Discord message and take off the marks of `remove`
 * (the other built-in labels). On a forum thread with configured forum tag ids
 * that is one PATCH of the thread's tag set: unrelated tags are kept, a label
 * with no mapped tag is `skipped`. Discord has no compare-and-set for that set,
 * so a tag someone else changes between the read and the PATCH can be lost.
 * Elsewhere it is reactions: the message is read once to see which marks this
 * bot already has, then only the missing ones are added and only the present
 * stale ones are removed. A forum-only preparation cannot silently fall back
 * after its admitted shape changes.
 */
export async function applyDiscordTagEffects(target: { channel: string; message: string }, add: readonly DiscordTagEffect[],
  remove: readonly DiscordTagEffect[], token: string, guard: TaggerGuard, forumTagIds: Readonly<Record<string, string | undefined>> = {},
  http: TaggerHttp = fetch, requireForum = false): Promise<TriageTagWrite> {
  if (!/^[0-9]+$/.test(target.channel) || !/^[0-9]+$/.test(target.message)) throw new Error('Invalid Discord target');
  if ([...add, ...remove].some(effect => effect.reaction !== undefined && !Object.values(TAGS).some(tag => tag.discord === effect.reaction))) throw new Error('Invalid Discord triage reaction');
  const headers = { Authorization: `Bot ${token}` };
  const base = `https://discord.com/api/v10/channels/${target.channel}`;
  const forumId = (name: string): string | undefined => Object.hasOwn(forumTagIds, name) ? forumTagIds[name] : undefined;
  const mapped = add.map(effect => forumId(effect.name)).filter((id): id is string => id !== undefined);
  if ([...mapped, ...remove.map(effect => forumId(effect.name)).filter((id): id is string => id !== undefined)].some(id => !/^[0-9]+$/.test(id))) {
    throw new Error('Invalid Discord forum tag');
  }
  const failAll = (reason: string): TriageTagWrite => ({ effects: [
    ...add.map(effect => ({ tag: effect.name, action: 'add' as const, outcome: 'failed' as const, reason })),
    ...notTried(remove.map(effect => ({ tag: effect.name, action: 'remove' as const }))),
  ] });
  const failure = (error: unknown): string => {
    if (guard.signal.aborted) throw error;
    current(guard);
    return error instanceof Error && error.message ? error.message : 'Discord could not be reached; the label write can be tried again';
  };
  if (mapped.length || requireForum) {
    let existing: readonly string[] | null;
    try { existing = await observeDiscordForumTags(target, token, guard, http); } catch (error) { return failAll(failure(error)); }
    if (existing !== null) return applyForumTags(existing);
  }
  if (requireForum) throw new Error('Discord prepared forum target changed');
  if (add.some(effect => effect.reaction === undefined)) throw new Error('Discord reaction meaning unavailable');
  return applyReactions();

  async function applyForumTags(existing: readonly string[]): Promise<TriageTagWrite> {
    const present = new Set(existing);
    const stale = new Set(remove.map(effect => forumId(effect.name)).filter((id): id is string => id !== undefined && present.has(id)));
    const next = [...new Set([...existing.filter(id => !stale.has(id)), ...mapped])];
    if (next.length > 5) return failAll('Discord allows at most 5 tags on a forum post; remove one from this post and try again');
    const effects: TriageEffectResult[] = add.map((effect): TriageEffectResult => {
      const id = forumId(effect.name);
      if (id === undefined) return { tag: effect.name, action: 'add', outcome: 'skipped', reason: `No forum tag is mapped to ${effect.name} for this forum` };
      return { tag: effect.name, action: 'add', outcome: present.has(id) ? 'already' : 'applied' };
    });
    for (const effect of remove) {
      const id = forumId(effect.name);
      if (id !== undefined) effects.push({ tag: effect.name, action: 'remove', outcome: stale.has(id) ? 'applied' : 'already' });
    }
    if (!effects.some(effect => effect.outcome === 'applied')) return { effects };
    const response = await attempt('Discord', guard, () => request(http, base, { method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ applied_tags: next }) }, guard));
    current(guard);
    if (typeof response !== 'string' && (response.status === 200 || response.status === 204)) return { effects };
    const reason = typeof response === 'string' ? response : refusedBy('Discord', response);
    return { effects: effects.map(effect => effect.outcome === 'applied' ? { ...effect, outcome: 'failed' as const, reason } : effect) };
  }

  async function applyReactions(): Promise<TriageTagWrite> {
    let mine: Set<string>;
    try {
      const message = await json(await request(http, `${base}/messages/${target.message}`, { headers }, guard), guard, 'Discord');
      const reactions = Array.isArray(message.reactions) ? message.reactions as unknown[] : [];
      mine = new Set(reactions.flatMap(entry => {
        const reaction = entry as { readonly me?: unknown; readonly emoji?: { readonly name?: unknown } } | null;
        return reaction?.me === true && typeof reaction.emoji?.name === 'string' ? [reaction.emoji.name] : [];
      }));
    } catch (error) { return failAll(failure(error)); }
    const effects: TriageEffectResult[] = [];
    const send = async (effect: DiscordTagEffect, action: 'add' | 'remove'): Promise<boolean> => {
      if (mine.has(effect.reaction!) === (action === 'add')) { effects.push({ tag: effect.name, action, outcome: 'already' }); return true; }
      const call = () => request(http, `${base}/messages/${target.message}/reactions/${encodeURIComponent(effect.reaction!)}/@me`,
        { method: action === 'add' ? 'PUT' : 'DELETE', headers }, guard);
      let response = await attempt('Discord', guard, call);
      // Discord rate-limits reaction changes per message. Wait the asked time once.
      if (typeof response !== 'string' && response.status === 429) {
        const waitMs = retryAfterMs(response);
        if (waitMs !== null) { await pause(waitMs, guard.signal); current(guard); response = await attempt('Discord', guard, call); }
      }
      current(guard);
      if (typeof response !== 'string' && (response.status === 200 || response.status === 204)) {
        effects.push({ tag: effect.name, action, outcome: 'applied' }); return true;
      }
      effects.push({ tag: effect.name, action, outcome: 'failed', reason: typeof response === 'string' ? response : refusedBy('Discord', response) });
      return false;
    };
    for (const [index, effect] of add.entries()) {
      if (!await send(effect, 'add')) {
        effects.push(...notTried([...add.slice(index + 1).map(next => ({ tag: next.name, action: 'add' as const })),
          ...remove.filter(next => next.reaction !== undefined).map(next => ({ tag: next.name, action: 'remove' as const }))]));
        return { effects };
      }
    }
    for (const effect of remove) if (effect.reaction !== undefined) await send(effect, 'remove');
    return { effects };
  }
}

const MAX_RETRY_AFTER_MS = 5_000;

/** The wait Discord asked for, or null when it is missing or longer than a tagging pass should hold. */
function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const ms = Math.ceil(seconds * 1000);
  return ms <= MAX_RETRY_AFTER_MS ? ms : null;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

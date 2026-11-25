/**
 * question-card.ts, "A question for you" in both terminal programs (design
 * ux.md A2.3): a question an agent of this chat left in the owner inbox,
 * drawn as a question where the person is, pinned above the composer.
 *
 *     ? A question for you
 *
 *     Which greeting should be the default?
 *
 *      1  Hello                 (selected)
 *      2  Hi there
 *      3  Something else…   type it
 *
 *      ↑↓ choose   ⏎ answer   1-3 pick   esc answer later
 *
 * It is not a dialog: the screen behind it is not dimmed, and Esc leaves the
 * question in the inbox (`/questions` and the web UI's Waiting list still show
 * it). Choosing "Something else…" or typing opens a one-line answer. The answer
 * goes through the inbox (`inbox.answer`), and the card shows `Answered: Hello`
 * for one render, then goes. A question answered anywhere else goes at once.
 *
 * Its words are the inbox item's presentation (permissions/ask-presentation.ts
 * presentInboxAsk); the card builds none of its own.
 *
 * Cost: one listener on the inbox store's change feed (a watch on its WAL
 * file, which this program already holds for answers), one indexed list of
 * this chat's open questions when a change arrives; nothing per frame or turn.
 */
import {
  answerSessionOf,
  type OwnerAnswer,
  type OwnerInboxListFilter,
  type OwnerItem,
} from '@goodvibes/engine/platform/platform/control-plane';
import { presentInboxAsk, type AskFacts, type AskPresentation } from '@goodvibes/engine/platform/platform/permissions';
import { InputTokenizer, type InputToken } from '@goodvibes/engine/platform/platform/core';
import { homeOwnerInbox } from '@goodvibes/engine/platform/platform/runtime/client';
import { getDisplayWidth } from '@goodvibes/engine/platform/platform/utils/terminal-width';
import { createEmptyCell } from '@goodvibes/engine/platform/platform/types/grid';
import { activeTokens } from './renderer/theme.js';
import { routeCardInput, type CardTypeahead } from './blocking-permission-input.js';
import { beginModal, finishModal, layoutHintRows, modalInnerWidth, standardModalWidth, wrapLines, type KitHint, type SurfaceLayer } from './renderer/surface-kit.js';
import { paintKeycapHints } from './renderer/surface-kit-parts.js';
import type { KeyCombo } from './keybindings.js';

/** The inbox the card reads and answers: the home's one store. */
export interface QuestionCardInbox {
  subscribe(listener: (item: OwnerItem) => void): () => void;
  listNow(filter?: OwnerInboxListFilter): readonly OwnerItem[];
  answer(id: string, answer: OwnerAnswer): Promise<{ readonly applied: boolean; readonly refusal?: { readonly reason: string } | undefined }>;
}

export interface QuestionCardDeps {
  readonly inbox: QuestionCardInbox;
  /** The chat this program shows. */
  readonly sessionId: () => string | undefined;
  readonly facts: () => AskFacts;
  readonly render: () => void;
  /** An answer that was not taken (answered elsewhere first, or the store refused it). */
  readonly notify: (message: string) => void;
  /**
   * The key table: the card's arrows, Enter and Esc are its move-up, move-down,
   * choose and back (a key bound to one of them is that key here; a navigation
   * key given to another action is not the card's). Without it, the keys as pressed.
   */
  readonly keys?: {
    translateNavigation(token: InputToken & { type: 'key' }): { readonly kind: 'pass' } | { readonly kind: 'drop' } | { readonly kind: 'rewrite'; readonly token: InputToken & { type: 'key' } };
    /** Every key each action is bound to now, for the hint row (the same table). */
    getAll?(): ReadonlyArray<{ readonly action: string; readonly combos: readonly KeyCombo[] }>;
    formatCombo?(combo: KeyCombo): string;
  } | undefined;
}

/** The keys an action is bound to now, as a hint's keycap shows them (`esc`, `⏎`, `down/f1`); the fallback when the table says nothing. */
function boundKeys(keys: QuestionCardDeps['keys'], action: string, fallback: string): string {
  const combos = keys?.getAll?.().find((entry) => entry.action === action)?.combos;
  if (!combos || combos.length === 0 || !keys?.formatCombo) return fallback;
  const shown = combos.map((combo) => {
    const label = keys.formatCombo!(combo).toLowerCase();
    return label === 'escape' ? 'esc' : label === 'enter' ? '⏎' : label;
  });
  return shown.join('/');
}

/** The card's hint row with the keys as bound now: the arrows, Enter and Esc are the table's move-up, move-down, choose and back. */
function cardHints(keys: QuestionCardDeps['keys'], typing: boolean, choices: number): KitHint[] {
  const choose = boundKeys(keys, 'choose', '⏎');
  const back = boundKeys(keys, 'back', 'esc');
  if (typing) return [[choose, 'answer'], [back, 'back']];
  const up = boundKeys(keys, 'move-up', 'up');
  const down = boundKeys(keys, 'move-down', 'down');
  const move = up === 'up' && down === 'down' ? '↑↓' : `${up}/${down}`;
  return [[move, 'choose'], [choose, 'answer'], ...(choices > 1 ? [[`1-${choices}`, 'pick'] as const] : []), [back, 'answer later']];
}

/** One chunk as the card reads it: a navigation key through the table, or typed text. */
interface CardKey {
  readonly key?: string | undefined;
  readonly text?: string | undefined;
}

interface CardState {
  readonly item: OwnerItem;
  readonly presentation: AskPresentation;
  readonly index: number;
  /** The one-line answer is open, with what is typed. */
  readonly typing?: string | undefined;
  /** The card opened by itself: keys typed as it appears stay with the composer (routeCardInput). */
  readonly typeahead: CardTypeahead;
}

/** How long the answered line stays: long enough to be read, then it goes. */
const ANSWERED_MS = 1500;

const ESCAPE_TOKEN: InputToken & { type: 'key' } = { type: 'key', name: 'escape', logicalName: 'escape', ctrl: false, shift: false, meta: false };

/** Whether the item is a question this chat's agent or session asked. */
function askedHere(item: OwnerItem, sessionId: string | undefined): boolean {
  if (sessionId === undefined || item.kind !== 'question' || item.status !== 'open') return false;
  return item.sessionId === sessionId || answerSessionOf(item) === sessionId;
}

export class OwnerQuestionCard {
  readonly #deps: QuestionCardDeps;
  #state: CardState | null = null;
  /** Questions left for later with Esc in this run: they stay in the inbox. */
  readonly #later = new Set<string>();
  /** The answer just given, shown briefly ("Answered: Hello"), and until when. */
  #answered: string | null = null;
  #answeredUntil = 0;
  #stop: (() => void) | null = null;
  /** Whether the last frame drew the card: only a card on screen takes keys. */
  #drawn = false;

  constructor(deps: QuestionCardDeps) {
    this.#deps = deps;
  }

  /** Start following the inbox. Returns the function that stops it. */
  start(): () => void {
    this.#stop ??= this.#deps.inbox.subscribe((item) => this.#changed(item));
    // A question this chat left before this run (a resumed session) is shown too.
    this.refresh();
    return () => this.stop();
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }

  /** Whether a card (or its answered line) is on screen. */
  active(): boolean {
    return this.#state !== null || this.#answered !== null;
  }

  /** Set by the frame: whether it drew the card. */
  drawn(value: boolean): void {
    this.#drawn = value && this.#state !== null;
  }

  /** Look again for a question of this chat (a session switch, the first frame). */
  refresh(): void {
    if (this.#state !== null) return;
    const sessionId = this.#deps.sessionId();
    if (sessionId === undefined) return;
    let open: readonly OwnerItem[];
    try {
      open = this.#deps.inbox.listNow({ status: 'open', kinds: ['question'], sessionId });
    } catch {
      return; // an unreadable store shows no card; /questions reports why
    }
    const next = [...open].filter((item) => askedHere(item, sessionId) && !this.#later.has(item.id)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next) this.#show(next);
  }

  #show(item: OwnerItem): void {
    const facts = { ...this.#deps.facts(), currentSessionId: this.#deps.sessionId() };
    const presentation = presentInboxAsk(item, facts);
    const first = presentation.choices.findIndex((choice) => choice.default === true);
    this.#state = { item, presentation, index: Math.max(0, first), typeahead: { openedAt: Date.now() } };
  }

  #changed(item: OwnerItem): void {
    const state = this.#state;
    if (state && state.item.id === item.id) {
      // Answered, withdrawn or expired anywhere: the card goes.
      if (item.status !== 'open') { this.#state = null; this.refresh(); this.#deps.render(); }
      return;
    }
    if (state === null && askedHere(item, this.#deps.sessionId()) && !this.#later.has(item.id)) {
      this.#show(item);
      this.#deps.render();
    }
  }

  #send(answer: OwnerAnswer, shown: string): void {
    const state = this.#state;
    if (!state) return;
    this.#state = null;
    this.#answered = shown;
    this.#answeredUntil = Date.now() + ANSWERED_MS;
    // One timer per answer takes the line down; it never keeps the process alive.
    const timer = setTimeout(() => this.#deps.render(), ANSWERED_MS + 50);
    (timer as { unref?: (() => void) | undefined }).unref?.();
    const id = state.item.id;
    void this.#deps.inbox.answer(id, answer).then((outcome) => {
      if (!outcome.applied) this.#deps.notify(`Your answer was not recorded: ${outcome.refusal?.reason ?? 'the inbox refused it'}`);
    }, (error: unknown) => {
      this.#deps.notify(`Your answer was not recorded (${error instanceof Error ? error.message : String(error)}). It is still waiting in Waiting for you.`);
    }).finally(() => { this.refresh(); this.#deps.render(); });
  }

  /**
   * One key while the card is up. True when the card took it. The card takes
   * only its own keys: arrows, digits, Enter, Esc, and typing while the
   * one-line answer is open. Every other key goes to the composer.
   */
  /** A chunk read through the key table: one navigation key (as the table makes it), or text. */
  #read(data: string): CardKey {
    // A lone Esc is the whole key (the tokenizer would wait for what follows it).
    const tokens = data === '\x1b' ? [ESCAPE_TOKEN] : new InputTokenizer().feed(data);
    if (tokens.length !== 1) return {};
    const first = tokens[0]!;
    if (first.type === 'text') return { text: first.value };
    if (first.type !== 'key') return {};
    const read = this.#deps.keys?.translateNavigation(first);
    if (read?.kind === 'drop') return {};
    const token = read?.kind === 'rewrite' ? read.token : first;
    return token.ctrl || token.meta ? {} : { key: token.logicalName };
  }

  handleInput(data: string): boolean {
    const shown = this.#state;
    if (!shown || !this.#drawn) return false;
    const pressed = this.#read(data);
    // It opened by itself: a key typed as it appeared, or in the same burst, is the composer's (the caller
    // asks only while the composer is empty; with a draft every key is the composer's already).
    const routed = shown.typeahead.addressed ? undefined : routeCardInput(data, shown.typeahead, Date.now());
    const state: CardState = routed ? { ...shown, typeahead: routed.card } : shown;
    this.#state = state;
    if (routed && !routed.answer) return false;
    const choices = state.presentation.choices;
    const set = (next: CardState): boolean => { this.#state = next; this.#deps.render(); return true; };
    if (state.typing !== undefined) {
      if (pressed.key === 'enter') {
        const text = state.typing.trim();
        if (text === '') return set({ ...state, typing: undefined });
        this.#send({ text }, text);
        this.#deps.render();
        return true;
      }
      if (pressed.key === 'escape') return set({ ...state, typing: undefined });
      if (data === '\x7f' || data === '\b') return set({ ...state, typing: [...state.typing].slice(0, -1).join('') });
      if (!data.startsWith('\x1b') && /^[^\x00-\x1f\x7f]+$/.test(data)) return set({ ...state, typing: state.typing + data });
      return true;
    }
    if (pressed.key === 'up' || pressed.key === 'down') {
      return set({ ...state, index: (state.index + (pressed.key === 'up' ? -1 : 1) + choices.length) % choices.length });
    }
    if (pressed.key === 'escape') {
      // Answer later: it stays in the inbox.
      this.#later.add(state.item.id);
      this.#state = null;
      this.refresh();
      this.#deps.render();
      return true;
    }
    const pick = (index: number): boolean => {
      const choice = choices[index];
      if (!choice) return true;
      if (choice.id === 'own-words') return set({ ...state, index, typing: '' });
      this.#send({ option: choice.value ?? choice.label }, choice.label);
      this.#deps.render();
      return true;
    };
    if (pressed.key === 'enter') return pick(state.index);
    if (/^[1-9]$/.test(data)) {
      const listed = choices.findIndex((choice) => choice.key === data);
      if (listed >= 0) return pick(listed);
      if (Number(data) === choices.length) return pick(choices.length - 1);
      return true;
    }
    return false;
  }

  /**
   * The card as a layer pinned above the composer (`footerRows` are the rows
   * of the composer and status bar), or null. The answered line shows once.
   */
  layer(screenWidth: number, screenHeight: number, footerRows: number): SurfaceLayer | null {
    const t = activeTokens();
    // Another chat opened here: its own questions, not the last one's.
    if (this.#state && !askedHere(this.#state.item, this.#deps.sessionId())) { this.#state = null; this.refresh(); }
    const state = this.#state;
    const width = standardModalWidth(screenWidth);
    const inner = modalInnerWidth(width);
    if (!state) {
      const answered = this.#answered;
      if (answered === null) return null;
      if (Date.now() > this.#answeredUntil) { this.#answered = null; return null; }
      const f = beginModal(screenWidth, screenHeight, { title: `Answered: ${answered}`, titleGlyph: { char: '✓', fg: t.success }, width, height: 3, escKey: false, dim: false });
      return ownRows(finishModal(f), screenWidth, screenHeight, footerRows);
    }
    const p = state.presentation;
    const choices = p.choices;
    const body = p.body ? wrapLines(p.body, inner) : [];
    const detail = p.subject?.lines.flatMap((line) => wrapLines(line, inner)) ?? [];
    const own = (index: number): boolean => choices[index]?.id === 'own-words';
    const optionRows = choices.length;
    const typingRows = state.typing !== undefined ? 2 : 0;
    const hints: KitHint[] = cardHints(this.#deps.keys, state.typing !== undefined, choices.length);
    const hintRows = layoutHintRows(hints, inner);
    // Rows: title, blank, body, blank, detail?, options, typing?, blank, hints.
    const rows = body.length + (detail.length > 0 ? detail.length + 1 : 0) + 1 + optionRows + typingRows + 1 + hintRows.length;
    const f = beginModal(screenWidth, screenHeight, {
      title: p.question,
      titleGlyph: { char: '?', fg: t.primary },
      width,
      height: rows + 4,
      escKey: false,
      dim: false,
      cap: 'brand',
    });
    // The asking chat's title, when it is not this one.
    const where = p.origin?.sessionTitle;
    if (where && 2 + getDisplayWidth(p.question) + 3 + getDisplayWidth(where) <= inner) f.canvas.right(f.r, f.t, `"${where}"`, { fg: t.textFaint });
    let y = f.top;
    for (const line of body) f.canvas.put(f.l, y++, line, { fg: t.text });
    if (detail.length > 0) { y++; for (const line of detail) f.canvas.put(f.l, y++, line, { fg: t.textMuted }); }
    y++;
    choices.forEach((choice, index) => {
      const selected = index === state.index;
      const number = choice.key ?? String(index + 1);
      const label = `${number}  ${choice.label}`;
      if (selected) {
        const end = f.canvas.put(f.l - 1, y, ` ${label}    `, { fg: t.selectedListItemText, bold: true });
        f.canvas.grad(f.l - 1, y, end - f.l + 1, t.brand, t.brandEnd);
        if (own(index)) f.canvas.put(end + 1, y, 'type it', { fg: t.textFaint });
      } else {
        const x = f.canvas.put(f.l, y, number, { fg: t.text, bg: t.border, bold: true });
        const end = f.canvas.put(x + 2, y, choice.label, { fg: t.text });
        if (own(index)) f.canvas.put(end + 2, y, 'type it', { fg: t.textFaint });
      }
      y++;
    });
    if (state.typing !== undefined) {
      y++;
      f.canvas.fill(f.l - 2, y, f.r - f.l + 5, 1, t.backgroundElement);
      f.canvas.put(f.l, y, `Your answer  ${state.typing}▏`, { fg: t.text });
      y++;
    }
    let hy = f.bottom - hintRows.length + 1;
    for (const row of hintRows) {
      const line = f.canvas.lines[hy++];
      if (line) paintKeycapHints(line, f.l, f.r + 1, row, { fg: t.textMuted });
    }
    // Pinned above the composer, not centred: the conversation stays readable above it.
    return ownRows(finishModal(f), screenWidth, screenHeight, footerRows);
  }
}

/**
 * The card owns the rows it stands on: pinned above the composer, and the
 * cells left and right of it on those rows cleared to the plain screen, so no
 * transcript row shows through at its edges.
 */
function ownRows(layer: SurfaceLayer, screenWidth: number, screenHeight: number, footerRows: number): SurfaceLayer {
  const lines = layer.lines.map((line) => {
    const left = Math.max(0, layer.x);
    const right = Math.max(0, screenWidth - left - line.length);
    return [...Array.from({ length: left }, createEmptyCell), ...line, ...Array.from({ length: right }, createEmptyCell)];
  });
  const hitTargets = layer.hitTargets?.map((target) => ({ ...target, x: target.x + Math.max(0, layer.x) }));
  return { ...layer, x: 0, y: Math.max(0, screenHeight - footerRows - lines.length), lines, clearBlank: true, ...(hitTargets ? { hitTargets } : {}) };
}

/**
 * The frame's layers with the question card added: only when no dialog dims
 * the screen and no approval card or full view is up (`hidden`), so it never
 * covers one. A frame that does not draw it leaves its keys to the composer.
 */
export function withOwnerQuestionCard(
  layers: readonly SurfaceLayer[],
  card: OwnerQuestionCard,
  frame: { readonly width: number; readonly height: number; readonly footerRows: number; readonly hidden: boolean },
): SurfaceLayer[] {
  const layer = frame.hidden || layers.some((each) => each.dim) ? null : card.layer(frame.width, frame.height, frame.footerRows);
  card.drawn(layer !== null);
  return layer ? [...layers, layer] : [...layers];
}

/** The home's one inbox store as the question card reads and answers it, answers recorded from `surface`. */
export function ownerQuestionInbox(shellPaths: { resolveUserPath(...segments: string[]): string }, surface: string): QuestionCardInbox {
  const inbox = homeOwnerInbox(shellPaths);
  return {
    subscribe: (listener) => inbox.subscribe(listener),
    listNow: (filter) => inbox.listNow(filter),
    answer: async (id, answer) => await inbox.answer(id, answer, { actor: 'owner', surface }),
  };
}

/**
 * The composer's model control: one click opens one menu with three steps,
 * provider, then that provider's models, then the chosen model's effort, the
 * order the terminal's model picker keeps (Favorites, then the models used
 * recently, then the rest; a model the catalog does not describe last). A
 * filter box at the top searches every connected provider's models at once.
 *
 * Providers the person is connected to come first; the others follow, marked
 * Not connected, with the one action that connects them (Settings, or the
 * terminal command to copy when only a terminal can sign in). Only models that
 * can hold a conversation are listed (the catalog's `textWork`).
 *
 * A pick applies to this chat only; the menu says so, and "Make this the
 * default for new chats" sets the default from here. When a provider's list
 * was read more than a day ago, or its last reading failed, the menu says when
 * and "Refresh models" reads it again from the provider (models.refresh).
 *
 * Keyboard: arrows move, Right or Enter goes into the next step, Left or
 * Escape goes back one step (Escape on the first step closes), typing
 * filters. On a phone the same steps open in a bottom sheet.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { PHONE_QUERY, useFloatingPosition, useMediaQuery, useOutsidePress } from '../../components/ui/overlay';
import { copyOutcomeMessage, copyText } from '../../lib/copy-text';

/** One model the menu can pick. */
export interface PickerModel {
  readonly registryKey: string;
  readonly label: string;
  readonly providerId: string;
  /** The effort levels the model offers; empty when it has none to choose. */
  readonly efforts: readonly string[];
  /** The catalog does not say whether it holds a conversation: listed last, under `Not described by the catalog`, marked `kind unknown`. */
  readonly kindUnknown: boolean;
}

/** One provider in the menu. */
export interface PickerProvider {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
  readonly models: readonly PickerModel[];
  /** When its model list was read (epoch ms); absent when it never was. */
  readonly listedAt?: number | undefined;
  /** Why its last reading from the provider failed. */
  readonly listError?: string | undefined;
  /** How to connect it, for one that is not connected. */
  readonly connect: { readonly kind: 'settings' } | { readonly kind: 'command'; readonly command: string };
}

export interface ModelPickerProps {
  readonly providers: readonly PickerProvider[];
  readonly pinned: readonly string[];
  readonly recent: readonly string[];
  /** This chat's model and effort ('' for the provider default); `requestedEffort` when the model caps it lower. */
  readonly current: { readonly registryKey: string; readonly effort: string; readonly requestedEffort: string };
  /** Whether this chat's model and effort are already the default for new chats. */
  readonly isDefault: boolean;
  readonly pending: boolean;
  readonly disabled: boolean;
  /** Pick a model, and its effort (null: the provider default). */
  readonly onPick: (registryKey: string, effort: string | null) => void;
  readonly onMakeDefault: () => void;
  readonly makeDefaultPending: boolean;
  /** Open where a provider is connected (Settings, Models and providers). */
  readonly onOpenSettings: () => void;
  /** Read the model lists again (one provider, or all); resolves with the sentence to show. */
  readonly onRefresh: (providerId?: string) => Promise<string>;
}

/** A list older than this was not read when it was due: the menu says when it was read. */
const LIST_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Rows drawn at once; a longer list says how many more and that typing narrows it. */
const ROW_CAP = 300;

type Step = { readonly kind: 'provider' } | { readonly kind: 'model'; readonly providerId: string } | { readonly kind: 'effort'; readonly model: PickerModel };

interface Row {
  readonly id: string;
  readonly kind: 'header' | 'note' | 'item';
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** Has a next step (drawn with a chevron; Right goes into it). */
  readonly deeper?: boolean;
  readonly onActivate?: () => void;
}

export function effortWord(level: string): string {
  if (!level) return 'Default';
  if (/^x+high$/i.test(level)) return `${level.slice(0, level.length - 4).toUpperCase()}-high`;
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** "3 days ago", "5 hours ago", "12 minutes ago". */
function ageWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** What the menu says about a provider's list when it is not fresh; null when it is. */
export function listFreshness(provider: Pick<PickerProvider, 'listedAt' | 'listError' | 'connected'>, now: number): string | null {
  if (!provider.connected) return null;
  if (provider.listError) {
    return provider.listedAt !== undefined
      ? `Could not read its list now; this one was read ${ageWords(now - provider.listedAt)}`
      : 'Could not read its list now';
  }
  if (provider.listedAt !== undefined && now - provider.listedAt > LIST_LIFETIME_MS) return `List read ${ageWords(now - provider.listedAt)}`;
  return null;
}

/** Pinned first, then recent, then the described models, then the ones the catalog does not describe: the terminal's order. */
function ordered(models: readonly PickerModel[], pinned: readonly string[], recent: readonly string[]): { favorites: PickerModel[]; recentModels: PickerModel[]; rest: PickerModel[] } {
  const pinnedSet = new Set(pinned);
  const favorites = models.filter((model) => pinnedSet.has(model.registryKey));
  const recentModels = recent.map((key) => models.find((model) => model.registryKey === key)).filter((model): model is PickerModel => model !== undefined && !pinnedSet.has(model.registryKey));
  const taken = new Set([...favorites, ...recentModels].map((model) => model.registryKey));
  const others = models.filter((model) => !taken.has(model.registryKey));
  return { favorites, recentModels, rest: [...others.filter((model) => !model.kindUnknown), ...others.filter((model) => model.kindUnknown)] };
}

export function ModelPicker(props: ModelPickerProps) {
  const { providers, pinned, recent, current, pending, disabled } = props;
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'provider' });
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const isPhone = useMediaQuery(PHONE_QUERY);
  const position = useFloatingPosition(open && !isPhone, triggerRef, panelRef, 'top-end');
  const now = Date.now();

  const allModels = useMemo(() => providers.flatMap((provider) => provider.models), [providers]);
  const currentModel = allModels.find((model) => model.registryKey === current.registryKey);
  const currentProvider = providers.find((provider) => provider.id === currentModel?.providerId);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setQuery('');
    setStatus(null);
    if (refocus) triggerRef.current?.focus();
  }, []);
  useOutsidePress(open && !isPhone, [triggerRef, panelRef], () => close(false));

  const openMenu = () => {
    setStep({ kind: 'provider' });
    setQuery('');
    setStatus(null);
    setOpen(true);
  };

  const pick = (model: PickerModel, effort: string | null) => {
    props.onPick(model.registryKey, effort);
    close();
  };

  /** A model row: into its effort step when it has efforts to choose, else picked. */
  const modelRow = (model: PickerModel, withProvider: boolean): Row => {
    const provider = providers.find((candidate) => candidate.id === model.providerId);
    const deeper = model.efforts.length > 0;
    return {
      id: `model:${model.registryKey}`,
      kind: 'item',
      label: model.label,
      // The terminal picker's words for a model the catalog does not describe.
      hint: [withProvider ? provider?.label : null, model.kindUnknown ? 'kind unknown' : null].filter(Boolean).join(' · ') || undefined,
      checked: model.registryKey === current.registryKey,
      deeper,
      onActivate: () => {
        if (deeper) { setStep({ kind: 'effort', model }); setQuery(''); setActive(0); }
        else pick(model, null);
      },
    };
  };

  const refresh = (providerId?: string) => {
    if (refreshing) return;
    setRefreshing(true);
    setStatus('Reading the model lists again…');
    void props.onRefresh(providerId).then(
      (sentence) => setStatus(sentence),
      (error: unknown) => setStatus(`The lists were not read again: ${error instanceof Error ? error.message : String(error)}.`),
    ).finally(() => setRefreshing(false));
  };

  const connect = (provider: PickerProvider) => {
    if (provider.connect.kind === 'settings') { close(false); props.onOpenSettings(); return; }
    const command = provider.connect.command;
    void copyText(command).then((outcome) => setStatus(outcome === 'copied'
      ? `Copied: run ${command} in the terminal app.`
      : `Run ${command} in the terminal app. ${copyOutcomeMessage(outcome) ?? ''}`.trim()));
  };

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length > 0) {
      // Every connected provider's models at once, and the providers whose names match.
      const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word));
      const providerMatches = providers.filter((provider) => matches(provider.label));
      for (const provider of providerMatches) {
        out.push({ id: `provider:${provider.id}`, kind: 'item', label: provider.label, hint: provider.connected ? `${provider.models.length} models` : 'Not connected', deeper: provider.connected,
          onActivate: () => { if (provider.connected) { setStep({ kind: 'model', providerId: provider.id }); setQuery(''); setActive(0); } else connect(provider); } });
      }
      const found = providers.filter((provider) => provider.connected)
        .flatMap((provider) => provider.models.filter((model) => matches(`${model.label} ${model.registryKey} ${provider.label}`)));
      const { favorites, recentModels, rest } = ordered(found, pinned, recent);
      const list = [...favorites, ...recentModels, ...rest];
      for (const model of list.slice(0, ROW_CAP)) out.push(modelRow(model, true));
      if (list.length > ROW_CAP) out.push({ id: 'more', kind: 'note', label: `${list.length - ROW_CAP} more: type more to narrow the list.` });
      if (out.length === 0) out.push({ id: 'none', kind: 'note', label: 'No connected provider has a model by that name.' });
      return out;
    }
    if (step.kind === 'provider') {
      const connected = providers.filter((provider) => provider.connected);
      const others = providers.filter((provider) => !provider.connected);
      if (connected.length > 0) out.push({ id: 'h:connected', kind: 'header', label: 'Connected' });
      for (const provider of connected) {
        // The row says it in a few words; the provider's own step says it whole.
        const stale = provider.listError ? 'list not read now' : listFreshness(provider, now) && provider.listedAt !== undefined ? `list read ${ageWords(now - provider.listedAt)}` : null;
        out.push({ id: `provider:${provider.id}`, kind: 'item', label: provider.label,
          hint: [`${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`, stale].filter(Boolean).join(' · '),
          checked: provider.id === currentProvider?.id, deeper: true,
          onActivate: () => { setStep({ kind: 'model', providerId: provider.id }); setActive(0); } });
      }
      if (others.length > 0) out.push({ id: 'h:others', kind: 'header', label: 'Not connected' });
      for (const provider of others) {
        out.push({ id: `provider:${provider.id}`, kind: 'item', label: provider.label,
          hint: provider.connect.kind === 'settings' ? 'Connect in Settings' : `Copy ${provider.connect.command}`,
          onActivate: () => connect(provider) });
      }
      out.push({ id: 'refresh:all', kind: 'item', label: <><RefreshCw size={14} aria-hidden /> Refresh models</>, hint: 'every provider', disabled: refreshing, onActivate: () => refresh() });
      return out;
    }
    if (step.kind === 'model') {
      const provider = providers.find((candidate) => candidate.id === step.providerId);
      if (!provider) return out;
      const fresh = listFreshness(provider, now);
      if (fresh) out.push({ id: 'fresh', kind: 'note', label: `${fresh}.` });
      const { favorites, recentModels, rest } = ordered(provider.models, pinned, recent);
      if (favorites.length > 0) { out.push({ id: 'h:fav', kind: 'header', label: 'Favorites' }); favorites.forEach((model) => out.push(modelRow(model, false))); }
      if (recentModels.length > 0) { out.push({ id: 'h:recent', kind: 'header', label: 'Recent' }); recentModels.forEach((model) => out.push(modelRow(model, false))); }
      const described = rest.filter((model) => !model.kindUnknown);
      if (described.length > 0) out.push({ id: 'h:all', kind: 'header', label: favorites.length + recentModels.length > 0 ? 'All models' : 'Models' });
      rest.slice(0, ROW_CAP).forEach((model, index) => {
        // The models the catalog does not describe follow, under the terminal picker's group title.
        if (model.kindUnknown && (index === 0 || !rest[index - 1]!.kindUnknown)) out.push({ id: 'h:unknown', kind: 'header', label: 'Not described by the catalog' });
        out.push(modelRow(model, false));
      });
      if (rest.length > ROW_CAP) out.push({ id: 'more', kind: 'note', label: `${rest.length - ROW_CAP} more: type to filter.` });
      if (provider.models.length === 0) out.push({ id: 'none', kind: 'note', label: 'This provider lists no chat model.' });
      out.push({ id: `refresh:${provider.id}`, kind: 'item', label: <><RefreshCw size={14} aria-hidden /> Refresh models</>, hint: provider.label, disabled: refreshing, onActivate: () => refresh(provider.id) });
      return out;
    }
    const model = step.model;
    const thisModel = model.registryKey === current.registryKey;
    for (const level of ['', ...model.efforts]) {
      out.push({ id: `effort:${level || 'default'}`, kind: 'item', label: effortWord(level),
        checked: thisModel ? level === current.effort : level === '',
        onActivate: () => pick(model, level === '' ? null : level) });
    }
    return out;
    // `now` moves every render; the rows depend on what the person sees, not on the clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, step, providers, pinned, recent, current.registryKey, current.effort, refreshing, currentProvider?.id]);

  const items = rows.filter((row) => row.kind === 'item' && !row.disabled);
  const activeRow = items[Math.min(active, Math.max(0, items.length - 1))];

  // The first step opens on the provider in use, the second on the model in use.
  useEffect(() => {
    if (!open) return;
    const at = items.findIndex((row) => row.checked);
    setActive(at >= 0 ? at : 0);
    // Only when the step or the filter changes: moving with the arrows keeps its place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, query]);

  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open, step]);

  useEffect(() => {
    if (!open || !activeRow) return;
    document.getElementById(`${listId}-${activeRow.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeRow, listId]);

  const back = () => {
    if (step.kind === 'effort') setStep({ kind: 'model', providerId: step.model.providerId });
    else if (step.kind === 'model') setStep({ kind: 'provider' });
    else close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const caretAtEnd = event.currentTarget.selectionStart === query.length;
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); setActive((at) => Math.min(items.length - 1, at + 1)); break;
      case 'ArrowUp': event.preventDefault(); setActive((at) => Math.max(0, at - 1)); break;
      case 'Home': if (!query) { event.preventDefault(); setActive(0); } break;
      case 'End': if (!query) { event.preventDefault(); setActive(items.length - 1); } break;
      case 'Enter': event.preventDefault(); activeRow?.onActivate?.(); break;
      case 'ArrowRight':
        if (caretAtEnd && activeRow?.deeper) { event.preventDefault(); activeRow.onActivate?.(); }
        break;
      case 'ArrowLeft':
        if (!query) { event.preventDefault(); back(); }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        if (query) setQuery('');
        else back();
        break;
      case 'Tab': close(false); break;
    }
  };

  const title = step.kind === 'provider' || query ? 'Choose a model'
    : step.kind === 'model' ? providers.find((provider) => provider.id === step.providerId)?.label ?? 'Models'
    : step.model.label;
  const stepWord = query ? 'All providers' : step.kind === 'provider' ? 'Step 1 of 3: provider' : step.kind === 'model' ? 'Step 2 of 3: model' : 'Step 3 of 3: effort';

  const capped = current.requestedEffort !== '' && current.requestedEffort !== current.effort;
  const modelLabel = pending ? 'Switching…' : currentModel?.label ?? (allModels.length ? 'Choose a model' : 'No models');
  const effortLabel = currentModel?.providerId === 'decision-router' ? 'by category'
    : !currentModel || currentModel.efforts.length === 0 ? ''
    : capped ? `${effortWord(current.effort)} (requested ${effortWord(current.requestedEffort)})`
      : current.effort ? effortWord(current.effort) : '';

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Choose a model"
      data-gv-layer=""
      className={isPhone ? 'model-picker model-picker--sheet' : 'glass gv-popover model-picker'}
      style={isPhone ? undefined : (position ? { top: position.top, left: position.left } : { top: -9999, left: -9999 })}
    >
      <div className="model-picker__head">
        {(step.kind !== 'provider' && !query) && (
          <button type="button" className="model-picker__back" aria-label="Back one step" onClick={back}>
            <ChevronLeft size={16} aria-hidden />
          </button>
        )}
        <div className="model-picker__title">
          <span className="model-picker__step">{stepWord}</span>
          <span className="model-picker__name">{title}</span>
        </div>
      </div>
      <div className="model-picker__filter">
        <Search size={14} aria-hidden />
        <input
          ref={inputRef}
          className="model-picker__input"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          placeholder="Filter every provider's models"
          aria-label="Filter every provider's models"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeRow ? `${listId}-${activeRow.id}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div id={listId} role="listbox" aria-label={title} className="model-picker__list">
        {rows.map((row) => row.kind === 'header'
          ? <div key={row.id} role="presentation" className="model-picker__group">{row.label}</div>
          : row.kind === 'note'
            ? <div key={row.id} role="presentation" className="model-picker__note">{row.label}</div>
            : (
              <div
                key={row.id}
                id={`${listId}-${row.id}`}
                role="option"
                aria-selected={row === activeRow}
                aria-disabled={row.disabled || undefined}
                data-active={row === activeRow ? 'true' : undefined}
                className="model-picker__row"
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => { const at = items.indexOf(row); if (at >= 0 && at !== active) setActive(at); }}
                onClick={() => { if (!row.disabled) row.onActivate?.(); }}
              >
                <span className="model-picker__check" aria-hidden>{row.checked ? <Check size={15} /> : null}</span>
                <span className="model-picker__label">{row.label}{row.checked && <span className="gv-sr-only"> (in use)</span>}</span>
                {row.hint && <span className="model-picker__hint">{row.hint}</span>}
                {row.deeper && <ChevronRight size={15} aria-hidden className="model-picker__chevron" />}
              </div>
            ))}
      </div>
      {status && <div className="model-picker__status" role="status">{status}</div>}
      <div className="model-picker__foot">
        <span className="model-picker__scope">For this chat only. The default for new chats is set in Settings.</span>
        <button
          type="button"
          className="model-picker__default"
          disabled={props.isDefault || props.makeDefaultPending || !currentModel}
          onClick={() => props.onMakeDefault()}
        >
          {props.isDefault ? 'This is the default for new chats' : props.makeDefaultPending ? 'Making it the default…' : 'Make this the default for new chats'}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-model-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${modelLabel}${effortLabel ? `, effort ${effortLabel}` : ''}`}
        data-pending={pending ? 'true' : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); openMenu(); }
        }}
      >
        <span className="composer-model-label">{modelLabel}</span>
        {effortLabel && <span className="composer-model-effort">{effortLabel}</span>}
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        isPhone ? (
          <div className="gv-overlay" data-gv-layer="">
            <div className="scrim" aria-hidden="true" onClick={() => close(true)} />
            <div className="glass gv-sheet" data-gv-layer="">
              <div className="gv-sheet__grabber" aria-hidden="true" />
              {panel}
            </div>
          </div>
        ) : panel,
        document.body,
      )}
    </>
  );
}

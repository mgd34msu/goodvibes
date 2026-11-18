/**
 * toast-center.ts, the toast primitive's state.
 *
 * A toast appears in the top right corner (drawn by renderToasts in
 * surface-kit-parts.ts: a colored ┃ on both sides, the title bold, the body
 * wrapped in full) and disappears after five seconds. Newest first; at most
 * three are up at once, and a fourth waits for a free place rather than
 * pushing one off early, so a burst (start-up) shows every toast its full time.
 * Past six waiting, the oldest waiting information toast is dropped (it stays
 * in the history); a warning or an error always waits its turn.
 *
 * Producers: commandContext.showToast (any command), and the shared
 * notification feed (bridgeNotificationFeedToToasts): every conversation
 * system notice toasts ([WRFC] …, [Agents] …, compaction receipts; see
 * core/notices.ts), and of the routed notifications only warning and critical
 * ones do. Everything that toasts stays in the feed, which /notifications
 * shows in full.
 *
 * The print level (`behavior.hitlMode`) moves that line: quiet toasts only
 * warnings and errors (an information notice goes to the history only),
 * operator also toasts routed information notifications, balanced (and off)
 * is the rule above.
 */
import type { NotificationFeedEntry, NotificationFeed } from '@goodvibes-jev/engine/platform/platform/runtime/notification-feed';
import type { ToastSpec, ToastTone } from './surface-kit-parts.js';
/** How long a toast stays up. */
const TOAST_DURATION_MS = 5000;
/** How many toasts are shown at once. */
const MAX_TOASTS = 3;
/** How many information toasts may wait for a place; warnings and errors are never dropped. */
const MAX_WAITING = 6;
interface LiveToast {
    readonly id: number;
    readonly spec: ToastSpec;
    readonly expiresAt: number;
}
export type ToastScheduler = (run: () => void, delayMs: number) => void;
const defaultScheduler: ToastScheduler = (run, delayMs) => {
    const timer = setTimeout(run, delayMs);
    // A pending toast expiry must never keep the process alive on exit.
    (timer as {
        unref?: (() => void) | undefined;
    }).unref?.();
};
export class ToastCenter {
    private toasts: LiveToast[] = [];
    private waiting: Array<{
        readonly spec: ToastSpec;
        readonly durationMs: number;
    }> = [];
    private nextId = 1;
    /** Called whenever the visible set changes (wired to the render request). */
    onChange: (() => void) | null = null;
    constructor(private readonly clock: () => number = Date.now, private readonly schedule: ToastScheduler = defaultScheduler) { }
    show(spec: ToastSpec, durationMs: number = TOAST_DURATION_MS): void {
        if (this.toasts.length >= MAX_TOASTS) {
            this.waiting.push({ spec, durationMs });
            if (this.waiting.length > MAX_WAITING) {
                const info = this.waiting.findIndex((entry) => entry.spec.tone === 'info' || entry.spec.tone === 'success');
                if (info >= 0)
                    this.waiting.splice(info, 1);
            }
            return;
        }
        this.start(spec, durationMs);
        this.onChange?.();
    }
    private start(spec: ToastSpec, durationMs: number): void {
        const toast: LiveToast = { id: this.nextId++, spec, expiresAt: this.clock() + durationMs };
        this.toasts = [toast, ...this.toasts];
        this.schedule(() => this.expire(toast.id), durationMs);
    }
    /** The toasts to draw now, newest first. */
    visible(): ToastSpec[] {
        const now = this.clock();
        return this.toasts.filter((t) => t.expiresAt > now).map((t) => t.spec);
    }
    clear(): void {
        this.waiting = [];
        if (this.toasts.length === 0)
            return;
        this.toasts = [];
        this.onChange?.();
    }
    private expire(id: number): void {
        const before = this.toasts.length;
        this.toasts = this.toasts.filter((t) => t.id !== id);
        if (this.toasts.length === before)
            return;
        while (this.toasts.length < MAX_TOASTS && this.waiting.length > 0) {
            const next = this.waiting.shift()!;
            this.start(next.spec, next.durationMs);
        }
        this.onChange?.();
    }
}
/** Each runtime owns its visible toasts without copying expiry/folding behavior. */
export function createToastCenterScope(): () => ToastCenter {
    let shared: ToastCenter | null = null;
    return () => shared ??= new ToastCenter();
}
export const getSharedToastCenter = createToastCenterScope();
function toneForLevel(level: NotificationFeedEntry['level']): ToastTone | null {
    if (level === 'critical')
        return 'error';
    if (level === 'warning')
        return 'warning';
    return null;
}
/** A system notice always toasts; its level picks the bar color. */
function toneForNotice(level: NotificationFeedEntry['level']): ToastTone {
    return toneForLevel(level) ?? 'info';
}
/** The print level the toast bridge reads at each feed change: one setting read, no other state. */
export type ToastPrintLevel = () => unknown;

function toneFor(entry: NotificationFeedEntry, level: unknown): ToastTone | null {
    if (entry.toast === 'never')
        return null;
    if (level === 'quiet')
        return toneForLevel(entry.level);
    if (entry.toast === 'always' || level === 'operator')
        return toneForNotice(entry.level);
    return toneForLevel(entry.level);
}
/**
 * Toast every new warning or critical entry of the notification feed, and
 * every system notice, as the print level allows. A collapsed burst toasts
 * once per growth of its running count, with the count in the title. Returns
 * an unsubscribe function.
 */
export function bridgeNotificationFeedToToasts(feed: NotificationFeed, toasts: ToastCenter, printLevel: ToastPrintLevel = () => 'balanced'): () => void {
    // Per entry: the count last toasted for, and whether it has toasted at that
    // count. An entry toasts when its count grows, or once when a second arrival
    // of the same event (feed eventKey folding) makes a quiet entry one that
    // toasts; a fold never toasts an entry twice.
    const seen = new Map<string, {
        readonly count: number;
        readonly toasted: boolean;
    }>();
    for (const entry of feed.list())
        seen.set(entry.key, { count: entry.collapsedCount, toasted: true });
    return feed.subscribe(() => {
        const entries = feed.list();
        const level = printLevel();
        const retained = new Set(entries.map((entry) => entry.key));
        for (const key of seen.keys())
            if (!retained.has(key))
                seen.delete(key);
        for (const entry of entries) {
            const previous = seen.get(entry.key);
            const tone = toneFor(entry, level);
            if (previous && previous.count === entry.collapsedCount && (previous.toasted || !tone))
                continue;
            seen.set(entry.key, { count: entry.collapsedCount, toasted: Boolean(tone) });
            if (!tone)
                continue;
            const title = entry.collapsedCount > 1 ? `${entry.title} (${entry.collapsedCount} times)` : entry.title;
            toasts.show({ title, body: entry.body, tone });
        }
    });
}

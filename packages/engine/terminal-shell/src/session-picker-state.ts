import type { SessionInfo, SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
/** Local saved-session navigation; products provide their resume/delete authority and other session sources. */
export class SavedSessionPickerState {
  public active = false;
  public sessions: SessionInfo[] = [];
  public selectedIndex = 0;
  public scrollOffset = 0;
  public visibleRows = 8;
  public deleteConfirmationTarget: string | null = null;
  public statusMessage = '';
  public query = '';
  public constructor(protected readonly sessionManager: SessionManager) {}
  open(): void {
    this.sessions = this.sessionManager.list();
    this.refreshAdditionalSources();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
    this.query = '';
    this.active = true;
  }
  visibleSessions(): SessionInfo[] {
    const q = this.query.trim().toLowerCase();
    if (q.length === 0) return this.sessions;
    return this.sessions.filter((s) => s.name.toLowerCase().includes(q) || (s.title ?? '').toLowerCase().includes(q));
  }
  setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.deleteConfirmationTarget = null;
  }
  close(): void {
    this.active = false;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
  }
  moveUp(): void {
    const count = this.visibleSessions().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + count) % count;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }
  moveDown(): void {
    const count = this.visibleSessions().length;
    if (count === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % count;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }
  setVisibleRows(rows: number): void {
    this.visibleRows = Math.max(3, rows);
    this._clampScroll();
  }
  getSelected(): SessionInfo | null {
    return this.visibleSessions()[this.selectedIndex] ?? null;
  }
  protected _clampScroll(): void {
    const visRows = Math.max(3, this.visibleRows);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visRows) {
      this.scrollOffset = this.selectedIndex - visRows + 1;
    }
    const maxOffset = Math.max(0, this.visibleSessions().length - visRows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }
  protected refreshAdditionalSources(): void {}
}

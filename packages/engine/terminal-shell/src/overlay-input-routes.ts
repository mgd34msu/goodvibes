import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { SearchManager, SearchConversation, SearchHistory as InfiniteBuffer } from './transcript-search.js';
import type { OverlayFilter, OverlayFilters } from './overlay-filter.js';
import { isTextBackspace } from './delete-key-policy.js';
import type { HistorySearch } from './input-history.js';
type SearchRouteState = {
    searchManager: SearchManager;
    requestRender: () => void;
    scroll: (delta: number) => void;
    getScrollTop: () => number;
    getViewportHeight: () => number;
    /** Optional, when present, search() also expands collapsed blocks whose
     *  raw content matches (see SearchManager.search's doc). */
    conversationManager?: (SearchConversation | null) | undefined;
};
export function handleSearchModeToken(state: SearchRouteState, token: InputToken, history: InfiniteBuffer, matchesSearchShortcut: boolean, letterN = true): boolean {
    const { searchManager } = state;
    if (!searchManager.active)
        return false;
    if (!searchManager.locked) {
        if (token.type === 'text') {
            const newQuery = searchManager.query + token.value;
            searchManager.search(newQuery, history, state.conversationManager);
        }
        else if (token.type === 'key') {
            if (token.logicalName === 'escape') {
                searchManager.close(state.conversationManager);
            }
            else if (token.logicalName === 'enter' || token.logicalName === 'tab') {
                if (searchManager.query.length > 0) {
                    searchManager.lock();
                    searchManager.revealCurrentMatch(history, state.conversationManager);
                    const matchLine = searchManager.getCurrentMatchLine();
                    if (matchLine >= 0) {
                        state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
                    }
                }
            }
            else if (token.logicalName === 'backspace') {
                const newQuery = searchManager.query.slice(0, -1);
                searchManager.search(newQuery, history, state.conversationManager);
            }
            else if (matchesSearchShortcut) {
                searchManager.close(state.conversationManager);
            }
        }
    }
    else {
        if (token.type === 'key') {
            if (token.logicalName === 'escape' || matchesSearchShortcut) {
                searchManager.close(state.conversationManager);
            }
            else if (token.logicalName === 'right' || token.logicalName === 'down') {
                searchManager.nextMatch();
                searchManager.revealCurrentMatch(history, state.conversationManager);
                const matchLine = searchManager.getCurrentMatchLine();
                if (matchLine >= 0) {
                    state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
                }
            }
            else if (token.logicalName === 'left' || token.logicalName === 'up') {
                searchManager.prevMatch();
                searchManager.revealCurrentMatch(history, state.conversationManager);
                const matchLine = searchManager.getCurrentMatchLine();
                if (matchLine >= 0) {
                    state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
                }
            }
            else if (token.logicalName === 'backspace') {
                searchManager.unlock();
            }
        }
        else if (token.type === 'text') {
            if ((letterN && token.value === 'n') || token.value === 'j' || token.value === 'l') {
                searchManager.nextMatch();
                searchManager.revealCurrentMatch(history, state.conversationManager);
                const matchLine = searchManager.getCurrentMatchLine();
                if (matchLine >= 0) {
                    state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
                }
            }
            else if ((letterN && token.value === 'N') || token.value === 'k' || token.value === 'h') {
                searchManager.prevMatch();
                searchManager.revealCurrentMatch(history, state.conversationManager);
                const matchLine = searchManager.getCurrentMatchLine();
                if (matchLine >= 0) {
                    state.scroll(matchLine - state.getScrollTop() - Math.floor(state.getViewportHeight() / 2));
                }
            }
        }
    }
    state.requestRender();
    return true;
}
type OverlayRouteState = {
    helpOverlayActive: boolean;
    helpScrollOffset: number;
    shortcutsOverlayActive: boolean;
    shortcutsScrollOffset: number;
    /** The overlays' always-live search rows (absent in minimal test states). */
    overlayFilters?: OverlayFilters | undefined;
    requestRender: () => void;
    handleEscape: () => void;
};
function routeFilteredOverlayKey(token: InputToken, offset: number, filter: OverlayFilter | undefined): number {
    const max = filter ? filter.maxScroll : 100;
    if (token.type === 'key') {
        if (token.logicalName === 'up')
            return Math.max(0, Math.min(offset, max) - 1);
        if (token.logicalName === 'down')
            return Math.min(offset + 1, max);
        if (token.logicalName === 'pageup')
            return Math.max(0, Math.min(offset, max) - 10);
        if (token.logicalName === 'pagedown')
            return Math.min(offset + 10, max);
        if (filter && isTextBackspace(token.logicalName ?? '') && filter.query.length > 0) {
            filter.query = filter.query.slice(0, -1);
            return 0;
        }
        return offset;
    }
    if (token.type === 'text' && filter) {
        filter.query += token.value;
        return 0;
    }
    return offset;
}
export function handleOverlayToken(state: OverlayRouteState, token: InputToken): boolean {
    if (state.helpOverlayActive) {
        const filter = state.overlayFilters?.help;
        if (token.type === 'key' && token.logicalName === 'escape') {
            state.handleEscape();
            return true;
        }
        // '?' toggles help closed, but only while the query is empty; once
        // something is typed, '?' is just another character.
        if (token.type === 'text' && token.value === '?' && (!filter || filter.query.length === 0)) {
            state.helpOverlayActive = false;
            state.helpScrollOffset = 0;
            filter?.clear();
        }
        else {
            state.helpScrollOffset = routeFilteredOverlayKey(token, state.helpScrollOffset, filter);
        }
        state.requestRender();
        return true;
    }
    if (state.shortcutsOverlayActive) {
        if (token.type === 'key' && token.logicalName === 'escape') {
            state.handleEscape();
            return true;
        }
        state.shortcutsScrollOffset = routeFilteredOverlayKey(token, state.shortcutsScrollOffset, state.overlayFilters?.shortcuts);
        state.requestRender();
        return true;
    }
    return false;
}
type HistorySearchRouteState = {
    historySearch: HistorySearch;
    prompt: string;
    cursorPos: number;
    requestRender: () => void;
};
export function handleHistorySearchToken(state: HistorySearchRouteState, token: InputToken): boolean {
    if (!state.historySearch.active)
        return false;
    if (token.type === 'text') {
        state.historySearch.appendChar(token.value);
    }
    else if (token.type === 'key') {
        if (token.logicalName === 'escape' || (token.ctrl && token.logicalName === 'g')) {
            state.prompt = state.historySearch.cancel();
            state.cursorPos = state.prompt.length;
        }
        else if (token.logicalName === 'enter' || token.logicalName === 'return') {
            state.prompt = state.historySearch.accept();
            state.cursorPos = state.prompt.length;
        }
        else if (token.logicalName === 'backspace') {
            state.historySearch.deleteChar();
        }
        else if (token.ctrl && token.logicalName === 'r') {
            state.historySearch.stepOlder();
        }
        else if (token.ctrl && token.logicalName === 's') {
            state.historySearch.stepNewer();
        }
        else if (token.logicalName === 'up') {
            state.historySearch.stepOlder();
        }
        else if (token.logicalName === 'down') {
            state.historySearch.stepNewer();
        }
    }
    state.requestRender();
    return true;
}

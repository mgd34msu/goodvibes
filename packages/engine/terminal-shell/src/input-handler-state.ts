import { TerminalComposerController } from './composer-controller.js';
import type { ConcealedInputRequest } from './concealed-input.js';
import { InputHistory, HistorySearch } from './input-history.js';
/** Per-handler state: each terminal instance keeps its own registries, draft navigation and undo history. */
export abstract class TerminalInputHandlerState extends TerminalComposerController {
  public cursorPos = 0;
  public showExitNotice = false;
  public concealedInput: ConcealedInputRequest | null = null;
  public inputScrollTop = 0;
  public lastCopyTime = 0;
  public commandMode = false;
  public indicatorFocused = false;
  public pasteRegistry = new Map<string, string>();
  public nextPasteId = 1;
  public lastCtrlCTime = 0;
  public bodyTopRow = 2;
  public modalStack: string[] = [];
  public modalReturnFocus: 'prompt' | 'indicator' = 'prompt';
  public helpOverlayActive = false;
  public helpScrollOffset = 0;
  public shortcutsOverlayActive = false;
  public shortcutsScrollOffset = 0;
  public inputHistory: InputHistory | null = null;
  public historySearch: HistorySearch = new HistorySearch(() => this.inputHistory?.getEntries() ?? []);
  public lastBlockCopyTime = 0;
  public mouseDownRow = -1;
  public mouseDownCol = -1;
  public imageRegistry = new Map<string, { data: string; mediaType: string }>();
  public nextImageId = 1;
  public undoStack: Array<{ prompt: string; cursorPos: number }> = [];
  public redoStack: Array<{ prompt: string; cursorPos: number }> = [];
  public pathCompletions: string[] = [];
  public pathCompletionIndex = -1;
  public pathCompletionPrefix = '';
  public pathCompletionStart = 0;
  public contentWidth = 76;
}

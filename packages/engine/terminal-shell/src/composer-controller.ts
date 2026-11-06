import {
  moveCursorVertical,
  ensureInputCursorVisible,
  getWrappedPromptInfo,
  undoPromptState,
  redoPromptState,
  findPathToken,
  handlePathCompletion,
  wordWrapLine,
  type WrappedPromptInfo,
  type UndoState,
} from './prompt-buffer.js';
import { maskConcealedText, type ConcealedInputRequest } from './concealed-input.js';
export interface TerminalComposerHost {
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  contentWidth: number;
  readonly composerMaxRows: number;
  concealedInput: ConcealedInputRequest | null;
  undoStack: UndoState[];
  redoStack: UndoState[];
  pathCompletions: string[];
  pathCompletionIndex: number;
  pathCompletionPrefix: string;
  pathCompletionStart: number;
  readonly filePicker: {
    readonly allFiles: string[];
  };
  saveUndoState(): void;
  ensureInputCursorVisible(contentWidth?: number | undefined): void;
  getWrappedPromptInfo(contentWidth: number): WrappedPromptInfo;
}
/** Shared composer operations run on the product-owned state object, preserving its draft/accessor lifetime. */
export abstract class TerminalComposerController {
  constructor(readonly composerMaxRows: number) {}
  public setContentWidth(this: TerminalComposerHost, w: number): void {
    this.contentWidth = w;
  }
  public moveCursorVertical(this: TerminalComposerHost, direction: -1 | 1): boolean {
    const result = moveCursorVertical(this.prompt, this.cursorPos, this.inputScrollTop, this.contentWidth, this.composerMaxRows, direction);
    this.cursorPos = result.cursorPos;
    this.inputScrollTop = result.inputScrollTop;
    return result.moved;
  }
  public ensureInputCursorVisible(this: TerminalComposerHost, contentWidth?: number | undefined): void {
    this.inputScrollTop = ensureInputCursorVisible(
      this.prompt,
      this.cursorPos,
      this.inputScrollTop,
      contentWidth ?? this.contentWidth,
      this.composerMaxRows,
    );
  }
  public getVisiblePromptLineCount(this: TerminalComposerHost, contentWidth?: number | undefined): number {
    const info = this.getWrappedPromptInfo(contentWidth ?? 76);
    return Math.min(info.wrappedLines.length, this.composerMaxRows);
  }
  public getWrappedPromptInfo(this: TerminalComposerHost, contentWidth: number): WrappedPromptInfo {
    // In concealed mode, wrap the MASKED buffer. maskConcealedText preserves
    // length and newlines, so wrapping and cursor coordinates are identical to
    // the plaintext while no plaintext character reaches the screen buffer.
    const displayPrompt = this.concealedInput ? maskConcealedText(this.prompt) : this.prompt;
    return getWrappedPromptInfo(displayPrompt, this.cursorPos, this.inputScrollTop, contentWidth, this.composerMaxRows);
  }
  public handleUndo(this: TerminalComposerHost): void {
    const state = undoPromptState(this.undoStack, this.redoStack, this.prompt, this.cursorPos);
    if (!state) return;
    this.prompt = state.prompt;
    this.cursorPos = state.cursorPos;
    this.ensureInputCursorVisible();
  }
  public handleRedo(this: TerminalComposerHost): void {
    const state = redoPromptState(this.undoStack, this.redoStack, this.prompt, this.cursorPos);
    if (!state) return;
    this.prompt = state.prompt;
    this.cursorPos = state.cursorPos;
    this.ensureInputCursorVisible();
  }
  public findPathToken(this: TerminalComposerHost): {
    start: number;
    prefix: string;
  } | null {
    return findPathToken(this.prompt, this.cursorPos);
  }
  public handlePathCompletion(this: TerminalComposerHost): boolean {
    const result = handlePathCompletion({
      prompt: this.prompt,
      cursorPos: this.cursorPos,
      inputScrollTop: this.inputScrollTop,
      contentWidth: this.contentWidth,
      maxRows: this.composerMaxRows,
      pathCompletions: this.pathCompletions,
      pathCompletionIndex: this.pathCompletionIndex,
      pathCompletionPrefix: this.pathCompletionPrefix,
      pathCompletionStart: this.pathCompletionStart,
      allFiles: this.filePicker.allFiles,
      saveUndoState: () => this.saveUndoState(),
    });
    if (!result.handled) return false;
    this.prompt = result.prompt;
    this.cursorPos = result.cursorPos;
    this.inputScrollTop = result.inputScrollTop;
    this.pathCompletions = result.pathCompletions;
    this.pathCompletionIndex = result.pathCompletionIndex;
    this.pathCompletionPrefix = result.pathCompletionPrefix;
    this.pathCompletionStart = result.pathCompletionStart;
    return true;
  }
  public wordWrapLine(this: TerminalComposerHost, line: string, maxW: number): string[] {
    return wordWrapLine(line, maxW);
  }
}

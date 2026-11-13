import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
export interface HostPairingUi {
  print(text: string): void;
  setPrompt(text: string): void;
  readPrompt?(): string;
  executeOwnerCommand(line: string): void;
  canPresent(): boolean;
  scroll?(lines: number): void;
}
interface Operation<Result> {
  readonly abort: AbortController;
  readonly home: string;
  phase: 'preview' | 'confirmation' | 'applying';
  host?: string | undefined;
  confirm?: ((answer: string, signal: AbortSignal) => Promise<Result>) | undefined;
  value: string;
  invalidInput: boolean;
}
/** What a pairing preview yields: the displayable result, and the capability to confirm it when it can be applied. */
export interface HostPairingPreview<Result> {
  readonly result: Result;
  readonly confirm?: ((answer: string, signal: AbortSignal) => Promise<Result>) | undefined;
}
export class TerminalHostPairingController<
  Request extends {
    readonly apply: boolean;
    readonly name: string;
  },
  Result extends {
    readonly host?: string | undefined;
    readonly confirmation?: string | undefined;
  },
> {
  private operation: Operation<Result> | null = null;
  private disposed = false;
  private discardUntilBoundary = false;
  constructor(
    private readonly policy: {
      readonly home: () => string;
      readonly preview: (
        request: Request,
        signal: AbortSignal,
      ) => Promise<HostPairingPreview<Result>>;
      readonly beforePreview?: ((request: Request, ui: HostPairingUi) => void) | undefined;
      readonly format: (result: Result) => string;
      readonly readRecovery: (
        home: string,
        host: string,
      ) =>
        | {
            readonly status: string;
          }
        | undefined;
      readonly pairedRecovery: (host: string) => string;
      readonly unknownRecovery: (host: string) => string;
      readonly command: string;
    },
    private readonly ui: HostPairingUi,
  ) {}
  get active(): boolean {
    return this.operation !== null;
  }
  get ownsInput(): boolean {
    return this.active || this.discardUntilBoundary;
  }
  get waitingForOwner(): boolean {
    return this.operation?.phase === 'confirmation';
  }
  private current(operation: Operation<Result>): boolean {
    return !this.disposed && this.operation === operation && !operation.abort.signal.aborted;
  }
  async start(request: Request): Promise<void> {
    this.cancel();
    if (this.disposed) return;
    this.discardUntilBoundary = false;
    if (!this.ui.canPresent()) {
      this.ui.print('Close the pending shell prompt before starting pairing. No pairing request was made.');
      return;
    }
    const operation: Operation<Result> = {
      abort: new AbortController(),
      phase: 'preview',
      value: '',
      invalidInput: false,
      home: this.policy.home(),
    };
    this.operation = operation;
    this.ui.setPrompt('');
    this.ui.print('Reading pairing preview. Escape, Ctrl-C or Ctrl-D cancels.');
    let preview: HostPairingPreview<Result>;
    try {
      this.policy.beforePreview?.(request, this.ui);
      preview = await this.policy.preview(request, operation.abort.signal);
    } catch (error) {
      // A preview that fails must not leave the operation in `preview`: that
      // keeps ownsInput true and swallows every keystroke until Esc. A cancel
      // that raced the failure has already said what it had to.
      if (this.current(operation)) {
        this.finish(operation);
        const reason = error instanceof Error ? error.message : String(error);
        this.ui.print(
          `Pairing preview failed: ${reason.replace(/[\x00-\x1f\x7f]/g, ' ').trim() || 'unknown error'}. No pairing request was made.`,
        );
      }
      return;
    }
    if (!this.current(operation)) return;
    if (!this.ui.canPresent() || this.promptReplaced(operation)) {
      this.cancelForTakeover(this.promptReplaced(operation));
      return;
    }
    operation.host = preview.result.host;
    this.ui.print(this.policy.format(preview.result));
    if (!request.apply || !preview.confirm || !preview.result.confirmation) {
      this.finish(operation);
      return;
    }
    operation.phase = 'confirmation';
    operation.confirm = preview.confirm;
    // Input queued during preview is never an answer to an undisplayed prompt.
    operation.value = '';
    operation.invalidInput = false;
    this.ui.setPrompt('');
    this.ui.print(`Type ${preview.result.confirmation} to create this host-bound administrative credential, or press Enter to cancel.`);
  }
  /** Called for each token ahead of ordinary composer/modal/model routing. */
  handleToken(token: InputToken): boolean {
    // A newly shown single-key permission prompt must not interpret the next
    // A in an in-progress PAIR answer as "approve and remember". Drain that
    // abandoned line, including its terminating key, before yielding input.
    if (this.discardUntilBoundary) {
      if (
        token.type === 'key' &&
        (token.logicalName === 'enter' ||
          token.logicalName === 'escape' ||
          (token.ctrl && (token.logicalName === 'c' || token.logicalName === 'd')))
      )
        this.discardUntilBoundary = false;
      return true;
    }
    const operation = this.operation;
    if (!operation) return false;
    if (!this.ui.canPresent() || this.promptReplaced(operation)) {
      this.cancelForTakeover(this.promptReplaced(operation));
      return true;
    }
    if (
      token.type === 'key' &&
      (token.logicalName === 'escape' || (token.ctrl && (token.logicalName === 'c' || token.logicalName === 'd')))
    ) {
      this.cancel();
      return true;
    }
    if (token.type === 'key' && (token.logicalName === 'pageup' || token.logicalName === 'pagedown')) {
      this.ui.scroll?.(token.logicalName === 'pageup' ? -5 : 5);
      return true;
    }
    if (token.type === 'mouse' && (token.button === 64 || token.button === 65)) {
      this.ui.scroll?.(token.button === 64 ? -3 : 3);
      return true;
    }
    if (token.type === 'text') {
      // No multiline/pasted command can also submit the administrative grant.
      if (/[\x00-\x1f\x7f]/.test(token.value) || operation.value.length + token.value.length > 512) operation.invalidInput = true;
      operation.value = (operation.value + token.value.replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 512);
    } else if (token.type === 'key' && token.logicalName === 'backspace') {
      operation.value = operation.value.slice(0, -1);
    } else if (token.type === 'key' && token.logicalName === 'enter' && !token.ctrl && !token.meta && !token.shift) {
      if (operation.invalidInput) {
        this.cancel();
        return true;
      }
      const answer = operation.value;
      operation.value = '';
      this.ui.setPrompt('');
      if (answer.startsWith('/')) {
        this.cancel();
        this.ui.executeOwnerCommand(answer);
      } else if (operation.phase === 'confirmation') {
        // Consume the capability before starting any asynchronous work.
        const confirm = operation.confirm;
        operation.confirm = undefined;
        operation.phase = 'applying';
        if (confirm) void this.apply(operation, confirm, answer);
      }
      return true;
    } else if (token.type === 'key' && !token.ctrl && !token.meta && (token.logicalName.length === 1 || token.logicalName === 'space')) {
      if (operation.value.length >= 512) operation.invalidInput = true;
      const character = token.logicalName === 'space' ? ' ' : token.shift ? token.logicalName.toUpperCase() : token.logicalName;
      operation.value = (operation.value + character).slice(0, 512);
    }
    this.ui.setPrompt(operation.value);
    return true;
  }
  private async apply(
    operation: Operation<Result>,
    confirm: (answer: string, signal: AbortSignal) => Promise<Result>,
    answer: string,
  ): Promise<void> {
    try {
      const result = await confirm(answer, operation.abort.signal);
      if (!this.current(operation)) return;
      if (!this.ui.canPresent() || this.promptReplaced(operation)) {
        this.cancelForTakeover(this.promptReplaced(operation));
        return;
      }
      this.ui.print(this.policy.format(result));
    } catch {
      if (this.current(operation))
        this.ui.print(`Pairing interrupted. Run ${this.policy.command} to inspect its saved state before taking further action.`);
    } finally {
      this.finish(operation);
    }
  }
  private finish(operation: Operation<Result>): void {
    if (!this.current(operation)) return;
    this.operation = null;
    operation.confirm = undefined;
    this.ui.setPrompt('');
  }
  private promptReplaced(operation: Operation<Result>): boolean {
    return this.ui.readPrompt !== undefined && this.ui.readPrompt() !== operation.value;
  }
  /** Called synchronously by shell rendering when another surface takes focus. */
  checkPresentation(): void {
    if (this.operation && (!this.ui.canPresent() || this.promptReplaced(this.operation))) {
      this.cancelForTakeover(this.promptReplaced(this.operation));
    }
  }
  cancelForTakeover(preservePrompt = false): boolean {
    if (!this.operation) return false;
    this.discardUntilBoundary = true;
    this.cancel(!preservePrompt);
    this.ui.print('Pairing input was interrupted by another prompt. Press Enter or Escape before answering the new prompt.');
    return true;
  }
  cancel(clearPrompt = true): boolean {
    const operation = this.operation;
    if (!operation) return false;
    this.operation = null;
    operation.confirm = undefined;
    operation.abort.abort();
    if (clearPrompt) this.ui.setPrompt('');
    if (this.disposed) return true;
    const state = operation.host ? this.policy.readRecovery(operation.home, operation.host) : undefined;
    if (state?.status === 'paired') {
      this.ui.print(this.policy.pairedRecovery(operation.host!));
    } else if (state?.status === 'unknown') {
      this.ui.print(this.policy.unknownRecovery(operation.host!));
    } else {
      this.ui.print(
        operation.phase === 'applying'
          ? `Pairing interrupted. Run ${this.policy.command} to inspect its saved state before taking further action; no automatic retry will occur.`
          : 'Pairing cancelled before the migration request.',
      );
    }
    return true;
  }
  dispose(): void {
    this.disposed = true;
    this.discardUntilBoundary = false;
    this.cancel();
  }
}

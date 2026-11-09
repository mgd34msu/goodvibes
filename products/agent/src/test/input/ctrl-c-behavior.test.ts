import { describe, expect, mock, test } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';

type InputHandlerTestAccess = {
  commandContext?: {
    cancelGeneration?: () => void;
  };
};

async function makeInput() {
  const selection = new SelectionManager();
  const history = new InfiniteBuffer();
  const renders: string[] = [];
  const input = new InputHandler(
    () => {
      renders.push(input.prompt);
    },
    selection,
    () => 0,
    () => 20,
    () => history,
    () => {},
    () => {},
    (await createDefaultUiRuntimeServices()),
  );
  input.setContentWidth(80);
  return { input, renders };
}

describe('Ctrl+C behavior', () => {
  test('clears prompt content even when panel workspace has focus', async () => {
    const { input, renders } = (await makeInput());
    input.prompt = 'pending text';
    input.cursorPos = input.prompt.length;
    input.indicatorFocused = true;

    input.feed('\x03');

    expect(input.prompt).toBe('');
    expect(input.cursorPos).toBe(0);
    expect(renders.at(-1)).toBe('');
  });

  test('clears prompt content even while a modal is active', async () => {
    const { input, renders } = (await makeInput());
    input.prompt = 'clear me';
    input.cursorPos = input.prompt.length;
    input.helpOverlayActive = true;
    input.modalStack.push('help');

    input.feed('\x03');

    expect(input.prompt).toBe('');
    expect(input.cursorPos).toBe(0);
    expect(input.helpOverlayActive).toBe(true);
    expect(renders.at(-1)).toBe('');
  });

  test('cancels generation globally when prompt is empty', async () => {
    const { input } = (await makeInput());
    const cancelGeneration = mock(() => {});
    (input as unknown as InputHandlerTestAccess).commandContext = { cancelGeneration };
    input.indicatorFocused = true;

    input.feed('\x03');

    expect(cancelGeneration).toHaveBeenCalled();
  });
});

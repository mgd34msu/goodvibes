/**
 * The input handler's feed: an overlay a command opens during the keystroke survives the feed, and
 * a mouse press over an open kit modal does not reach the transcript behind it.
 */
import { describe, expect, test } from 'bun:test';
import { InputTokenizer } from '@goodvibes-jev/engine/platform/platform/core';
import { InfiniteBuffer, SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { InputHandler } from '../../input/handler.ts';
import { handleMouseToken, type MouseRouteState } from '../../input/handler-feed-routes.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';

async function makeHandler(): Promise<InputHandler> {
  const history = new InfiniteBuffer();
  const input = new InputHandler(
    () => {},
    new SelectionManager(),
    () => 0,
    () => 20,
    () => history,
    () => {},
    () => {},
    await createDefaultUiRuntimeServices(),
  );
  input.setContentWidth(80);
  return input;
}

describe('input handler feed', () => {
  test('/shortcuts typed and sent in one feed leaves the shortcuts overlay open', async () => {
    const input = await makeHandler();
    const registry = new CommandRegistry();
    registry.register({
      name: 'shortcuts',
      description: 'Show shortcuts',
      handler: () => {
        // What the real opener does: set the flag on the handler while the feed is running.
        input.shortcutsOverlayActive = true;
      },
    });
    const context = {
      print: () => {},
      renderRequest: () => {},
      submitInput: () => {},
    } as unknown as CommandContext;
    context.executeCommand = (name, args) => registry.execute(name, args, context);
    input.setCommandRegistry(registry, context);
    input.feed('/shortcuts\r');
    expect(input.shortcutsOverlayActive).toBe(true);
  });

  test('a mouse press goes to the transcript normally but is swallowed while a kit modal is open', async () => {
    const press = '\x1b[<0;10;8M';
    const plain = await makeHandler();
    plain.feed(press);
    expect(plain.mouseDownRow).toBeGreaterThanOrEqual(0);

    const withModal = await makeHandler();
    withModal.surfaceModals.push({ name: 'test-modal', handleToken() {}, render: () => { throw new Error('no paint in this test'); } });
    withModal.feed(press);
    expect(withModal.mouseDownRow).toBe(-1);
  });
});

describe('mouse rows', () => {
  test('a press on the first transcript row, read from the raw terminal sequence, selects row 0', () => {
    const starts: number[] = [];
    const state: MouseRouteState = {
      conversationManager: null,
      selection: { startSelection: (_col: number, row: number) => { starts.push(row); } } as unknown as MouseRouteState['selection'],
      mouseDownRow: -1, mouseDownCol: -1, scrollTop: 0, viewportHeight: 20, lineCount: 100,
      scroll: () => {}, requestRender: () => {}, handlePaste: () => {}, handleCopy: () => {},
      bodyTopRow: () => 2,
    };
    // Terminal rows are 1-based: the third screen row is the first transcript row under a two-row header.
    const [token] = new InputTokenizer().feed('\x1b[<0;10;3M');
    handleMouseToken(state, token!);
    expect(starts).toEqual([0]);
  });
});

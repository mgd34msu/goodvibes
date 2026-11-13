/**
 * host-pairing-controller-preview-failure.test.ts, a failed preview releases the prompt.
 *
 * `start()` used to await the policy's preview outside any try, so a rejection
 * left the operation in `preview`: ownsInput stayed true, every keystroke was
 * swallowed until Esc, and the rejection escaped from a half-open prompt.
 */
import { describe, expect, test } from 'bun:test';
import { TerminalHostPairingController, type HostPairingUi } from '@goodvibes-jev/engine/terminal-shell/host-pairing-controller';

type Request = { readonly apply: boolean; readonly name: string };
type Result = { readonly host?: string; readonly confirmation?: string };

function make(preview: () => Promise<never>, beforePreview?: () => void) {
  const printed: string[] = [];
  let prompt = '';
  const ui: HostPairingUi = {
    print: (text) => { printed.push(text); },
    setPrompt: (text) => { prompt = text; },
    readPrompt: () => prompt,
    executeOwnerCommand: () => {},
    canPresent: () => true,
  };
  const controller = new TerminalHostPairingController<Request, Result>(
    {
      home: () => '/tmp/home',
      preview,
      beforePreview,
      format: () => 'formatted',
      readRecovery: () => undefined,
      pairedRecovery: () => 'paired',
      unknownRecovery: () => 'unknown',
      command: '/host pair',
    },
    ui,
  );
  return { controller, printed };
}

describe('host pairing preview failure', () => {
  test('a rejected preview ends the operation, releases input and reports the failure', async () => {
    const { controller, printed } = make(async () => { throw new Error('daemon unreachable'); });
    await controller.start({ apply: true, name: 'n' });
    expect(controller.active).toBe(false);
    expect(controller.ownsInput).toBe(false);
    expect(controller.handleToken({ type: 'text', value: 'x' } as never)).toBe(false);
    expect(printed.join('\n')).toContain('Pairing preview failed: daemon unreachable. No pairing request was made.');
  });

  test('a beforePreview that throws is handled the same way', async () => {
    const { controller, printed } = make(async () => { throw new Error('unused'); }, () => { throw new Error('bad banner'); });
    await controller.start({ apply: false, name: 'n' });
    expect(controller.ownsInput).toBe(false);
    expect(printed.join('\n')).toContain('bad banner');
  });

  test('a rejection caused by cancelling is not reported as a failure', async () => {
    let rejectPreview: (error: Error) => void = () => {};
    const { controller, printed } = make(() => new Promise<never>((_resolve, reject) => { rejectPreview = reject; }));
    const started = controller.start({ apply: true, name: 'n' });
    controller.cancel();
    rejectPreview(new Error('aborted'));
    await started;
    expect(controller.ownsInput).toBe(false);
    expect(printed.join('\n')).not.toContain('Pairing preview failed');
  });
});

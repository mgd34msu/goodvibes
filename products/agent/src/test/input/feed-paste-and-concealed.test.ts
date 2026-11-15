import { describe, test, expect } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';


async function makeInput(): Promise<InputHandler> {
  const history = new InfiniteBuffer();
  const ih = new InputHandler(() => {}, new SelectionManager(), () => 0, () => 20, () => history, () => {}, () => {}, await createDefaultUiRuntimeServices());
  ih.setContentWidth(40);
  return ih;
}

const block = (tag: string) => Array.from({ length: 10 }, (_, i) => `${tag} line ${i + 1}`).join('\n');
const paste = (text: string) => `\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`;

describe('paste ids across feeds', () => {
  test('two large pastes in separate chunks get distinct ids and both expand', async () => {
    const ih = await makeInput();
    const first = block('alpha');
    const second = block('beta');
    ih.feed(paste(first));
    ih.feed(paste(second));
    const markers = ih.prompt.match(/\[TEXT: p\d+, 10 lines\]/g) ?? [];
    expect(markers.length).toBe(2);
    expect(new Set(markers).size).toBe(2);
    const expanded = ih.expandPrompt(ih.prompt);
    expect(expanded).toBe(first + second);
  });
});

describe('concealed entry takes text verbatim', () => {
  function conceal(ih: InputHandler): { received: string[] } {
    const received: string[] = [];
    ih.beginConcealedInput({ onSubmit: (value) => { received.push(value); } });
    return { received };
  }

  test('a multi-line paste reaches onSubmit whole, not as a paste marker', async () => {
    const ih = await makeInput();
    const { received } = conceal(ih);
    const secret = block('key');
    ih.feed(paste(secret));
    ih.feed('\r');
    expect(received).toEqual([secret]);
  });

  test('a leading @ does not open the file picker', async () => {
    const ih = await makeInput();
    const { received } = conceal(ih);
    ih.feed('@abc');
    expect(ih.filePicker.active).toBe(false);
    expect(ih.prompt).toBe('@abc');
    ih.feed('\r');
    expect(received).toEqual(['@abc']);
  });

  test('a leading / is delivered as the secret, not dispatched as a command', async () => {
    const ih = await makeInput();
    const { received } = conceal(ih);
    ih.feed('/abc');
    expect(ih.commandMode).toBe(false);
    ih.feed('\r');
    expect(received).toEqual(['/abc']);
  });

  test('? on an empty field is typed, not swallowed by help', async () => {
    const ih = await makeInput();
    conceal(ih);
    ih.feed('?');
    expect(ih.prompt).toBe('?');
  });
});

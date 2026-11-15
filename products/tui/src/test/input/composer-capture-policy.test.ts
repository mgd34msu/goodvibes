import { describe, expect, test } from 'bun:test';
import { applyComposerCapture, splitAtModelDirectives } from '@/input/composer-capture.ts';

describe('splitAtModelDirectives', () => {
  test('leading directives are split off in order and the rest is the prompt', () => {
    expect(splitAtModelDirectives('@model:a @model:b explain this')).toEqual({ models: ['a', 'b'], text: 'explain this' });
  });

  test('a directive inside pasted text is not a directive', () => {
    const input = 'the log said @model:next once';
    expect(splitAtModelDirectives(input)).toEqual({ models: [], text: input });
  });
});

describe('applyComposerCapture on multi-line text', () => {
  test('a pasted prompt that opens with a heading line is sent, not saved as a note', () => {
    const added: string[] = [];
    const deps = { sessionMemoryStore: { add: (text: string) => { added.push(text); return 'id'; } }, notify: () => {} };
    const input = '# Design brief\nbuild the thing';
    expect(applyComposerCapture(input, deps)).toEqual({ text: input, captured: false });
    expect(added).toEqual([]);
  });
});

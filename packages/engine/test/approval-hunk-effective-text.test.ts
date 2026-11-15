import { describe, expect, test } from 'bun:test';
import { buildModifiedEditArgs, readApprovalEditHunks } from '../platform/src/platform/control-plane/approval-hunk-apply.ts';

const b64 = (text: string): string => Buffer.from(text).toString('base64');

describe('approval edit hunks show the text the edit tool writes', () => {
  test('a replace_base64 beside a plain empty replace is read as the decoded replacement', () => {
    const hunks = readApprovalEditHunks({ edits: [{ path: 'a.ts', find: 'x', replace: '', replace_base64: b64('z') }] });
    expect(hunks?.[0]).toMatchObject({ path: 'a.ts', find: 'x', replace: 'z' });
  });

  test('a find_base64 beside a plain empty find is read as the decoded find, and a base64-only entry is a hunk', () => {
    const hunks = readApprovalEditHunks({ edits: [
      { path: 'a.ts', find: '', find_base64: b64('old'), replace: 'new' },
      { path: 'b.ts', find_base64: b64('p'), replace_base64: b64('q') },
    ] });
    expect(hunks?.map((h) => [h.find, h.replace])).toEqual([['old', 'new'], ['p', 'q']]);
  });

  test('a per-hunk selection keeps the other edit fields and stays consistent with its base64 twin', () => {
    const args = { edits: [{ path: 'a.ts', find: 'x', replace: '', replace_base64: b64('z'), hints: { near_line: 4 } }] };
    const modified = buildModifiedEditArgs({ args }, [0]);
    // The selected entries run exactly as the model sent them; the edit tool reads the base64 field first.
    expect(modified['edits']).toEqual([args.edits[0]]);
  });

  test('an entry whose plain and base64 text disagree is not a hunk, as the edit tool refuses it', () => {
    expect(readApprovalEditHunks({ edits: [{ path: 'a.ts', find: 'shown', find_base64: b64('written'), replace: 'n' }] })).toBeNull();
  });

  test('an entry with neither a plain nor an encoded find is not a hunk', () => {
    expect(readApprovalEditHunks({ edits: [{ path: 'a.ts', replace: 'n' }] })).toBeNull();
  });
});

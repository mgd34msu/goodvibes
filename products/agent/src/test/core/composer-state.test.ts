import { describe, expect, test } from 'bun:test';
import { deriveComposerState } from '../../core/composer-state.ts';

describe('composer state', () => {
  test('an approval wait is one tag: risk approval-wait, no approval flag and no turn state', () => {
    const state = deriveComposerState({
      text: '/review current branch',
      commandMode: true,
      pendingApproval: true,
      turnState: 'preflight',
    });
    expect(state.modeLabel).toBe('delegation');
    expect(state.statusLabel).toBe('idle');
    expect(state.flags).not.toContain('approval');
    expect(state.flags).toContain('delegation');
    expect(state.pendingRisk).toBe('approval-wait');
  });

  test('marks shell submissions as risky without approval wait', () => {
    const state = deriveComposerState({
      text: '!rm -rf build',
      turnState: 'idle',
    });
    expect(state.modeLabel).toBe('shell');
    expect(state.pendingRisk).toBe('shell');
  });
});

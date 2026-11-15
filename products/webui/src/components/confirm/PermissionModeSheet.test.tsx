/**
 * PermissionModeSheet, a write in flight locks the list and the dismissals so a
 * second mode cannot be chosen, or the sheet closed, under the first.
 */
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SESSION_GATE_PRESET_NAMES } from '@goodvibes-jev/engine/platform/platform/gate/presets';
import { PermissionModeSheet } from './PermissionModeSheet';

function render(props: Partial<React.ComponentProps<typeof PermissionModeSheet>>) {
  const selected: string[] = [];
  let cancelled = 0;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(PermissionModeSheet, {
      open: true,
      currentMode: SESSION_GATE_PRESET_NAMES[0] ?? '',
      onSelect: (mode) => selected.push(mode),
      onCancel: () => { cancelled += 1; },
      ...props,
    }));
  });
  return {
    selected,
    cancelled: () => cancelled,
    choices: () => [...document.body.querySelectorAll<HTMLButtonElement>('.gv-choice')],
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

describe('PermissionModeSheet', () => {
  test('choosing a mode hands it to the caller and marks the current one', () => {
    const view = render({});
    const choices = view.choices();
    expect(choices).toHaveLength(SESSION_GATE_PRESET_NAMES.length);
    expect(choices[0]?.getAttribute('aria-pressed')).toBe('true');
    const other = SESSION_GATE_PRESET_NAMES.length > 1 ? 1 : 0;
    flushSync(() => choices[other]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(view.selected).toEqual([SESSION_GATE_PRESET_NAMES[other]]);
    view.unmount();
  });

  test('while a write is pending the choices are disabled and the scrim does not close the sheet', () => {
    const view = render({ pendingMode: SESSION_GATE_PRESET_NAMES[0] ?? '' });
    expect(view.choices().every((button) => button.disabled)).toBe(true);
    flushSync(() => document.body.querySelector('.scrim')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(view.cancelled()).toBe(0);
    view.unmount();
  });

  test('with nothing pending the scrim closes the sheet', () => {
    const view = render({});
    flushSync(() => document.body.querySelector('.scrim')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(view.cancelled()).toBe(1);
    view.unmount();
  });
});

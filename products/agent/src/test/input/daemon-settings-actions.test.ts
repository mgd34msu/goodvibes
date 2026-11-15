/**
 * Tests for openDaemonTimezonePicker: a picker over real IANA zone names
 * with an explicit unset option, never a free-text field.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { openDaemonTimezonePicker } from '../../input/daemon-settings-actions.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import type { SelectionItem, SelectionResult } from '../../input/selection-modal.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'agent',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-agent'),
  });
}

/** Captures what openSelection was called with and lets a test drive the callback as if a user picked a row. */
function makeContext(cm: ConfigManager): {
  ctx: CommandContext;
  items: () => SelectionItem[];
  choose: (id: string) => void;
  cancel: () => void;
  options: () => { preSelectId?: string } | undefined;
  printed: () => string[];
  rendered: () => number;
} {
  let capturedItems: SelectionItem[] = [];
  let capturedOptions: { preSelectId?: string } | undefined;
  let capturedCallback: ((result: SelectionResult | null) => void) | null = null;
  const printedLines: string[] = [];
  let renderCount = 0;

  const ctx = {
    platform: { configManager: cm },
    print: (text: string) => { printedLines.push(text); },
    renderRequest: () => { renderCount += 1; },
    openSelection: (
      _title: string,
      items: SelectionItem[],
      opts: { preSelectId?: string },
      callback: (result: SelectionResult | null) => void,
    ) => {
      capturedItems = items;
      capturedOptions = opts;
      capturedCallback = callback;
    },
  } as unknown as CommandContext;

  return {
    ctx,
    items: () => capturedItems,
    choose: (id: string) => {
      const item = capturedItems.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`no item with id ${id}`);
      capturedCallback?.({ item, action: 'select' });
    },
    cancel: () => { capturedCallback?.(null); },
    options: () => capturedOptions,
    printed: () => printedLines,
    rendered: () => renderCount,
  };
}

describe('openDaemonTimezonePicker', () => {
  let cm: ConfigManager;

  beforeEach(() => {
    cm = createConfigManager(makeProjectTempDir('gv-daemon-tz-picker-test'));
  });

  test('offers UTC (unset) plus every IANA zone Intl recognizes on this host', () => {
    const { ctx, items } = makeContext(cm);
    openDaemonTimezonePicker(ctx);
    const list = items();
    expect(list[0]?.label).toBe('UTC (unset)');
    expect(list.map((item) => item.id)).toContain('America/New_York');
    expect(list.length).toBe(Intl.supportedValuesOf('timeZone').length + 1);
  });

  test('selecting a real IANA zone writes exactly that zone name', () => {
    const { ctx, choose } = makeContext(cm);
    openDaemonTimezonePicker(ctx);
    choose('America/New_York');
    expect(cm.get('daemon.timezone')).toBe('America/New_York');
  });

  test('selecting UTC (unset) writes an empty string', () => {
    cm.setDynamic('daemon.timezone', 'Europe/London');
    const { ctx, choose } = makeContext(cm);
    openDaemonTimezonePicker(ctx);
    choose('__daemon_timezone_utc_unset__');
    expect(cm.get('daemon.timezone')).toBe('');
  });

  test('cancelling the picker changes nothing and prints nothing', () => {
    cm.setDynamic('daemon.timezone', 'Europe/London');
    const { ctx, cancel, printed, rendered } = makeContext(cm);
    openDaemonTimezonePicker(ctx);
    cancel();
    expect(cm.get('daemon.timezone')).toBe('Europe/London');
    expect(printed()).toEqual([]);
    expect(rendered()).toBe(0);
  });

  test('without a selection modal it reports not handled and leaves the setting alone', () => {
    cm.setDynamic('daemon.timezone', 'Europe/London');
    const ctx = { platform: { configManager: cm }, print: () => {}, renderRequest: () => {} } as unknown as CommandContext;
    expect(openDaemonTimezonePicker(ctx)).toBe(false);
    expect(cm.get('daemon.timezone')).toBe('Europe/London');
  });

  test('the current zone is pre-selected and marked, and unset is marked current when empty', () => {
    cm.setDynamic('daemon.timezone', 'Europe/London');
    const withZone = makeContext(cm);
    openDaemonTimezonePicker(withZone.ctx);
    expect(withZone.options()?.preSelectId).toBe('Europe/London');
    expect(withZone.items().find((item) => item.id === 'Europe/London')?.detail).toContain('(current)');
    expect(withZone.items()[0]?.detail).toBe('clears daemon.timezone');

    cm.setDynamic('daemon.timezone', '');
    const unset = makeContext(cm);
    openDaemonTimezonePicker(unset.ctx);
    expect(unset.options()?.preSelectId).toBe('__daemon_timezone_utc_unset__');
    expect(unset.items()[0]?.detail).toBe('(current)');
  });

  test('a selection prints what was set and requests a render', () => {
    const { ctx, choose, printed, rendered } = makeContext(cm);
    openDaemonTimezonePicker(ctx);
    choose('Asia/Tokyo');
    expect(printed()).toEqual(['Daemon timezone set to Asia/Tokyo.']);
    expect(rendered()).toBe(1);
  });
});

import { describe, expect, test } from 'bun:test';
import { createProcessIo } from '../platform/src/bin/contract-cli-host.js';

describe('contract CLI process io interrupt', () => {
  test('Ctrl-C with nothing following a run ends the process with the interrupt status', () => {
    const exits: number[] = [];
    const io = createProcessIo({ exit: (code) => exits.push(code) });
    try {
      process.emit('SIGINT');
    } finally {
      io.close();
    }
    expect(exits).toEqual([130]);
  });

  test('Ctrl-C while a run is followed reaches the handler and does not end the process', () => {
    const exits: number[] = [];
    const io = createProcessIo({ exit: (code) => exits.push(code) });
    let interrupts = 0;
    const unregister = io.onInterrupt(() => { interrupts += 1; });
    try {
      process.emit('SIGINT');
      unregister();
      process.emit('SIGINT');
    } finally {
      io.close();
    }
    expect(interrupts).toBe(1);
    expect(exits).toEqual([130]);
  });
});

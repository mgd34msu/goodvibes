import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  _resetHardwareProfileCache,
  _setHardwareProfileForTest,
  readHardwareProfileSync,
  startHardwareProbe,
} from '../../core/hardware-profile.ts';

afterEach(() => _resetHardwareProfileCache());

function fakeSpawn(spawned: string[]): Parameters<typeof startHardwareProbe>[0] {
  return ((command: string) => {
    spawned.push(command);
    return Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
  }) as never;
}

describe('startHardwareProbe', () => {
  test('spawns the GPU query once however many times it is called', () => {
    const spawned: string[] = [];
    startHardwareProbe(fakeSpawn(spawned));
    startHardwareProbe(fakeSpawn(spawned));
    expect(spawned).toEqual(['nvidia-smi']);
  });
});

describe('readHardwareProfileSync', () => {
  test('reports free RAM as of each read while keeping the cached CPU and GPU facts', () => {
    const free = [8, 3];
    const readRam = () => ({ totalRamBytes: 16, availableRamBytes: free.shift() ?? null });
    const first = readHardwareProfileSync(readRam);
    const second = readHardwareProfileSync(readRam);
    expect(first.availableRamBytes).toBe(8);
    expect(second.availableRamBytes).toBe(3);
    expect(second.cpuCores).toBe(first.cpuCores);
  });

  test('a profile injected for a test is returned as given', () => {
    const injected = { totalRamBytes: 16, availableRamBytes: 12, gpus: [], cpuCores: 4 };
    _setHardwareProfileForTest(injected);
    expect(readHardwareProfileSync(() => ({ totalRamBytes: 1, availableRamBytes: 1 }))).toBe(injected);
  });
});

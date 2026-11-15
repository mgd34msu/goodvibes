/**
 * Console observer output and invokeObserver error isolation
 * (platform/src/observer/index.ts). The OpenTelemetry observer is covered by
 * observer-otel.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  createConsoleObserver,
  invokeObserver,
} from '../platform/src/observer/index.js';
import { GoodVibesError } from '../errors/src/index.js';
import { captureConsole } from './_helpers/test-timeout.js';

// ---------------------------------------------------------------------------
// createConsoleObserver, debug level exercises all callbacks
// ---------------------------------------------------------------------------

describe('createConsoleObserver: debug level', () => {
  test('onTransportActivity at debug level logs to console.debug (send: no status/dur)', () => {
    const obs = createConsoleObserver({ level: 'debug' });
    const capture = captureConsole('debug', /transport send/);
    try {
      obs.onTransportActivity?.({ direction: 'send', url: 'http://localhost/api', kind: 'http' });
      expect(capture.messages).toHaveLength(1);
      expect(String(capture.messages[0]![0])).toMatch(/transport send http http:\/\/localhost\/api/);
    } finally {
      capture.restore();
    }
  });

  test('onTransportActivity at debug level logs status and duration when present', () => {
    const obs = createConsoleObserver({ level: 'debug' });
    const capture = captureConsole('debug', /transport recv|transport send/);
    try {
      obs.onTransportActivity?.({
        direction: 'recv',
        url: 'http://localhost/api',
        kind: 'http',
        status: 200,
        durationMs: 42,
      });
      expect(capture.messages).toHaveLength(1);
      expect(String(capture.messages[0]![0])).toMatch(/status=200/);
      expect(String(capture.messages[0]![0])).toMatch(/42ms/);
    } finally {
      capture.restore();
    }
  });

  test('onTransportActivity at info level does NOT log', () => {
    const obs = createConsoleObserver({ level: 'info' });
    const capture = captureConsole('debug', /transport send/);
    try {
      obs.onTransportActivity?.({ direction: 'send', url: 'http://localhost/api', kind: 'http' });
      expect(capture.messages).toHaveLength(0);
    } finally {
      capture.restore();
    }
  });

  test('onEvent at debug level logs to console.debug', () => {
    const obs = createConsoleObserver({ level: 'debug' });
    const capture = captureConsole('debug', /event runtime\.turn\.start/);
    try {
      obs.onEvent?.({ type: 'runtime.turn.start' } as unknown as Parameters<NonNullable<typeof obs.onEvent>>[0]);
      expect(capture.messages).toHaveLength(1);
      expect(String(capture.messages[0]![0])).toMatch(/event runtime.turn.start/);
    } finally {
      capture.restore();
    }
  });

  test('onEvent at info level does NOT log', () => {
    const obs = createConsoleObserver({ level: 'info' });
    const capture = captureConsole('debug', /event runtime\.turn\.start/);
    try {
      obs.onEvent?.({ type: 'runtime.turn.start' } as unknown as Parameters<NonNullable<typeof obs.onEvent>>[0]);
      expect(capture.messages).toHaveLength(0);
    } finally {
      capture.restore();
    }
  });

  test('onError logs kind and category to console.error', () => {
    const obs = createConsoleObserver({ level: 'info' });
    const capture = captureConsole('error', /rate-limit/);
    try {
      const err = new GoodVibesError('test error', { category: 'rate_limit' });
      obs.onError?.(err);
      expect(capture.messages).toHaveLength(1);
      expect(capture.messages[0]?.join(' ')).toMatch(/rate-limit/);
    } finally {
      capture.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// invokeObserver, core behavior
// ---------------------------------------------------------------------------

describe('invokeObserver', () => {
  test('calls the provided thunk', () => {
    let called = false;
    const result = invokeObserver(() => { called = true; });
    expect(called).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('isolates, reports, and returns errors thrown by the thunk', () => {
    const err = new Error('boom');
    const capture = captureConsole('warn', /observer callback failed: testObserver/);
    try {
      const result = invokeObserver(() => { throw err; }, { label: 'testObserver' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(err);
      }
      expect(capture.messages).toHaveLength(1);
      expect(String(capture.messages[0]?.[0])).toMatch(/observer callback failed: testObserver/);
      expect(capture.messages[0]?.[1]).toBe(err);
    } finally {
      capture.restore();
    }
  });
});

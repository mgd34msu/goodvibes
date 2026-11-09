/**
 * hermes-runner.js
 *
 * Entry point bundled by Bun into a single IIFE for execution under the
 * Hermes binary. This file may use modern JS features; Bun transpiles them
 * to Hermes-safe equivalents during bundling.
 *
 * DO NOT import node: builtins here, Hermes has no Node.js standard library.
 * DO NOT use Bun.* APIs, not available inside the Hermes VM.
 */

// print() is native in the Hermes CLI but absent in JSI-embedded Hermes
// (React Native). This adapter makes the runner portable to both environments.
var print = typeof globalThis.print === 'function' ? globalThis.print : console.log;

// Imports are hoisted by the bundler; place them at the top before any code
// that depends on them. Bun resolves these from the workspace.
import {
  createReactNativeGoodVibesPlatform,
} from '@goodvibes-jev/engine/platform/react-native';

import {
  createExpoGoodVibesPlatform,
} from '@goodvibes-jev/engine/platform/expo';

import {
  GoodVibesError,
  ConfigurationError,
  ContractError,
  HttpStatusError,
} from '@goodvibes-jev/engine/platform/errors';

// ---------------------------------------------------------------------------
// Tiny test runner (Hermes-safe: no async test queue, synchronous execution)
// ---------------------------------------------------------------------------

var PASS = 0;
var FAIL = 0;
var ERRORS = [];

function describe(label, fn) {
  // Groups tests; purely cosmetic in this runner
  print('[suite] ' + label);
  fn();
}

function test(label, fn) {
  try {
    fn();
    PASS++;
    print('  PASS: ' + label);
  } catch (e) {
    FAIL++;
    var msg = e && e.message ? e.message : String(e);
    ERRORS.push(label + ': ' + msg);
    print('  FAIL: ' + label + ' -- ' + msg);
  }
}

function expect(actual) {
  return {
    toBe: function (expected) {
      if (actual !== expected) {
        throw new Error('Expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
      }
    },
    toEqual: function (expected) {
      var a = JSON.stringify(actual);
      var b = JSON.stringify(expected);
      if (a !== b) {
        throw new Error('Expected ' + b + ', got ' + a);
      }
    },
    toBeDefined: function () {
      if (actual === undefined) {
        throw new Error('Expected value to be defined, got undefined');
      }
    },
    toBeNull: function () {
      if (actual !== null) {
        throw new Error('Expected null, got ' + JSON.stringify(actual));
      }
    },
    toBeTruthy: function () {
      if (!actual) {
        throw new Error('Expected truthy, got ' + JSON.stringify(actual));
      }
    },
    toBeFalsy: function () {
      if (actual) {
        throw new Error('Expected falsy, got ' + JSON.stringify(actual));
      }
    },
    toBeInstanceOf: function (Ctor) {
      if (!(actual instanceof Ctor)) {
        throw new Error('Expected instance of ' + (Ctor.name || Ctor) + ', got ' + typeof actual);
      }
    },
    toThrow: function () {
      // actual should be a function
      var threw = false;
      try { actual(); } catch (_) { threw = true; }
      if (!threw) throw new Error('Expected function to throw, but it did not');
    },
    toContain: function (substring) {
      if (typeof actual !== 'string' || actual.indexOf(substring) === -1) {
        throw new Error('Expected string to contain ' + JSON.stringify(substring));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Engine feature detection -- probes for Hermes quirks
// Each probe documents a known Hermes runtime support concern.
// ---------------------------------------------------------------------------

describe('Hermes engine feature parity', function () {

  test('globalThis is defined', function () {
    expect(typeof globalThis).toBe('object');
  });

  test('Object.hasOwn is available', function () {
    // Added in Hermes 0.11.0 / RN 0.70. Earlier Hermes lacks it.
    if (typeof Object.hasOwn !== 'function') {
      throw new Error('Object.hasOwn is not a function -- Hermes version too old or polyfill missing');
    }
    expect(Object.hasOwn({ a: 1 }, 'a')).toBe(true);
    expect(Object.hasOwn({ a: 1 }, 'b')).toBe(false);
  });

  test('nullish coalescing (??) is supported', function () {
    var x = null;
    var y = x ?? 'default';
    expect(y).toBe('default');
  });

  test('optional chaining (?.) is supported', function () {
    var obj = { a: { b: 42 } };
    expect(obj?.a?.b).toBe(42);
    expect(obj?.c?.d).toBe(undefined);
  });

  test('Promise is available and has allSettled', function () {
    // Hermes has Promise; allSettled added in later versions.
    expect(typeof Promise).toBe('function');
    if (typeof Promise.allSettled !== 'function') {
      throw new Error('Promise.allSettled is not available -- polyfill required for this Hermes version');
    }
  });

  test('Array.prototype.at is available', function () {
    // Added in Hermes 0.11+ / RN 0.74. Absent in older Hermes.
    // platform USAGE: Array.prototype.at() is used in
    // packages/platform/src/platform/runtime/forensics/registry.ts (lines 73, 119) for last-element access.
    var arr = [1, 2, 3];
    if (typeof arr.at !== 'function') {
      throw new Error('Array.prototype.at is not available -- Hermes version too old or polyfill missing');
    }
    expect(arr.at(-1)).toBe(3);
  });

  test('structuredClone is available', function () {
    // Added in Hermes bundled with RN 0.73+.
    // platform USAGE: structuredClone is used pervasively in packages/platform/src/platform/config/manager.ts,
    // packages/platform/src/platform/core/conversation-utils.ts, packages/platform/src/platform/runtime/settings/control-plane.ts,
    // and several other platform modules for deep-cloning state snapshots.
    if (typeof structuredClone !== 'function') {
      throw new Error('structuredClone is not available -- Hermes version too old or polyfill missing');
    }
    var orig = { a: 1, b: [2, 3] };
    var clone = structuredClone(orig);
    expect(clone.a).toBe(1);
    expect(clone === orig).toBe(false);
  });

  test('[advisory] regex lookbehind assertion is supported', function () {
    // Hermes had incomplete lookbehind support in older releases.
    // platform USAGE: Regex lookbehind (?<=...) is NOT currently used in any platform source file.
    // This probe is an advisory Hermes-version indicator: a failure signals an old
    // Hermes build but does NOT indicate a broken platform feature on that Hermes version.
    var re = /(?<=foo)bar/;
    var match = 'foobar'.match(re);
    if (!match) {
      throw new Error('Regex lookbehind returned no match -- possible Hermes engine quirk');
    }
    expect(match[0]).toBe('bar');
  });

  test('[advisory] WeakRef is available', function () {
    // platform USAGE: WeakRef is NOT currently used in any platform source file.
    // This probe is an advisory Hermes-version indicator: a failure means
    // the Hermes build is older than 0.11 (RN < 0.70) but does NOT indicate
    // a broken platform feature on that Hermes version.
    if (typeof WeakRef !== 'function') {
      throw new Error('WeakRef is not available -- Hermes version too old');
    }
    var obj = { x: 1 };
    var ref = new WeakRef(obj);
    expect(ref.deref().x).toBe(1);
  });

  test('Error.cause is supported', function () {
    var cause = new Error('root');
    var err = new Error('wrapper', { cause: cause });
    if (err.cause !== cause) {
      throw new Error('Error.cause is not preserved -- Hermes version too old');
    }
    expect(err.cause).toBe(cause);
  });

  test('Logical assignment operators (??= ||= &&=) are supported', function () {
    var a = null;
    a ??= 'assigned';
    expect(a).toBe('assigned');

    var b = '';
    b ||= 'assigned-or';
    expect(b).toBe('assigned-or');

    var c = 'keep';
    c &&= 'replaced';
    expect(c).toBe('replaced');
  });

  test('Object.fromEntries is available', function () {
    var entries = [['a', 1], ['b', 2]];
    var obj = Object.fromEntries(entries);
    expect(obj.a).toBe(1);
    expect(obj.b).toBe(2);
  });

  test('queueMicrotask is available (warn only in bare CLI)', function () {
    // Hermes exposes queueMicrotask in RN environment.
    // In bare Hermes CLI it may not be present -- treat as advisory.
    if (typeof queueMicrotask !== 'function') {
      throw new Error('queueMicrotask is not available -- bare Hermes CLI environment, not full RN runtime');
    }
  });

  test('AbortController is available (warn only in bare CLI)', function () {
    // Available in Hermes since RN 0.71. Absent in bare Hermes CLI.
    if (typeof AbortController !== 'function') {
      throw new Error('AbortController is not available -- bare Hermes CLI or old RN version');
    }
    var ac = new AbortController();
    expect(ac.signal.aborted).toBe(false);
    ac.abort();
    expect(ac.signal.aborted).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// platform surface smoke tests -- validates the react-native bundle API shape
// These tests do NOT make network calls; they exercise factory + error paths.
// ---------------------------------------------------------------------------

describe('platform react-native factory -- ConfigurationError on bad inputs', function () {

  test('createReactNativeGoodVibesPlatform throws ConfigurationError on empty baseUrl', function () {
    var threw = false;
    var caught = null;
    try {
      createReactNativeGoodVibesPlatform({ baseUrl: '', authToken: 'tok' });
    } catch (e) {
      threw = true;
      caught = e;
    }
    expect(threw).toBe(true);
    expect(caught).toBeInstanceOf(ConfigurationError);
  });

  test('createExpoGoodVibesPlatform is a callable function', function () {
    expect(typeof createReactNativeGoodVibesPlatform).toBe('function');
    expect(typeof createExpoGoodVibesPlatform).toBe('function');
  });

  test('createReactNativeGoodVibesPlatform returns object with realtime.runtime method', function () {
    var platformClient = createReactNativeGoodVibesPlatform({
      baseUrl: 'https://example.com',
      authToken: 'test-token',
      // Provide a stub WebSocket so we do not fail on the WebSocket check.
      // In bare Hermes, globalThis.WebSocket does not exist.
      WebSocketImpl: function FakeWebSocket() {},
    });
    expect(typeof platformClient).toBe('object');
    expect(typeof platformClient.realtime).toBe('object');
    expect(typeof platformClient.realtime.runtime).toBe('function');
    expect(typeof platformClient.realtime.viaWebSocket).toBe('function');
  });

  test('createReactNativeGoodVibesPlatform returns object with auth namespace', function () {
    var platformClient = createReactNativeGoodVibesPlatform({
      baseUrl: 'https://example.com',
      authToken: 'test-token',
      WebSocketImpl: function FakeWebSocket() {},
    });
    expect(typeof platformClient.auth).toBe('object');
    expect(typeof platformClient.auth.getToken).toBe('function');
  });

  test('platform.auth.getToken returns the initial token', function () {
    var platformClient = createReactNativeGoodVibesPlatform({
      baseUrl: 'https://example.com',
      authToken: 'my-static-token',
      WebSocketImpl: function FakeWebSocket() {},
    });
    var token = platformClient.auth.getToken();
    expect(token).toBe('my-static-token');
  });

  test('realtime.runtime() throws ConfigurationError when WebSocket unavailable', function () {
    // Do NOT pass WebSocketImpl and globalThis.WebSocket is absent in bare Hermes.
    var platformClient = createReactNativeGoodVibesPlatform({
      baseUrl: 'https://example.com',
      authToken: 'tok',
      // WebSocketImpl deliberately omitted
    });
    if (typeof globalThis.WebSocket === 'undefined') {
      var threw = false;
      var caught = null;
      try {
        platformClient.realtime.runtime();
      } catch (e) {
        threw = true;
        caught = e;
      }
      expect(threw).toBe(true);
      expect(caught).toBeInstanceOf(ConfigurationError);
    }
    // If globalThis.WebSocket IS present (e.g. polyfilled), test is a no-op.
  });

});

describe('platform error taxonomy -- Hermes prototype chain integrity', function () {

  test('ConfigurationError instanceof Error', function () {
    var err = new ConfigurationError('test');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof GoodVibesError).toBe(true);
    expect(err instanceof ConfigurationError).toBe(true);
  });

  test('ConfigurationError.kind is set to config', function () {
    var err = new ConfigurationError('test');
    expect(err.kind).toBe('config');
  });

  test('ContractError instanceof GoodVibesError', function () {
    var err = new ContractError('bad contract');
    expect(err instanceof GoodVibesError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  test('HttpStatusError instanceof GoodVibesError', function () {
    var err = new HttpStatusError('not found', { status: 404, url: 'https://example.com/api', method: 'GET', body: null });
    expect(err instanceof GoodVibesError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  test('Error prototype chain preserved under Hermes custom class extension', function () {
    // Hermes had a known issue (pre-0.9) where custom Error subclasses had
    // broken instanceof checks if the prototype chain was manually wired.
    var errors = [
      new ConfigurationError('c'),
      new ContractError('ct'),
    ];
    for (var i = 0; i < errors.length; i++) {
      var e = errors[i];
      expect(e instanceof Error).toBe(true);
      expect(e instanceof GoodVibesError).toBe(true);
      expect(typeof e.message).toBe('string');
      expect(typeof e.kind).toBe('string');
    }
  });

  test('GoodVibesError has name property', function () {
    var err = new ConfigurationError('test');
    expect(typeof err.name).toBe('string');
  });

});

describe('platform observable patterns -- synchronous surface verification', function () {

  test('platform.operator is accessible', function () {
    var platformClient = createReactNativeGoodVibesPlatform({
      baseUrl: 'https://example.com',
      authToken: 'tok',
      WebSocketImpl: function FakeWebSocket() {},
    });
    // The operator sub-platform should expose an observable agents surface.
    // We do not call network methods -- just verify the shape.
    expect(typeof platformClient.operator).toBe('object');
  });

  test('platform.operator.agents is accessible', function () {
    var platformClient = createReactNativeGoodVibesPlatform({
      baseUrl: 'https://example.com',
      authToken: 'tok',
      WebSocketImpl: function FakeWebSocket() {},
    });
    expect(typeof platformClient.operator.agents).toBe('object');
  });

  test('platform.peer sub-platform is accessible', function () {
    var platformClient = createReactNativeGoodVibesPlatform({
      baseUrl: 'https://example.com',
      authToken: 'tok',
      WebSocketImpl: function FakeWebSocket() {},
    });
    expect(typeof platformClient.peer).toBe('object');
  });

});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

print('');
print('=== Hermes Test Summary ===');
print('PASS: ' + PASS);
print('FAIL: ' + FAIL);

if (ERRORS.length > 0) {
  print('');
  print('Failures:');
  for (var i = 0; i < ERRORS.length; i++) {
    print('  - ' + ERRORS[i]);
  }
}

if (FAIL > 0) {
  // Hermes exits with code 1 if we throw at top level
  throw new Error('Hermes test run finished with ' + FAIL + ' failure(s)');
}

print('All tests passed.');

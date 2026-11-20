"use strict";
/**
 * A collection of async utilities.
 * If we ever need to add anything fancy, then https://github.com/vscode-shellcheck/vscode-shellcheck/blob/master/src/utils/async.ts
 * is a good place to look.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.debounce = void 0;
/**
 * Debounce a function call by a given amount of time. Only the last call
 * runs; a call superseded by a later one resolves with `undefined` at once
 * (GoodVibes patch: upstream left it pending forever, so every superseded
 * caller leaked its awaiting closure).
 * Inspired by https://gist.github.com/ca0v/73a31f57b397606c9813472f7493a940
 */
const debounce = (func, waitForMs) => {
    let timeout = null;
    let pendingResolve = null;
    return (...args) => new Promise((resolve) => {
        if (timeout) {
            clearTimeout(timeout);
        }
        if (pendingResolve) {
            pendingResolve(undefined);
        }
        pendingResolve = resolve;
        timeout = setTimeout(() => {
            timeout = null;
            pendingResolve = null;
            resolve(func(...args));
        }, waitForMs);
    });
};
exports.debounce = debounce;

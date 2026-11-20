/**
 * The one ANSI sanitiser lives in the contracts package (contracts/src/ansi-sanitize.ts)
 * so the web UI and both terminal apps strip untrusted text the same way.
 */
export { safeTerminalLink, stripDangerousAnsi } from '@goodvibes-jev/engine/contracts';

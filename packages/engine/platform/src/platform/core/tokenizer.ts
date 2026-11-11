import { logger } from '../utils/logger.js';

export type InputToken =
  | { type: 'text', value: string }
  | { type: 'key', name: string, logicalName: string, ctrl: boolean, shift: boolean, meta: boolean }
  | { type: 'mouse', button: number, col: number, row: number, action: 'press' | 'release' }
  | { type: 'focus', action: 'in' | 'out' };

function isPrintableCodePoint(code: number): boolean {
  return Number.isInteger(code) && code >= 32 && code <= 0x10ffff
    && !(code >= 0x7f && code <= 0x9f)
    && !(code >= 0xd800 && code <= 0xdfff)
    // Kitty reserves this private-use range for functional keys.
    && !(code >= 57344 && code <= 63743);
}

/**
 * InputTokenizer - Optimized for Tmux and CSI-u input modes.
 */
export class InputTokenizer {
  private buffer = '';
  private isPasting = false;
  private pasteContent = '';

  public feed(data: string): InputToken[] {
    this.buffer += data;
    const tokens: InputToken[] = [];

    if (this.buffer.length > 1024 * 100) { // Increased safety for large pastes
      this.buffer = '';
      return [];
    }

    while (this.buffer.length > 0) {
      // 1. Bracketed Paste Handling
      if (this.buffer.startsWith('\x1b[200~')) {
        this.isPasting = true;
        this.pasteContent = '';
        this.buffer = this.buffer.slice(6);
        continue;
      }

      if (this.isPasting) {
        const endIdx = this.buffer.indexOf('\x1b[201~');
        if (endIdx !== -1) {
          this.pasteContent += this.buffer.slice(0, endIdx);
          tokens.push({ type: 'text', value: this.pasteContent });
          this.isPasting = false;
          this.pasteContent = '';
          this.buffer = this.buffer.slice(endIdx + 6);
          continue;
        } else {
          // Still pasting, wait for more data
          this.pasteContent += this.buffer;
          this.buffer = '';
          break;
        }
      }

      // 2. Escape Sequences
      if (this.buffer.startsWith('\x1b')) {
        if (this.buffer.startsWith('\x1b[I')) { tokens.push({ type: 'focus', action: 'in' }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1b[O')) { tokens.push({ type: 'focus', action: 'out' }); this.buffer = this.buffer.slice(3); continue; }

        // SS3 function keys: \x1bOP (F1), \x1bOQ (F2), \x1bOR (F3), \x1bOS (F4)
        if (this.buffer.startsWith('\x1bOP')) { tokens.push({ type: 'key', name: '\x1bOP', logicalName: 'f1', ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1bOQ')) { tokens.push({ type: 'key', name: '\x1bOQ', logicalName: 'f2', ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1bOR')) { tokens.push({ type: 'key', name: '\x1bOR', logicalName: 'f3', ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1bOS')) { tokens.push({ type: 'key', name: '\x1bOS', logicalName: 'f4', ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        // SS3 cursor keys: \x1bOA (up), \x1bOB (down), \x1bOC (right), \x1bOD (left)
        // Sent by terminals in application cursor mode (e.g. tmux, some VTE terminals)
        if (this.buffer.startsWith('\x1bOA')) { tokens.push({ type: 'key', name: '\x1bOA', logicalName: 'up',    ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1bOB')) { tokens.push({ type: 'key', name: '\x1bOB', logicalName: 'down',  ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1bOC')) { tokens.push({ type: 'key', name: '\x1bOC', logicalName: 'right', ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1bOD')) { tokens.push({ type: 'key', name: '\x1bOD', logicalName: 'left',  ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        // SS3 home/end: \x1bOH (home), \x1bOF (end)
        if (this.buffer.startsWith('\x1bOH')) { tokens.push({ type: 'key', name: '\x1bOH', logicalName: 'home', ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }
        if (this.buffer.startsWith('\x1bOF')) { tokens.push({ type: 'key', name: '\x1bOF', logicalName: 'end',  ctrl: false, shift: false, meta: false }); this.buffer = this.buffer.slice(3); continue; }

        const mouseMatch = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.buffer);
        if (mouseMatch) {
          tokens.push({
            type: 'mouse', button: parseInt(mouseMatch[1]!, 10),
            col: parseInt(mouseMatch[2]!, 10) - 1, row: parseInt(mouseMatch[3]!, 10) - 1,
            action: mouseMatch[4]! === 'M' ? 'press' : 'release'
          });
          this.buffer = this.buffer.slice(mouseMatch[0].length);
          continue;
        }

        const seqMatch = /^\x1b\[([0-9;?<>:]*)([a-zA-Z~])/.exec(this.buffer);
        if (seqMatch) {
          const full = seqMatch[0]!;
          const params = seqMatch[1]!;
          const suffix = seqMatch[2]!;
          // Kitty fields use semicolons; colons introduce alternate key codes
          // or event types within a field, never another modifier field.
          const parts = params.split(';');
          const keyCodes = parts[0]!.split(':');
          const modifiers = (parts[1] || '1').split(':');
          let charCode = parseInt(keyCodes[0]! || '0', 10);
          const modValue = parseInt(modifiers[0]! || '1', 10);
          const modifyOtherKeys = params.startsWith('27;') && suffix === '~';
          if (modifyOtherKeys) {
            charCode = parseInt(parts[2]! || '0', 10);
          }
          // A release is not another insertion or shortcut activation. Repeat
          // events, in contrast, follow the same path as a key press.
          if (!modifyOtherKeys && modifiers[1] === '3') {
            this.buffer = this.buffer.slice(full.length);
            continue;
          }
          const shift = (modValue - 1 & 1) !== 0;
          const meta  = (modValue - 1 & 2) !== 0;
          const ctrl  = (modValue - 1 & 4) !== 0;
          // Normalize encoded printable input to the same text tokens as plain
          // UTF-8, before any composer, modal or shortcut consumer sees it.
          // Shift and lock keys can produce text; Ctrl/Alt/Super/Hyper/Meta
          // chords must remain keys. Do not infer text from navigation codes.
          if ((suffix === 'u' || modifyOtherKeys) && ((modValue - 1) & 0b111110) === 0) {
            let text: string | undefined;
            const associatedText = suffix === 'u' ? parts[2] : undefined;
            if (associatedText) {
              const codePoints = associatedText.split(':').map(Number);
              if (codePoints.every(isPrintableCodePoint)) text = String.fromCodePoint(...codePoints);
            } else if (isPrintableCodePoint(charCode)) {
              text = String.fromCodePoint(charCode);
              if (suffix === 'u') {
                const shiftedCode = Number(keyCodes[1]);
                const capsLock = ((modValue - 1) & 64) !== 0;
                // Prefer the terminal's layout-aware shifted character. With
                // no alternate code, letter case is recoverable from modifiers.
                if (shift && isPrintableCodePoint(shiftedCode)) text = String.fromCodePoint(shiftedCode);
                else if (shift !== capsLock) text = text.toUpperCase();
              }
            }
            if (text !== undefined) {
              tokens.push({ type: 'text', value: text });
              this.buffer = this.buffer.slice(full.length);
              continue;
            }
          }
          let logicalName = full;
          if (charCode === 13 || charCode === 10) logicalName = 'enter';
          if (charCode === 99 || charCode === 67 || charCode === 3) logicalName = 'c';
          if (suffix === 'A') logicalName = 'up';
          if (suffix === 'B') logicalName = 'down';
          if (suffix === 'C') logicalName = 'right';
          if (suffix === 'D') logicalName = 'left';
          if (suffix === 'H') logicalName = 'home';
          if (suffix === 'F') logicalName = 'end';
          if (suffix === '~' && charCode === 5) logicalName = 'pageup';
          if (suffix === '~' && charCode === 6) logicalName = 'pagedown';
          if (suffix === '~' && charCode === 3) logicalName = 'delete';
          if (suffix === '~' && charCode === 2) logicalName = 'insert';
          if (suffix === '~' && charCode === 11) logicalName = 'f1';
          if (suffix === '~' && charCode === 12) logicalName = 'f2';
          if (suffix === '~' && charCode === 13) logicalName = 'f3';
          if (suffix === '~' && charCode === 14) logicalName = 'f4';
          if (suffix === '~' && charCode === 15) logicalName = 'f5';
          if (suffix === '~' && charCode === 17) logicalName = 'f6';
          if (suffix === '~' && charCode === 18) logicalName = 'f7';
          if (suffix === '~' && charCode === 19) logicalName = 'f8';
          if (suffix === '~' && charCode === 20) logicalName = 'f9';
          if (suffix === '~' && charCode === 21) logicalName = 'f10';
          if (suffix === '~' && charCode === 23) logicalName = 'f11';
          if (suffix === '~' && charCode === 24) logicalName = 'f12';
          if (charCode === 9) logicalName = 'tab';
          if (charCode === 27) logicalName = 'escape';
          if (charCode === 32) logicalName = 'space';
          if (charCode === 127) logicalName = 'backspace';
          // Kitty keyboard protocol functional key codes (Unicode private use area)
          // These are sent as \x1b[<keycode>;modifier u by Ghostty and other kitty-protocol terminals
          if (suffix === 'u') {
            if (charCode === 57350) logicalName = 'left';
            else if (charCode === 57351) logicalName = 'right';
            else if (charCode === 57352) logicalName = 'up';
            else if (charCode === 57353) logicalName = 'down';
            else if (charCode === 57354) logicalName = 'pageup';
            else if (charCode === 57355) logicalName = 'pagedown';
            else if (charCode === 57356) logicalName = 'home';
            else if (charCode === 57357) logicalName = 'end';
            else if (charCode === 57348) logicalName = 'insert';
            else if (charCode === 57349) logicalName = 'delete';
            else if (charCode === 57364) logicalName = 'f1';
            else if (charCode === 57365) logicalName = 'f2';
            else if (charCode === 57366) logicalName = 'f3';
            else if (charCode === 57367) logicalName = 'f4';
            else if (charCode === 57368) logicalName = 'f5';
            else if (charCode === 57369) logicalName = 'f6';
            else if (charCode === 57370) logicalName = 'f7';
            else if (charCode === 57371) logicalName = 'f8';
            else if (charCode === 57372) logicalName = 'f9';
            else if (charCode === 57373) logicalName = 'f10';
            else if (charCode === 57374) logicalName = 'f11';
            else if (charCode === 57375) logicalName = 'f12';
          }
          // CSI u / modifyOtherKeys: map printable ASCII charCodes directly.
          // Lowercase letters normalize to their lowercase names; punctuation
          // such as Ctrl+[ and Ctrl+] must preserve the literal character.
          if (logicalName === full && charCode >= 32 && charCode <= 126) {
            logicalName = String.fromCharCode(charCode);
            if (charCode >= 65 && charCode <= 90) {
              logicalName = logicalName.toLowerCase();
            }
          }
          tokens.push({ type: 'key', name: full, logicalName, ctrl, shift, meta });
          this.buffer = this.buffer.slice(full.length);
          continue;
        }

        // Bare escape key (not followed by [)
        if (this.buffer.length === 1 || !this.buffer.startsWith('\x1b[')) {
          tokens.push({ type: 'key', name: '\x1b', logicalName: 'escape', ctrl: false, shift: false, meta: false });
          this.buffer = this.buffer.slice(1);
          continue;
        }
        break;
      } else {
        const char = this.buffer[0]!;
        const code = char.charCodeAt(0);
        let logicalName = char;
        let isCtrl = false;
        let isShift = false;
        if (code === 3) { logicalName = 'c'; isCtrl = true; }
        else if (code === 13) { logicalName = 'enter'; }
        else if (code === 10) { logicalName = 'enter'; isShift = true; }
        else if (code === 127 || code === 8) { logicalName = 'backspace'; }
        else if (code === 9) { logicalName = 'tab'; }
        else if (code === 28) { logicalName = '\\'; isCtrl = true; }
        else if (code === 29) { logicalName = ']'; isCtrl = true; }
        else if (code === 30) { logicalName = '^'; isCtrl = true; }
        else if (code === 31) { logicalName = '_'; isCtrl = true; }
        else if (code < 32) {
           logicalName = String.fromCharCode(code + 96).toLowerCase();
           isCtrl = true;
        }
        if (code < 32 || code === 127) {
          tokens.push({ type: 'key', name: char, logicalName, ctrl: isCtrl, shift: isShift, meta: false });
        } else {
          tokens.push({ type: 'text', value: char });
        }
        this.buffer = this.buffer.slice(1);
      }
    }
    return tokens;
  }
}

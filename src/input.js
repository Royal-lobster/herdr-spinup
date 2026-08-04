"use strict";

// Decodes terminal input into intent. One read can carry several keypresses, or a
// mouse report glued to one, so the buffer is consumed token by token.

// SGR mouse reports: ESC [ < btn ; col ; row (M=press, m=release).
const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

const ESC_WAIT_MS = 60;

/**
 * Builds a stdin `data` listener that turns bytes into intent.
 *
 * @param {object} handlers
 * @param {(delta: number) => void} handlers.move Move the cursor by `delta` rows.
 * @param {(index?: number) => void} handlers.select Commit the given row, or the current one.
 * @param {() => void} handlers.quit Dismiss without choosing.
 * @param {(row: number, pressed: boolean) => void} handlers.hover Mouse at a screen row.
 * @param {(ch: string) => boolean} handlers.shortcut Try `ch` as a shortcut; true if it matched.
 * @returns {(buf: Buffer) => void} Listener for `process.stdin`.
 */
function createReader(handlers) {
  let pending = "";
  // Escape and the start of an arrow key are the same byte, so a lone ESC must wait.
  let escTimer = null;

  /**
   * @param {RegExpExecArray} m A matched SGR mouse report.
   */
  function mouse(m) {
    const btn = Number(m[1]);
    if (btn === 64 || btn === 65) return handlers.move(btn === 64 ? -1 : 1); // wheel
    if (btn !== 0) return; // ignore non-left buttons
    handlers.hover(Number(m[3]), m[4] === "M");
  }

  return function onData(buf) {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    pending += buf.toString();

    while (pending.length) {
      const m = MOUSE.exec(pending);
      if (m) {
        pending = pending.slice(m[0].length);
        mouse(m);
        continue;
      }

      if (/^\x1b(\[[<\d;]*)?$/.test(pending)) {
        if (pending === "\x1b") {
          escTimer = setTimeout(() => {
            pending = "";
            handlers.quit();
          }, ESC_WAIT_MS);
        }
        return;
      }

      if (pending.startsWith("\x1b[A")) {
        pending = pending.slice(3);
        handlers.move(-1);
        continue;
      }
      if (pending.startsWith("\x1b[B")) {
        pending = pending.slice(3);
        handlers.move(1);
        continue;
      }

      const ch = pending[0];
      pending = pending.slice(1);

      switch (ch) {
        case "k":
          handlers.move(-1);
          continue;
        case "j":
          handlers.move(1);
          continue;
        case "\r":
        case "\n":
        case " ":
          return handlers.select();
        case "\x1b":
        case "q":
        case "\x03": // ctrl+c
          return handlers.quit();
        default:
          if (handlers.shortcut(ch)) return;
          continue;
      }
    }
  };
}

module.exports = { createReader };

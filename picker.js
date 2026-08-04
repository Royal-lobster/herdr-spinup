#!/usr/bin/env node
"use strict";

// The clickable surface. Herdr has no command palette or button UI — a plugin
// action can only be fired by a keybinding, the CLI, a ctrl+clicked link, or an
// event hook. A popup pane is the one place we can draw our own, and popups do
// receive forwarded mouse events, so this is genuinely point-and-click.
//
// Keyboard is the primary path and works regardless of whether mouse reporting
// survives the trip through the host terminal: arrows/jk, 1-5, enter, esc.

const { spawnSync } = require("node:child_process");
const lib = require("./lib.js");

const ITEMS = [
  { id: "all", label: "all four", desc: "" },
  ...lib.TOOLS.map((t) => ({ id: t, label: t, desc: lib.TOOL_DESC[t] })),
];

// A popup that dies takes its own error message with it — the pane closes
// instantly and there is no plugin log for pane commands, only for actions. So
// crashes go to a file as well as to the screen.
function logCrash(err) {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp";
  try {
    require("node:fs").appendFileSync(`${dir}/picker-error.log`, `${err && err.stack ? err.stack : err}\n`);
  } catch {
    // nothing left to try
  }
}

// A popup appears in neither `pane list` nor `api snapshot`, and its id isn't in
// the open response either — so the only way to make a wedged popup closable
// with `herdr plugin pane close` is for the popup to record its own id.
const ID_FILE = `${process.env.HERDR_PLUGIN_STATE_DIR || "/tmp"}/picker-pane-id`;

function writeIdFile() {
  try {
    if (process.env.HERDR_PANE_ID) {
      require("node:fs").writeFileSync(ID_FILE, `${process.env.HERDR_PANE_ID}\n`);
    }
  } catch {
    // not worth failing the picker over
  }
}

function clearIdFile() {
  try {
    require("node:fs").unlinkSync(ID_FILE);
  } catch {
    // already gone
  }
}

let CTX;
let running = new Set();

let selected = 0;

const ESC = "\x1b";
const out = (s) => process.stdout.write(s);

// Frame geometry. Items start at screen row FIRST_ROW (1-based), one per row,
// which is what lets a mouse click map back to an item.
const FIRST_ROW = 3;
const width = () => Math.max(28, Math.min(process.stdout.columns || 46, 60));

function render() {
  const w = width();
  const inner = w - 2;
  const title = " Spinup ";
  const bar = "─".repeat(Math.max(0, inner - title.length - 1));

  const lines = [];
  lines.push(`┌─${title}${bar}┐`);
  lines.push(`│${" ".repeat(inner)}│`);

  ITEMS.forEach((item, i) => {
    const on = i === selected;
    const live = item.id !== "all" && running.has(item.id);
    const mark = live ? "✓" : " ";
    const left = `${on ? "❯" : " "} ${i + 1}  ${mark} ${item.label}`;
    const right = item.desc ? `${item.desc}  ` : "  ";
    const pad = Math.max(1, inner - left.length - right.length);
    let row = `${left}${" ".repeat(pad)}${right}`;
    if (row.length > inner) row = row.slice(0, inner);
    else row = row + " ".repeat(inner - row.length);
    // Reverse video for the cursor line, dim for already-running tools.
    const style = on ? "\x1b[7m" : live ? "\x1b[2m" : "";
    lines.push(`│${style}${row}\x1b[0m│`);
  });

  lines.push(`│${" ".repeat(inner)}│`);
  const hint = "  click · ↑↓ · 1-5 · esc";
  lines.push(`│\x1b[2m${hint.padEnd(inner).slice(0, inner)}\x1b[0m│`);
  lines.push(`└${"─".repeat(inner)}┘`);

  // Repaint in place rather than clearing the whole screen, so the popup
  // doesn't flicker on every keystroke.
  out(`${ESC}[H`);
  out(lines.join(`${ESC}[K\r\n`) + `${ESC}[K`);
}

function restore() {
  out(`${ESC}[?1000l${ESC}[?1006l`); // mouse off
  out(`${ESC}[?25h`); // cursor on
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // already gone
    }
  }
}

function choose(index) {
  const item = ITEMS[index];
  if (!item) return;
  const wanted = item.id === "all" ? lib.TOOLS : [item.id];

  restore();
  out(`${ESC}[2J${ESC}[H`);
  out(`starting ${wanted.join(", ")}…\r\n`);

  // Re-exec through the action script so there is exactly one code path that
  // launches tools, and the context is passed explicitly rather than re-derived
  // from the (now focused) popup.
  const r = spawnSync(process.execPath, [`${__dirname}/spinup.js`, item.id], {
    encoding: "utf8",
    env: {
      ...process.env,
      HERDR_PLUGIN_ACTION_ID: item.id,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_cwd: CTX.cwd,
        workspace_id: CTX.workspaceId,
      }),
    },
  });

  // Only surface something if it went wrong; on success the popup just closes.
  if ((r.status ?? 1) !== 0) {
    out(`${(r.stderr || r.stdout || "failed").trim()}\r\n`);
    out("press any key…");
    waitKeyThenExit();
    return;
  }
  process.exit(0);
}

function waitKeyThenExit() {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      // fall through
    }
  }
  process.stdin.resume();
  process.stdin.once("data", () => {
    restore();
    process.exit(1);
  });
}

function quit() {
  restore();
  out(`${ESC}[2J${ESC}[H`);
  process.exit(0);
}

// SGR mouse reports: ESC [ < btn ; col ; row (M=press, m=release).
function handleMouse(seq) {
  const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(seq);
  if (!m) return false;
  const btn = Number(m[1]);
  const row = Number(m[3]);
  const kind = m[4];

  if (btn === 64 || btn === 65) {
    // wheel up / down
    move(btn === 64 ? -1 : 1);
    return true;
  }
  if (btn !== 0) return true; // ignore non-left buttons

  const index = row - FIRST_ROW;
  if (index < 0 || index >= ITEMS.length) return true;

  if (kind === "M") {
    // Highlight on press so the click feels responsive.
    selected = index;
    render();
  } else {
    choose(index);
  }
  return true;
}

function move(delta) {
  selected = (selected + delta + ITEMS.length) % ITEMS.length;
  render();
}

// A single read can carry several keypresses, or a mouse report glued to one —
// so consume the buffer token by token instead of matching it as a whole.
let pending = "";

function onData(buf) {
  pending += buf.toString();

  while (pending.length) {
    const before = pending;

    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(pending);
    if (mouse) {
      pending = pending.slice(mouse[0].length);
      if (handleMouse(mouse[0])) continue;
      continue;
    }

    // An incomplete escape sequence: wait for the rest rather than treating the
    // lone ESC as "quit".
    if (/^\x1b(\[[<\d;]*)?$/.test(pending)) return;

    if (pending.startsWith("\x1b[A")) {
      pending = pending.slice(3);
      move(-1);
      continue;
    }
    if (pending.startsWith("\x1b[B")) {
      pending = pending.slice(3);
      move(1);
      continue;
    }

    const ch = pending[0];
    pending = pending.slice(1);

    if (/^[1-9]$/.test(ch)) {
      const i = Number(ch) - 1;
      if (i < ITEMS.length) {
        selected = i;
        render();
        return choose(i);
      }
      continue;
    }

    switch (ch) {
      case "k":
        move(-1);
        continue;
      case "j":
        move(1);
        continue;
      case "\r":
      case "\n":
      case " ":
        return choose(selected);
      case "\x1b":
      case "q":
      case "\x03": // ctrl+c
        return quit();
      default:
        if (pending === before) pending = pending.slice(1);
        continue;
    }
  }
}

function main() {
  // Where the popup was opened from — captured before drawing, because once the
  // popup is up it is itself the focused pane.
  CTX = lib.resolveContext();
  try {
    running = lib.runningTools(CTX);
  } catch {
    // decoration only; an empty set just means nothing gets a checkmark
  }

  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      // keyboard will be line-buffered; still usable
    }
  }
  process.stdin.resume();
  process.stdin.on("data", onData);

  writeIdFile();

  out(`${ESC}[?25l`); // cursor off
  out(`${ESC}[?1000h${ESC}[?1006h`); // mouse on, SGR encoding
  out(`${ESC}[2J`);
  render();

  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", () => {
    restore();
    clearIdFile();
  });
}

try {
  main();
} catch (err) {
  logCrash(err);
  restore();
  out(`${ESC}[2J${ESC}[H`);
  out(`spinup picker failed:\r\n${(err && err.message) || err}\r\n\r\npress any key…`);
  waitKeyThenExit();
}

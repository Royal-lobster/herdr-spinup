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

// One row per tool, straight from tools.toml. Starting everything at once stays
// on its own action rather than taking up a row here.
const ITEMS = lib.loadTools();

// Shortcut character per row: the tool's own `key` if it set one, else the row
// number (so the first nine rows stay reachable without configuring anything).
function shortcutFor(item, i) {
  return item.key || (i < 9 ? String(i + 1) : "");
}

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

// `esc` is how you dismiss the picker. This file is only a fallback for a popup
// that stops responding, since a popup's pane id appears in neither `pane list`,
// `api snapshot`, nor the open response. Written unconditionally: popups seem not
// to get HERDR_PANE_ID, so an empty file is itself the useful signal that
// `herdr plugin pane close` has nothing to target.
const ID_FILE = `${process.env.HERDR_PLUGIN_STATE_DIR || "/tmp"}/picker-state.json`;

function writeIdFile() {
  try {
    require("node:fs").writeFileSync(
      ID_FILE,
      JSON.stringify({
        pane_id: process.env.HERDR_PANE_ID || "",
        trigger_tab: process.env.SPINUP_TRIGGER_TAB || "",
        cwd: (CTX && CTX.cwd) || "",
      }) + "\n",
    );
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

// No border or title of our own — herdr already frames and titles a plugin pane.
const LOGO = [
  "███████╗██████╗ ██╗███╗   ██╗██╗   ██╗██████╗ ",
  "██╔════╝██╔══██╗██║████╗  ██║██║   ██║██╔══██╗",
  "███████╗██████╔╝██║██╔██╗ ██║██║   ██║██████╔╝",
  "╚════██║██╔═══╝ ██║██║╚██╗██║██║   ██║██╔═══╝ ",
  "███████║██║     ██║██║ ╚████║╚██████╔╝██║     ",
  "╚══════╝╚═╝     ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝     ",
];
const LOGO_W = Math.max(...LOGO.map((l) => [...l].length));
const MENU_W = 40;

// Set by render(), read by the mouse handler: where the item rows actually
// landed on screen. Centring makes this move with the pane size, so it can't be
// a constant.
let itemTopRow = 1;
let itemLeftCol = 1;

function shortCwd() {
  const home = process.env.HOME || "";
  const cwd = (CTX && CTX.cwd) || "";
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

// Builds the screen as {text, style} rows with *plain* text, so widths can be
// measured for centring — ANSI codes are applied only at paint time.
function compose(cols, rows) {
  const block = [];
  const w = Math.max(MENU_W, Math.min(LOGO_W, cols - 2));

  // Drop the logo rather than overflow a short or narrow pane.
  if (rows >= LOGO.length + ITEMS.length + 8 && cols >= LOGO_W + 2) {
    for (const l of LOGO) block.push({ text: l, style: "\x1b[38;5;180m" });
    block.push({ text: "" });
  }

  const cwd = shortCwd();
  if (cwd) {
    const t = cwd.length > w ? `…${cwd.slice(-(w - 1))}` : cwd;
    block.push({ text: t, style: "\x1b[2m" });
    block.push({ text: "" });
  }

  const itemStart = block.length;

  ITEMS.forEach((item, i) => {
    const on = i === selected;
    const live = running.has(item.id);
    const left = `${on ? "❯" : " "} ${shortcutFor(item, i) || " "}  ${live ? "✓" : " "} ${item.label}`;
    const right = item.desc || "";
    const pad = Math.max(1, w - [...left].length - [...right].length - 1);
    const text = ` ${left}${" ".repeat(pad)}${right}`;
    block.push({
      text: text.length > w ? text.slice(0, w) : text.padEnd(w),
      style: on ? "\x1b[7m" : live ? "\x1b[2m" : "",
    });
  });

  block.push({ text: "" });
  const keys = ITEMS.map(shortcutFor).filter(Boolean).join("");
  block.push({ text: `  click · ↑↓${keys ? ` · ${keys}` : ""} · esc`, style: "\x1b[2m" });

  return { block, itemStart, w };
}

function render() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const { block, itemStart, w } = compose(cols, rows);

  const top = Math.max(0, Math.floor((rows - block.length) / 2));
  const left = Math.max(0, Math.floor((cols - w) / 2));
  const indent = " ".repeat(left);

  itemTopRow = top + itemStart + 1; // 1-based screen row of the first item
  itemLeftCol = left + 1;

  // Repaint from home and erase to end of screen, rather than clearing first —
  // clearing makes the whole screen flash on every keystroke.
  let buf = `${ESC}[H`;
  for (let i = 0; i < top; i++) buf += `${ESC}[K\r\n`;
  for (const row of block) {
    buf += `${indent}${row.style || ""}${row.text}\x1b[0m${ESC}[K\r\n`;
  }
  buf += `${ESC}[J`;
  out(buf);
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
  const wanted = [item.id];

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

  // Launched from a brand-new empty tab (the tab.created hook): the tools opened
  // in tabs of their own, so that one is now a leftover. Only reached on a real
  // pick — quitting with esc never gets here.
  const trigger = process.env.SPINUP_TRIGGER_TAB;
  if (trigger) {
    try {
      lib.herdr(["tab", "close", trigger]);
    } catch {
      // an extra empty tab is not worth surfacing
    }
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

  // itemTopRow moves with the pane size, since the block is centred.
  const index = row - itemTopRow;
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

    const hit = ITEMS.findIndex((item, i) => shortcutFor(item, i) === ch);
    if (hit >= 0) {
      selected = hit;
      render();
      return choose(hit);
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

  // Re-centre when the pane is resized.
  process.stdout.on("resize", render);

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

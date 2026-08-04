#!/usr/bin/env node
"use strict";

// Prints the chosen command to stdout; the shell wrapper execs it. Because stdout
// carries the result, the UI is drawn to /dev/tty instead.

const fs = require("node:fs");
const lib = require("./lib.js");

const ITEMS = lib.loadTools();

let ttyFd = null;
try {
  ttyFd = fs.openSync("/dev/tty", "w");
} catch {
  ttyFd = null;
}
const out = (s) => {
  try {
    if (ttyFd !== null) fs.writeSync(ttyFd, s);
  } catch {
    // terminal went away; nothing to do
  }
};

// stdout is a pipe here, so it has no size; the wrapper passes the real one.
const cols = () => Number(process.env.COLUMNS) || process.stdout.columns || 80;
const rows = () => Number(process.env.LINES) || process.stdout.rows || 24;

const ESC = "\x1b";
let selected = 0;

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

// Where the item rows landed; moves with the pane size, so a click needs it.
let itemTopRow = 1;

function shortcutFor(item, i) {
  return item.key || (i < 9 ? String(i + 1) : "");
}

function shortCwd() {
  const home = process.env.HOME || "";
  const cwd = process.cwd();
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function compose(c, r) {
  const block = [];
  const w = Math.max(MENU_W, Math.min(LOGO_W, c - 2));

  if (r >= LOGO.length + ITEMS.length + 8 && c >= LOGO_W + 2) {
    // ANSI 0-15 / reverse / dim only: a 256-colour literal would ignore the theme.
    for (const l of LOGO) block.push({ text: l, style: "\x1b[33m" });
    block.push({ text: "" });
  }

  const cwd = shortCwd();
  if (cwd) {
    block.push({ text: cwd.length > w ? `…${cwd.slice(-(w - 1))}` : cwd, style: "\x1b[2m" });
    block.push({ text: "" });
  }

  const itemStart = block.length;

  ITEMS.forEach((item, i) => {
    const on = i === selected;
    const left = `${on ? "❯" : " "} ${shortcutFor(item, i) || " "}  ${item.label}`;
    const right = item.desc || "";
    const pad = Math.max(1, w - [...left].length - [...right].length - 1);
    const text = ` ${left}${" ".repeat(pad)}${right}`;
    block.push({ text: text.length > w ? text.slice(0, w) : text.padEnd(w), style: on ? "\x1b[7m" : "" });
  });

  block.push({ text: "" });
  const keys = ITEMS.map(shortcutFor).filter(Boolean).join("");
  block.push({ text: `  click · ↑↓${keys ? ` · ${keys}` : ""} · esc`, style: "\x1b[2m" });

  return { block, itemStart, w };
}

function render() {
  const c = cols();
  const r = rows();
  const { block, itemStart, w } = compose(c, r);

  const top = Math.max(0, Math.floor((r - block.length) / 2));
  const indent = " ".repeat(Math.max(0, Math.floor((c - w) / 2)));
  itemTopRow = top + itemStart + 1;

  let buf = `${ESC}[H`;
  for (let i = 0; i < top; i++) buf += `${ESC}[K\r\n`;
  for (const row of block) buf += `${indent}${row.style || ""}${row.text}\x1b[0m${ESC}[K\r\n`;
  out(buf + `${ESC}[J`);
}

function restore() {
  out(`${ESC}[?1000l${ESC}[?1006l${ESC}[?25h`);
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // already gone
    }
  }
}

// Empty stdout means the wrapper runs nothing and the prompt comes back.
function finish(command) {
  restore();
  out(`${ESC}[2J${ESC}[H`);
  if (command) process.stdout.write(command);
  process.exit(0);
}

const quit = () => finish("");
const choose = (index) => ITEMS[index] && finish(ITEMS[index].command);

function move(delta) {
  selected = (selected + delta + ITEMS.length) % ITEMS.length;
  render();
}

// SGR mouse reports: ESC [ < btn ; col ; row (M=press, m=release).
const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

function handleMouse(m) {
  const btn = Number(m[1]);

  if (btn === 64 || btn === 65) return move(btn === 64 ? -1 : 1); // wheel
  if (btn !== 0) return; // ignore non-left buttons

  const index = Number(m[3]) - itemTopRow;
  if (index < 0 || index >= ITEMS.length) return;

  if (m[4] === "M") {
    selected = index; // highlight on press so the click feels responsive
    render();
  } else {
    choose(index);
  }
}

// One read can carry several keypresses, so consume the buffer token by token.
let pending = "";

// Escape and the start of an arrow key are the same byte, so a lone ESC must wait.
let escTimer = null;

function onData(buf) {
  if (escTimer) {
    clearTimeout(escTimer);
    escTimer = null;
  }
  pending += buf.toString();

  while (pending.length) {
    const mouse = MOUSE.exec(pending);
    if (mouse) {
      pending = pending.slice(mouse[0].length);
      handleMouse(mouse);
      continue;
    }

    if (/^\x1b(\[[<\d;]*)?$/.test(pending)) {
      if (pending === "\x1b") {
        escTimer = setTimeout(() => {
          pending = "";
          quit();
        }, 60);
      }
      return;
    }

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
        continue;
    }
  }
}

function main() {
  if (!ITEMS.length) process.exit(0);

  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      // keyboard will be line-buffered; still usable
    }
  }
  process.stdin.resume();
  process.stdin.on("data", onData);

  out(`${ESC}[?25l${ESC}[?1000h${ESC}[?1006h${ESC}[2J`);
  render();

  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", restore);
}

try {
  main();
} catch (err) {
  restore();
  out(`spinup: ${(err && err.message) || err}\r\n`);
  process.exit(0); // never leave the shell without its prompt
}

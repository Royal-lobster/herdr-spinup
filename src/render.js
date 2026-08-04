"use strict";

// Draws the centred menu. Colours are ANSI 0-15 / reverse / dim only: a 256-colour
// literal would ignore the herdr theme, and herdr exposes no way to read its palette.

const fs = require("node:fs");

const ESC = "\x1b";
const MENU_W = 40;

// Dim is switched off with `22m` (normal intensity) rather than `0m`, so it can be
// nested inside a row that is already in reverse video without clearing it.
const DIM = `${ESC}[2m`;
const DIM_OFF = `${ESC}[22m`;

// The UI must not touch stdout — that carries the chosen command back to the shell.
let ttyFd = null;
try {
  ttyFd = fs.openSync("/dev/tty", "w");
} catch {
  ttyFd = null;
}

/**
 * Writes to the terminal, bypassing stdout.
 *
 * @param s Text, usually including ANSI escapes.
 */
function out(s) {
  try {
    if (ttyFd !== null) fs.writeSync(ttyFd, s);
  } catch {
    // terminal went away
  }
}

// stdout is a pipe here, so it has no size; the wrapper passes the real one.
const cols = () => Number(process.env.COLUMNS) || process.stdout.columns || 80;
const rows = () => Number(process.env.LINES) || process.stdout.rows || 24;

/**
 * @returns The working directory, with `$HOME` shortened to `~`.
 */
function shortCwd() {
  const home = process.env.HOME || "";
  const cwd = process.cwd();
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * The character that selects a row.
 *
 * @param item A tool.
 * @param i Its index.
 * @returns The tool's own `key`, else the row number, else `""` past nine rows.
 */
function shortcutFor(item, i) {
  return item.key || (i < 9 ? String(i + 1) : "");
}

/**
 * Lays the screen out as rows of plain text, so widths can be measured for centring;
 * ANSI is applied later, at paint time.
 *
 * @param state
 * @param c Terminal columns.
 * @param r Terminal rows.
 * @returns `itemStart` is the index of the first tool row within `block`; `w` the block width.
 *   A row's `text` is the plain form used for measuring; `styled`, when present, is the
 *   same row with inline attributes and is what gets painted.
 */
function compose({ items, logo, selected }, c, r) {
  const logoW = logo.length ? Math.max(...logo.map((l) => [...l].length)) : 0;
  const w = Math.max(MENU_W, Math.min(logoW, c - 2));
  const block = [];

  if (logo.length && r >= logo.length + items.length + 8 && c >= logoW + 2) {
    for (const l of logo) block.push({ text: l, style: "\x1b[33m" });
    block.push({ text: "" });
  }

  const cwd = shortCwd();
  if (cwd) {
    block.push({ text: cwd.length > w ? `…${cwd.slice(-(w - 1))}` : cwd, style: "\x1b[2m" });
    block.push({ text: "" });
  }

  const itemStart = block.length;

  items.forEach((item, i) => {
    const on = i === selected;
    const left = `${on ? "❯" : " "} ${shortcutFor(item, i) || " "}  ${item.label}`;
    const right = item.desc || "";
    const pad = Math.max(1, w - [...left].length - [...right].length - 1);
    // Split by code point, not UTF-16 unit, so a wide glyph in a label cannot
    // shift the description out of the block.
    const head = [...` ${left}${" ".repeat(pad)}`].slice(0, w);
    const desc = [...right].slice(0, Math.max(0, w - head.length));
    const tail = " ".repeat(Math.max(0, w - head.length - desc.length));
    const plain = `${head.join("")}${desc.join("")}${tail}`;
    block.push({
      text: plain,
      // The description is dimmed on its own so the label stays the brighter half
      // of the row. Padding sits outside the dim span, which keeps the reverse
      // video on a selected row an even block.
      styled: desc.length ? `${head.join("")}${DIM}${desc.join("")}${DIM_OFF}${tail}` : plain,
      style: on ? "\x1b[7m" : "",
    });
  });

  block.push({ text: "" });
  const keys = items.map(shortcutFor).filter(Boolean).join("");
  block.push({ text: `  click · ↑↓${keys ? ` · ${keys}` : ""} · esc`, style: "\x1b[2m" });

  return { block, itemStart, w };
}

/**
 * Draws the menu, centred in the pane.
 *
 * @param state
 * @returns The screen row of the first tool row, which a click maps back to. It moves
 *   with the pane size, so callers must not cache it.
 */
function paint(state) {
  const c = cols();
  const r = rows();
  const { block, itemStart, w } = compose(state, c, r);

  const top = Math.max(0, Math.floor((r - block.length) / 2));
  const indent = " ".repeat(Math.max(0, Math.floor((c - w) / 2)));

  let buf = `${ESC}[H`;
  for (let i = 0; i < top; i++) buf += `${ESC}[K\r\n`;
  for (const row of block) buf += `${indent}${row.style || ""}${row.styled || row.text}\x1b[0m${ESC}[K\r\n`;
  out(buf + `${ESC}[J`);

  return top + itemStart + 1;
}

/**
 * Hides the cursor and enables SGR mouse reporting.
 */
function enter() {
  out(`${ESC}[?25l${ESC}[?1000h${ESC}[?1006h${ESC}[2J`);
}

/**
 * Undoes {@link enter}. Safe to call more than once.
 */
function leave() {
  out(`${ESC}[?1000l${ESC}[?1006l${ESC}[?25h`);
}

/**
 * Clears the pane and homes the cursor.
 */
function clear() {
  out(`${ESC}[2J${ESC}[H`);
}

module.exports = { paint, enter, leave, clear, out, shortcutFor };

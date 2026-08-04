"use strict";

// Draws the centred menu. Colours are ANSI 0-15 / reverse / dim only: a 256-colour
// literal would ignore the herdr theme, and herdr exposes no way to read its palette.

const fs = require("node:fs");

const ESC = "\x1b";
const MENU_W = 40;

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
 * @param {string} s Text, usually including ANSI escapes.
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
 * @returns {string} The working directory, with `$HOME` shortened to `~`.
 */
function shortCwd() {
  const home = process.env.HOME || "";
  const cwd = process.cwd();
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * The character that selects a row.
 *
 * @param {object} item A tool.
 * @param {number} i Its index.
 * @returns {string} The tool's own `key`, else the row number, else `""` past nine rows.
 */
function shortcutFor(item, i) {
  return item.key || (i < 9 ? String(i + 1) : "");
}

/**
 * Lays the screen out as rows of plain text, so widths can be measured for centring;
 * ANSI is applied later, at paint time.
 *
 * @param {{items: object[], logo: string[], selected: number}} state
 * @param {number} c Terminal columns.
 * @param {number} r Terminal rows.
 * @returns {{block: {text: string, style?: string}[], itemStart: number, w: number}}
 *   `itemStart` is the index of the first tool row within `block`; `w` the block width.
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
    const text = ` ${left}${" ".repeat(pad)}${right}`;
    block.push({ text: text.length > w ? text.slice(0, w) : text.padEnd(w), style: on ? "\x1b[7m" : "" });
  });

  block.push({ text: "" });
  const keys = items.map(shortcutFor).filter(Boolean).join("");
  block.push({ text: `  click · ↑↓${keys ? ` · ${keys}` : ""} · esc`, style: "\x1b[2m" });

  return { block, itemStart, w };
}

// Screen row of the first item, so a click maps back to one. Moves with the pane.
let itemTopRow = 1;

/**
 * Draws the menu, centred in the pane.
 *
 * @param {{items: object[], logo: string[], selected: number}} state
 */
function paint(state) {
  const c = cols();
  const r = rows();
  const { block, itemStart, w } = compose(state, c, r);

  const top = Math.max(0, Math.floor((r - block.length) / 2));
  const indent = " ".repeat(Math.max(0, Math.floor((c - w) / 2)));
  itemTopRow = top + itemStart + 1;

  let buf = `${ESC}[H`;
  for (let i = 0; i < top; i++) buf += `${ESC}[K\r\n`;
  for (const row of block) buf += `${indent}${row.style || ""}${row.text}\x1b[0m${ESC}[K\r\n`;
  out(buf + `${ESC}[J`);
}

const firstItemRow = () => itemTopRow;

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

module.exports = { paint, firstItemRow, enter, leave, clear, out, shortcutFor };

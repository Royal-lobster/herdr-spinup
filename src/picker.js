#!/usr/bin/env node
"use strict";

// Prints the chosen command to stdout; the shell wrapper execs it, so the tool
// replaces this process in the same pane. Empty stdout means the wrapper runs
// nothing and the prompt comes back.

const { loadTools, loadLogo } = require("./config.js");
const { createReader } = require("./input.js");
const render = require("./render.js");

const items = loadTools();
const logo = loadLogo();
let selected = 0;
let itemTopRow = 1;

/**
 * Redraws the menu from current state.
 */
function repaint() {
  itemTopRow = render.paint({ items, logo, selected });
}

/**
 * Restores the terminal and exits, handing the choice to the shell wrapper.
 *
 * @param command The chosen command line, or `""` to choose nothing — which
 *   leaves stdout empty, so the wrapper runs nothing and the prompt returns.
 */
function finish(command) {
  render.leave();
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // already gone
    }
  }
  render.clear();
  if (command) process.stdout.write(command);
  process.exit(0);
}

const reader = createReader({
  move(delta) {
    selected = (selected + delta + items.length) % items.length;
    repaint();
  },
  select(index = selected) {
    if (items[index]) finish(items[index].command);
  },
  quit() {
    finish("");
  },
  hover(row, pressed) {
    const index = row - itemTopRow;
    if (index < 0 || index >= items.length) return;
    if (pressed) {
      selected = index; // highlight on press so the click feels responsive
      repaint();
    } else {
      this.select(index);
    }
  },
  shortcut(ch) {
    const hit = items.findIndex((item, i) => render.shortcutFor(item, i) === ch);
    if (hit < 0) return false;
    selected = hit;
    repaint();
    this.select(hit);
    return true;
  },
});

/**
 * Puts the terminal in raw mode, draws the menu and waits for input.
 */
function main() {
  if (!items.length) process.exit(0);

  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      // keyboard will be line-buffered; still usable
    }
  }
  process.stdin.resume();
  process.stdin.on("data", reader);

  render.enter();
  repaint();

  process.on("SIGINT", () => finish(""));
  process.on("SIGTERM", () => finish(""));
  process.on("exit", render.leave);
}

try {
  main();
} catch (err) {
  render.leave();
  render.out(`spinup: ${(err && err.message) || err}\r\n`);
  process.exit(0); // never leave the shell without its prompt
}

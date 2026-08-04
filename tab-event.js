#!/usr/bin/env node
"use strict";

// tab.created hook: run the menu in the new tab's own pane.
//
// The tool then replaces the menu in that same pane, so nothing else is created
// and no existing tab is touched. `esc` chooses nothing and the shell returns to
// its prompt.
//
// This is also why the launcher works over `herdr --remote`: events are raised and
// handled entirely on the server, unlike keybindings, which a remote client can
// neither resolve nor run.

const lib = require("./lib.js");

const ROOT = process.env.HERDR_PLUGIN_ROOT || __dirname;
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp";

function sleep(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function newTabId() {
  try {
    // Shape: {event:"tab_created", data:{type, tab:{tab_id, ...}}}
    return JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}")?.data?.tab?.tab_id || "";
  } catch {
    return "";
  }
}

function rootPaneOf(tabId) {
  const panes = lib.herdr(["pane", "list"]).panes || [];
  return panes.find((p) => p.tab_id === tabId) || null;
}

function main() {
  const tabId = newTabId();
  if (!tabId) return;

  // `pane run` types into the pane's shell, so the pane has to exist and the shell
  // has to have reached its prompt, or the line is lost.
  let pane = null;
  for (let i = 0; i < 10 && !pane; i++) {
    pane = rootPaneOf(tabId);
    if (!pane) sleep(150);
  }
  if (!pane) return;
  sleep(250);

  // The menu prints the chosen command to stdout and draws itself on /dev/tty, so
  // the command substitution captures the choice without swallowing the UI.
  // `exec` replaces the shell, which keeps herdr's process-name agent detection
  // working exactly as if the tool had been launched by hand. Choosing nothing
  // leaves CMD empty and the prompt simply returns.
  //
  // COLUMNS/LINES are passed explicitly because the menu's stdout is a pipe and
  // so has no terminal size of its own.
  const script =
    `clear; CMD=$(COLUMNS=$(tput cols) LINES=$(tput lines) ` +
    `node ${JSON.stringify(`${ROOT}/picker.js`)}); ` +
    `[ -n "$CMD" ] && exec $CMD; clear`;

  lib.herdr(["pane", "run", pane.pane_id, "sh", "-c", script]);
}

try {
  main();
} catch (err) {
  // Closing a brand-new tab before the menu starts is an ordinary race, not a
  // fault: the pane is gone and there is nothing left to run.
  const raced = /pane_not_found|tab_not_found/.test((err && err.message) || "");

  // Anything else must never disrupt opening a tab, but must not vanish either:
  // event hooks report only an exit code, so unexpected failures go to a file.
  if (!raced) {
    try {
      require("node:fs").appendFileSync(
        `${STATE_DIR}/tab-event-error.log`,
        `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`,
      );
    } catch {
      // nothing left to try
    }
  }
}
process.exit(0);

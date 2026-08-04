#!/usr/bin/env node
"use strict";

// tab.created hook: runs the menu in the new tab's own pane.
//
// An event, not a keybinding, because a client driving a remote server can neither
// resolve nor run a plugin action — events are handled entirely on the server.

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

  // `pane run` types into the shell, so it must have reached its prompt first.
  let pane = null;
  for (let i = 0; i < 10 && !pane; i++) {
    pane = rootPaneOf(tabId);
    if (!pane) sleep(150);
  }
  if (!pane) return;
  sleep(250);

  // The menu draws to /dev/tty and prints only the choice, so this captures it
  // without swallowing the UI. `exec` keeps herdr's process-name agent detection
  // working. COLUMNS/LINES are explicit because the menu's stdout is a pipe.
  const script =
    `clear; CMD=$(COLUMNS=$(tput cols) LINES=$(tput lines) ` +
    `node ${JSON.stringify(`${ROOT}/picker.js`)}); ` +
    `[ -n "$CMD" ] && exec $CMD; clear`;

  lib.herdr(["pane", "run", pane.pane_id, "sh", "-c", script]);
}

try {
  main();
} catch (err) {
  // Closing a new tab before the menu starts is a race, not a fault.
  const raced = /pane_not_found|tab_not_found/.test((err && err.message) || "");

  // Event hooks report only an exit code, so real failures go to a file.
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

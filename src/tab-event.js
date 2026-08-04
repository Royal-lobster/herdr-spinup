#!/usr/bin/env node
"use strict";

// tab.created hook: runs the menu in the new tab's own pane.
//
// An event, not a keybinding, because a client driving a remote server can neither
// resolve nor run a plugin action — events are handled entirely on the server.

const { herdr } = require("./herdr.js");

const ROOT = process.env.HERDR_PLUGIN_ROOT || __dirname;
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp";

/**
 * Blocks the thread. This hook has nothing else to do while it waits.
 *
 * @param {number} ms Milliseconds.
 */
function sleep(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * @returns {string} The id of the tab that was just created, or `""` if the payload
 *   is missing or malformed.
 */
function newTabId() {
  try {
    // Shape: {event:"tab_created", data:{type, tab:{tab_id, ...}}}
    return JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}")?.data?.tab?.tab_id || "";
  } catch {
    return "";
  }
}

/**
 * @param {string} tabId
 * @returns {object|null} The tab's first pane, or null if the tab has gone.
 */
function rootPaneOf(tabId) {
  const panes = herdr(["pane", "list"]).panes || [];
  return panes.find((p) => p.tab_id === tabId) || null;
}

/**
 * Waits for the new tab's shell to reach its prompt, then runs the menu in it.
 */
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
  // HERDR_PLUGIN_CONFIG_DIR is passed through because the menu runs in the tab's own
  // shell, which is not a plugin process and so does not inherit it. Without this the
  // user's tools.json and logo.txt are never found.
  const script =
    `clear; CMD=$(COLUMNS=$(tput cols) LINES=$(tput lines) ` +
    `HERDR_PLUGIN_CONFIG_DIR=${JSON.stringify(process.env.HERDR_PLUGIN_CONFIG_DIR || "")} ` +
    `node ${JSON.stringify(`${ROOT}/src/picker.js`)}); ` +
    `[ -n "$CMD" ] && exec $CMD; clear`;

  herdr(["pane", "run", pane.pane_id, "sh", "-c", script]);
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

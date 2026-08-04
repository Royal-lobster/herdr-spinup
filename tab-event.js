#!/usr/bin/env node
"use strict";

// tab.created hook: opening a new tab offers the tool menu, so "new tab" becomes
// "new tab, running something".
//
// Two things make this less trivial than it looks:
//
//  - The tool tabs this plugin opens are new tabs too, so they re-fire this hook.
//    lib's suppression marker is what stops the recursion.
//  - Herdr's own "new tab" dialog is session-modal, and a plugin popup can't open
//    while it is up ("popup already open"). Rather than give up, wait for it.

const lib = require("./lib.js");

const RETRY_MS = 400;
const RETRY_WINDOW_MS = 8000;

function sleep(ms) {
  // Synchronous by design: this is a short-lived hook process, and there is
  // nothing else for it to do while it waits.
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function triggeringTabId() {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  // Event payloads aren't documented field-by-field; keep the last one on disk so
  // the shape is inspectable instead of guessed at.
  try {
    require("node:fs").writeFileSync(`${lib.STATE_DIR}/last-tab-event.json`, raw || "(unset)");
  } catch {
    // debugging aid only
  }
  if (!raw) return "";
  try {
    // Actual shape: {event:"tab_created", data:{type, tab:{tab_id, label, ...}}}
    return JSON.parse(raw)?.data?.tab?.tab_id || "";
  } catch {
    return "";
  }
}

// Second guard behind the suppression marker: a tab that already carries a tool
// name is one of ours, so never offer the menu for it.
function isOwnTab() {
  try {
    const label = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}")?.data?.tab?.label;
    return typeof label === "string" && lib.TOOLS.includes(label.trim());
  } catch {
    return false;
  }
}

function main() {
  if (lib.tabEventsSuppressed()) return;

  const tabId = triggeringTabId();
  if (isOwnTab()) return;

  const ctx = lib.resolveContext();

  const deadline = Date.now() + RETRY_WINDOW_MS;
  for (;;) {
    // Re-check each pass: a spin-up may have started while we were waiting on
    // the modal, which means this tab is one of ours after all.
    if (lib.tabEventsSuppressed()) return;

    try {
      const args = [
        "plugin", "pane", "open",
        "--plugin", lib.PLUGIN_ID,
        "--entrypoint", "picker",
        "--placement", "popup",
        "--cwd", ctx.cwd,
        "--focus",
      ];
      // The popup is spawned by Herdr, not by this process, so the triggering tab
      // has to be handed over explicitly. The picker closes it only if the user
      // actually picks something; on esc the empty tab stays where it was.
      if (tabId) args.push("--env", `SPINUP_TRIGGER_TAB=${tabId}`);
      lib.herdr(args);
      return;
    } catch (err) {
      const busy = /popup already open|ui_busy/i.test(err.message || "");
      if (!busy || Date.now() > deadline) return;
      sleep(RETRY_MS);
    }
  }
}

try {
  main();
} catch {
  // A failed hook must never disrupt opening a tab.
}
process.exit(0);

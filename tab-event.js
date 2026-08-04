#!/usr/bin/env node
"use strict";

// tab.created hook: making a new tab opens the picker, so "new tab" becomes
// "new tab, running something".
//
// This is the launcher. It needs no keybinding, which is what makes it work over
// `herdr --remote`: a remote client has no local plugin registry and no local
// server, so it can neither resolve nor run a plugin action from a keypress. Events
// are raised and handled entirely on the server, so this path is unaffected.
//
// The only guard needed: the tool tabs this plugin opens are new tabs too, and
// would otherwise re-trigger the picker.

const lib = require("./lib.js");


function tabFromEvent() {
  try {
    // Shape: {event:"tab_created", data:{type, tab:{tab_id, label, ...}}}
    return JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}")?.data?.tab || null;
  } catch {
    return null;
  }
}

function main() {
  if (lib.tabEventsSuppressed()) return;

  const tab = tabFromEvent();
  // A tab already carrying a tool name is one of ours.
  if (tab && lib.toolIds().includes((tab.label || "").trim())) return;

  const ctx = lib.resolveContext();
  const args = [
    "plugin", "pane", "open",
    "--plugin", lib.PLUGIN_ID,
    "--entrypoint", "picker",
    "--cwd", ctx.cwd,
    "--focus",
  ];
  // Handed over explicitly: the picker is spawned by Herdr, not by this process.
  // It closes this tab only if a tool is actually picked.
  if (tab && tab.tab_id) args.push("--env", `SPINUP_TRIGGER_TAB=${tab.tab_id}`);

  lib.herdr(args);
}

try {
  main();
} catch (err) {
  // Must never disrupt opening a tab — but a silent failure here is invisible:
  // event hooks report only their exit code, and returning 0 reads as success.
  try {
    require("node:fs").appendFileSync(
      `${lib.STATE_DIR}/tab-event-error.log`,
      `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`,
    );
  } catch {
    // nothing left to try
  }
}
process.exit(0);

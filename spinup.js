#!/usr/bin/env node
"use strict";

// Opens each tool as its own plugin-owned tab, in the cwd of the pane the
// action fired from. A tool already running in that same cwd is focused rather
// than duplicated, so leaning on the keybinding doesn't pile up tabs.
//
// The launching itself lives in lib.js, shared with the popup picker.

const lib = require("./lib.js");

// Keybindings can only fire actions, not open panes, so opening the picker
// popup has to go through an action too.
function openPicker() {
  const ctx = lib.resolveContext();
  const opened = lib.herdr([
    "plugin", "pane", "open",
    "--plugin", lib.PLUGIN_ID,
    "--entrypoint", "picker",
    "--cwd", ctx.cwd,
    "--focus",
  ]);

  // Only one popup can be open session-wide; a second open fails with
  // "popup already open". The picker records its own pane id to
  // $HERDR_PLUGIN_STATE_DIR/picker-pane-id, which is how a wedged one gets
  // closed — a popup's id appears nowhere else.
  const id = opened && opened.plugin_pane && opened.plugin_pane.pane && opened.plugin_pane.pane.pane_id;
  if (id) console.log(`picker popup ${id}`);
}

function main() {
  const actionId = process.env.HERDR_PLUGIN_ACTION_ID || process.argv[2] || "all";

  if (actionId === "picker") {
    openPicker();
    process.exit(0);
  }

  const wanted = actionId === "all" ? lib.TOOLS : [actionId];

  if (!wanted.every((t) => lib.TOOLS.includes(t))) {
    console.error(`unknown action: ${actionId} (expected one of: all, ${lib.TOOLS.join(", ")})`);
    process.exit(2);
  }

  const ctx = lib.resolveContext();
  const { summary, failed } = lib.spinUpAll(wanted, ctx);

  for (const f of failed) console.error(`${f.tool}: ${f.message}`);
  console.log(`${summary} in ${ctx.cwd}`);
  lib.notify(failed.length ? "Spinup (with errors)" : "Spinup", summary);

  process.exit(failed.length ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  lib.notify("Spinup failed", err.message);
  process.exit(1);
}

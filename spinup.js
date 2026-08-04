#!/usr/bin/env node
"use strict";

// Opens each tool as its own plugin-owned tab, in the cwd of the pane the
// action fired from. A tool already running in that same cwd is focused rather
// than duplicated, so leaning on the keybinding doesn't pile up tabs.
//
// Everything goes through `herdr plugin pane open` against the [[panes]]
// entrypoints in herdr-plugin.toml. Building tabs with `tab create` + `pane run`
// / `agent start` looks equivalent but is not: those panes aren't registered in
// the attached client's UI state, and an agent in one is SIGHUP'd as soon as the
// client reconciles focus.

const { spawnSync } = require("node:child_process");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "srujan.spinup";

// Keys match the [[panes]] entrypoint ids and the [[actions]] ids.
const TOOLS = ["fresh", "tuicr", "cc", "cdx"];

function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: "utf8" });
  if (r.error) throw new Error(`could not run ${HERDR}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
  }
  // Some mutating commands succeed with no output at all.
  if (!r.stdout.trim()) return {};
  try {
    return JSON.parse(r.stdout).result;
  } catch {
    throw new Error(`herdr ${args.join(" ")} returned non-JSON: ${r.stdout.slice(0, 200)}`);
  }
}

// The action context is the authority on where the user invoked from; falling
// back to the focused pane keeps manual `herdr plugin action invoke` usable.
function resolveContext() {
  const raw = process.env.HERDR_PLUGIN_CONTEXT_JSON;
  if (raw) {
    try {
      const ctx = JSON.parse(raw);
      const cwd = ctx.focused_pane_cwd || ctx.workspace_cwd;
      if (cwd && ctx.workspace_id) return { cwd, workspaceId: ctx.workspace_id };
    } catch {
      // fall through to the live query
    }
  }
  const pane = herdr(["pane", "current"]).pane;
  return { cwd: pane.foreground_cwd || pane.cwd, workspaceId: pane.workspace_id };
}

// Plugin panes carry their entrypoint title as the pane label, which is what
// makes them findable later. Matching on cwd too means switching projects gets
// you a fresh set of tools instead of ones pointed at the old directory.
function findExisting(tool, ctx) {
  const panes = herdr(["pane", "list"]).panes || [];
  return panes.find(
    (p) => p.label === tool && p.workspace_id === ctx.workspaceId && (p.cwd === ctx.cwd || p.foreground_cwd === ctx.cwd),
  );
}

function spinUp(tool, ctx) {
  const existing = findExisting(tool, ctx);
  if (existing) return { tool, status: "reused", tabId: existing.tab_id };

  const opened = herdr([
    "plugin", "pane", "open",
    "--plugin", PLUGIN_ID,
    "--entrypoint", tool,
    "--placement", "tab",
    "--cwd", ctx.cwd,
    "--no-focus",
  ]);
  const pane = opened.plugin_pane.pane;

  // Opening a plugin pane leaves the tab showing its number; the pane label
  // alone isn't visible in the tab bar.
  try {
    herdr(["tab", "rename", pane.tab_id, tool]);
  } catch {
    // cosmetic only
  }

  return { tool, status: "started", tabId: pane.tab_id };
}

function notify(title, body) {
  const args = ["notification", "show", title];
  if (body) args.push("--body", body);
  spawnSync(HERDR, args, { encoding: "utf8" });
}

function main() {
  const actionId = process.env.HERDR_PLUGIN_ACTION_ID || process.argv[2] || "all";
  const wanted = actionId === "all" ? TOOLS : [actionId];

  if (!wanted.every((t) => TOOLS.includes(t))) {
    console.error(`unknown action: ${actionId} (expected one of: all, ${TOOLS.join(", ")})`);
    process.exit(2);
  }

  const ctx = resolveContext();
  const done = [];
  const failed = [];

  // One tool failing (missing binary, agent that won't start) must not stop the
  // rest of the stack from coming up.
  for (const tool of wanted) {
    try {
      done.push(spinUp(tool, ctx));
    } catch (err) {
      failed.push({ tool, message: err.message });
      console.error(`${tool}: ${err.message}`);
    }
  }

  // Land on the first tool asked for, not whatever was created last.
  const first = done.find((d) => d.tool === wanted[0]) || done[0];
  if (first) {
    try {
      herdr(["tab", "focus", first.tabId]);
    } catch (err) {
      console.error(`focus failed: ${err.message}`);
    }
  }

  const started = done.filter((d) => d.status === "started").map((d) => d.tool);
  const reused = done.filter((d) => d.status === "reused").map((d) => d.tool);

  const parts = [];
  if (started.length) parts.push(`started ${started.join(", ")}`);
  if (reused.length) parts.push(`reused ${reused.join(", ")}`);
  if (failed.length) parts.push(`failed ${failed.map((f) => f.tool).join(", ")}`);

  const summary = parts.join(" · ") || "nothing to do";
  console.log(`${summary} in ${ctx.cwd}`);
  notify(failed.length ? "Spinup (with errors)" : "Spinup", summary);

  process.exit(failed.length ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  notify("Spinup failed", err.message);
  process.exit(1);
}

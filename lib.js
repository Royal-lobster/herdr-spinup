"use strict";

// Shared spin-up logic, used by both the actions (spinup.js) and the popup
// picker (picker.js) so there is one definition of how a tool gets launched.

const { spawnSync } = require("node:child_process");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "srujan.spinup";

// Keys match the [[panes]] entrypoint ids and the [[actions]] ids.
const TOOLS = ["fresh", "tuicr", "cc", "cdx"];

const TOOL_DESC = {
  fresh: "editor",
  tuicr: "review",
  cc: "claude",
  cdx: "codex",
};

function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: "utf8" });
  if (r.error) throw new Error(`could not run ${HERDR}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
  }
  // Some mutating commands succeed with no output at all.
  if (!r.stdout.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`herdr ${args.join(" ")} returned non-JSON: ${r.stdout.slice(0, 200)}`);
  }
  // API failures come back as an {error:{code,message}} payload. The exit code
  // covers this too, but reading the payload turns "exited 1: {json blob}" into
  // an actual reason.
  if (parsed.error) {
    const e = parsed.error;
    throw new Error(`herdr ${args.join(" ")} failed: ${e.message || ""}${e.code ? ` (${e.code})` : ""}`);
  }
  return parsed.result;
}

// The action context is the authority on where the user invoked from. Querying
// the focused pane is only a fallback — and a wrong one for the picker, whose
// own popup is focused by the time it runs, hence the explicit override.
function resolveContext(override) {
  if (override && override.cwd && override.workspaceId) return override;

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
  // `pane current` is unavailable in some contexts (a modal popup has no
  // "current pane" to report), so fall back to what every pane's environment
  // already carries.
  try {
    const pane = herdr(["pane", "current"]).pane;
    if (pane && pane.workspace_id) {
      return { cwd: pane.foreground_cwd || pane.cwd, workspaceId: pane.workspace_id };
    }
  } catch {
    // fall through
  }
  return { cwd: process.cwd(), workspaceId: process.env.HERDR_WORKSPACE_ID || "" };
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

function runningTools(ctx) {
  const panes = herdr(["pane", "list"]).panes || [];
  const live = new Set();
  for (const p of panes) {
    if (p.workspace_id !== ctx.workspaceId) continue;
    if (p.cwd !== ctx.cwd && p.foreground_cwd !== ctx.cwd) continue;
    if (TOOLS.includes(p.label)) live.add(p.label);
  }
  return live;
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

// The tab.created event hook opens the picker — but the tool tabs this plugin
// opens are themselves new tabs, so without a guard each spin-up would trigger
// another picker. Tab labels can't be the guard: the event fires at creation,
// before the tab is renamed. A short-lived marker file is checked instead.
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp";
const SUPPRESS_FILE = `${STATE_DIR}/suppress-tab-events`;
const SUPPRESS_MS = 10000;

function suppressTabEvents() {
  try {
    require("node:fs").writeFileSync(SUPPRESS_FILE, String(Date.now()));
  } catch {
    // if this fails the worst case is a spurious picker, not a loop:
    // "popup already open" stops it from stacking
  }
}

function tabEventsSuppressed() {
  try {
    const raw = require("node:fs").readFileSync(SUPPRESS_FILE, "utf8").trim();
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    // Time-boxed so a crashed spin-up can't suppress the hook forever.
    return Date.now() - at < SUPPRESS_MS;
  } catch {
    return false;
  }
}

function releaseTabEvents() {
  try {
    require("node:fs").unlinkSync(SUPPRESS_FILE);
  } catch {
    // already gone
  }
}

function notify(title, body) {
  const args = ["notification", "show", title];
  if (body) args.push("--body", body);
  spawnSync(HERDR, args, { encoding: "utf8" });
}

// Spins up `wanted`, focuses the first one asked for, returns a one-line summary.
// One tool failing must not stop the rest of the stack from coming up.
function spinUpAll(wanted, ctx) {
  const done = [];
  const failed = [];

  // Every tab opened below fires tab.created; keep the hook quiet while we work.
  suppressTabEvents();

  for (const tool of wanted) {
    try {
      done.push(spinUp(tool, ctx));
    } catch (err) {
      failed.push({ tool, message: err.message });
    }
  }

  const first = done.find((d) => d.tool === wanted[0]) || done[0];
  if (first) {
    try {
      herdr(["tab", "focus", first.tabId]);
    } catch {
      // leaving the user where they were is survivable
    }
  }

  const started = done.filter((d) => d.status === "started").map((d) => d.tool);
  const reused = done.filter((d) => d.status === "reused").map((d) => d.tool);

  const parts = [];
  if (started.length) parts.push(`started ${started.join(", ")}`);
  if (reused.length) parts.push(`reused ${reused.join(", ")}`);
  if (failed.length) parts.push(`failed ${failed.map((f) => f.tool).join(", ")}`);

  // Held until the tabs have settled rather than cleared immediately, so the
  // events still in flight for the tabs above stay suppressed.
  return { summary: parts.join(" · ") || "nothing to do", failed };
}

module.exports = {
  HERDR, PLUGIN_ID, TOOLS, TOOL_DESC, STATE_DIR,
  herdr, resolveContext, findExisting, runningTools, spinUp, spinUpAll, notify,
  suppressTabEvents, tabEventsSuppressed, releaseTabEvents,
};

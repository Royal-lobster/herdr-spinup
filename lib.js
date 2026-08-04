"use strict";

// Shared spin-up logic, used by both the actions (spinup.js) and the popup
// picker (picker.js) so there is one definition of how a tool gets launched.

const { spawnSync } = require("node:child_process");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "royal-lobster.spinup";

const fs = require("node:fs");

// Just enough TOML for tools.toml: comments, [[tools]] array-of-tables, and
// scalar `key = value`. Deliberately not a general parser — pulling in a
// dependency would mean a build step for a file this simple.
function parseToolsToml(text) {
  const tools = [];
  let cur = null;

  for (const raw of text.split(/\r?\n/)) {
    // Strip comments, but not a # inside a quoted value.
    let line = "";
    let quote = null;
    for (const ch of raw) {
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "#") {
        break;
      }
      line += ch;
    }
    line = line.trim();
    if (!line) continue;

    if (line === "[[tools]]") {
      cur = {};
      tools.push(cur);
      continue;
    }
    if (line.startsWith("[")) {
      cur = null; // some other table; ignore its keys
      continue;
    }
    if (!cur) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();

    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else if (val === "true" || val === "false") {
      val = val === "true";
    } else if (val !== "" && !Number.isNaN(Number(val))) {
      val = Number(val);
    }
    cur[key] = val;
  }

  return tools;
}

function normaliseTools(raw) {
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const id = typeof t.id === "string" ? t.id.trim() : "";
    const command = typeof t.command === "string" ? t.command.trim() : "";
    if (!id || !command || seen.has(id)) continue; // a broken entry is skipped, not fatal
    seen.add(id);
    out.push({
      id,
      command,
      label: (typeof t.label === "string" && t.label.trim()) || id,
      desc: typeof t.desc === "string" ? t.desc : "",
      key: typeof t.key === "string" && t.key.length === 1 ? t.key : "",
    });
  }
  return out;
}

const BUNDLED_TOOLS = `${__dirname}/tools.toml`;

// User config lives in HERDR_PLUGIN_CONFIG_DIR, which herdr keeps outside the
// plugin checkout so it survives updates. Seed it from the bundled copy on first
// run so there's something to edit.
function toolsPath() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) return BUNDLED_TOOLS;
  const p = `${dir}/tools.toml`;
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(BUNDLED_TOOLS, p);
    }
    return p;
  } catch {
    return BUNDLED_TOOLS;
  }
}

let toolsCache = null;

function loadTools() {
  if (toolsCache) return toolsCache;
  let tools = [];
  try {
    tools = normaliseTools(parseToolsToml(fs.readFileSync(toolsPath(), "utf8")));
  } catch {
    tools = [];
  }
  if (!tools.length) {
    // Never leave the picker empty because of a bad edit.
    try {
      tools = normaliseTools(parseToolsToml(fs.readFileSync(BUNDLED_TOOLS, "utf8")));
    } catch {
      tools = [];
    }
  }
  toolsCache = tools;
  return tools;
}

function toolIds() {
  return loadTools().map((t) => t.id);
}

function findTool(id) {
  return loadTools().find((t) => t.id === id) || null;
}

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
  const ids = toolIds();
  const panes = herdr(["pane", "list"]).panes || [];
  const live = new Set();
  for (const p of panes) {
    if (p.workspace_id !== ctx.workspaceId) continue;
    if (p.cwd !== ctx.cwd && p.foreground_cwd !== ctx.cwd) continue;
    if (ids.includes(p.label)) live.add(p.label);
  }
  return live;
}

// Tools all go through the single `runner` entrypoint, with the command handed
// over in SPINUP_CMD. Per-tool [[panes]] entries would mean editing the manifest
// for every tool, and the manifest is a managed checkout for an installed plugin —
// user-defined tools have to work without touching it. The runner is
// `sh -c 'exec $SPINUP_CMD'`, so the tool replaces the shell and herdr's
// process-name agent detection sees it exactly as if it were launched directly.
function spinUp(id, ctx) {
  const tool = findTool(id);
  if (!tool) throw new Error(`unknown tool "${id}" — check tools.toml`);

  const existing = findExisting(id, ctx);
  if (existing) return { tool: id, status: "reused", tabId: existing.tab_id };

  const opened = herdr([
    "plugin", "pane", "open",
    "--plugin", PLUGIN_ID,
    "--entrypoint", "runner",
    "--placement", "tab",
    "--cwd", ctx.cwd,
    "--env", `SPINUP_CMD=${tool.command}`,
    "--no-focus",
  ]);
  const pane = opened.plugin_pane.pane;

  // The pane label is how a running tool is found again later, and every tool now
  // shares one entrypoint (so they'd all be labelled "runner"). Set it explicitly.
  // The tab label is separate: it's what shows in the tab bar, and the
  // first-prompt hook may later rewrite it.
  try {
    herdr(["pane", "rename", pane.pane_id, id]);
  } catch {
    // reuse detection degrades to starting a second copy; not fatal
  }
  try {
    herdr(["tab", "rename", pane.tab_id, tool.label]);
  } catch {
    // cosmetic only
  }

  return { tool: id, status: "started", tabId: pane.tab_id };
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
  HERDR, PLUGIN_ID, STATE_DIR,
  loadTools, toolIds, findTool, toolsPath,
  herdr, resolveContext, findExisting, runningTools, spinUp, spinUpAll, notify,
  suppressTabEvents, tabEventsSuppressed, releaseTabEvents,
};

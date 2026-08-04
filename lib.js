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

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || "/tmp";

module.exports = { HERDR, PLUGIN_ID, STATE_DIR, loadTools, toolIds, findTool, toolsPath, herdr };

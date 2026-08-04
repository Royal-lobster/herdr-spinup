"use strict";

// Reads the two user-editable files: tools.toml and logo.txt.

const fs = require("node:fs");
const path = require("node:path");

const BUNDLED = path.join(__dirname, "..");
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || "";

// HERDR_PLUGIN_CONFIG_DIR sits outside the plugin checkout, so it survives updates.
// Seed it on first run so there is something to edit.
function configFile(name) {
  const bundled = path.join(BUNDLED, name);
  if (!CONFIG_DIR) return bundled;
  const user = path.join(CONFIG_DIR, name);
  try {
    if (!fs.existsSync(user)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.copyFileSync(bundled, user);
    }
    return user;
  } catch {
    return bundled;
  }
}

function read(name) {
  try {
    return fs.readFileSync(configFile(name), "utf8");
  } catch {
    return "";
  }
}

// Just enough TOML for tools.toml: comments, [[tools]], scalar `key = value`. Not a
// general parser — a dependency would mean a build step for a file this simple.
function parseTools(text) {
  const tools = [];
  let cur = null;

  for (const raw of text.split(/\r?\n/)) {
    let line = "";
    let quote = null;
    for (const ch of raw) {
      // A # inside a quoted value is not a comment.
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
      cur = null;
      continue;
    }
    if (!cur) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    cur[key] = val;
  }

  return tools;
}

function normalise(raw) {
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

let tools = null;

function loadTools() {
  if (tools) return tools;
  tools = normalise(parseTools(read("tools.toml")));
  if (!tools.length) {
    // A bad edit must not leave an empty menu.
    try {
      tools = normalise(parseTools(fs.readFileSync(path.join(BUNDLED, "tools.toml"), "utf8")));
    } catch {
      tools = [];
    }
  }
  return tools;
}

// An empty logo.txt hides the banner. Blank lines inside it are kept — they may be
// part of the art.
function loadLogo() {
  const text = read("logo.txt").replace(/[\r\n]+$/, "");
  return text.trim() ? text.split(/\r?\n/) : [];
}

module.exports = { loadTools, loadLogo };

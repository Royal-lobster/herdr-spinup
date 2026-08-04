"use strict";

// Reads the two user-editable files: tools.json and logo.txt.

const fs = require("node:fs");
const path = require("node:path");

const BUNDLED = path.join(__dirname, "..");
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || "";

/**
 * Resolves a config file, seeding the user's copy from the bundled one on first run.
 *
 * HERDR_PLUGIN_CONFIG_DIR sits outside the plugin checkout, so edits survive updates.
 *
 * @param name File name, e.g. `"tools.json"`.
 * @returns Path to the user's copy, or the bundled file if there is no config dir.
 */
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

/**
 * Reads a config file, treating an unreadable one as empty.
 *
 * @param name File name.
 * @returns File contents, or `""`.
 */
function read(name) {
  try {
    return fs.readFileSync(configFile(name), "utf8");
  } catch {
    return "";
  }
}

/**
 * Parses the tool list.
 *
 * @param text File contents.
 * @returns Raw entries, unvalidated. A malformed file yields `[]`, which
 *   falls back to the bundled defaults rather than an empty menu.
 */
function parse(text) {
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Validates parsed entries and fills in defaults.
 *
 * @param raw Entries from {@link parse}.
 * @returns Usable tools. Entries missing `id` or `command`, or repeating an `id`, are dropped.
 */
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

/**
 * Loads the tool list, falling back to the bundled defaults.
 *
 * @returns Tools, cached after the first call. Never empty unless the
 *   bundled file is unreadable too, so a bad edit cannot produce an empty menu.
 */
function loadTools() {
  if (tools) return tools;
  tools = normalise(parse(read("tools.json")));
  if (!tools.length) {
    // A bad edit must not leave an empty menu.
    try {
      tools = normalise(parse(fs.readFileSync(path.join(BUNDLED, "tools.json"), "utf8")));
    } catch {
      tools = [];
    }
  }
  return tools;
}

/**
 * Loads the banner shown above the menu.
 *
 * @returns Lines of `logo.txt`, or `[]` if it is empty — which hides the
 *   banner. Blank lines inside the art are kept.
 */
function loadLogo() {
  const text = read("logo.txt").replace(/[\r\n]+$/, "");
  return text.trim() ? text.split(/\r?\n/) : [];
}

module.exports = { loadTools, loadLogo };

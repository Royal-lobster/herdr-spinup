#!/usr/bin/env node
"use strict";

// UserPromptSubmit hook for Claude Code and Codex: names the tab after the first
// prompt of a session. Wired up in ~/.claude/settings.json and ~/.codex/hooks.json.
//
// Must never print to stdout: for UserPromptSubmit, that is injected into the
// model's context.

const { spawnSync } = require("node:child_process");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const MAX_LEN = 28;

// Only a bare number or a tool label is overwritten, which keeps hand-named tabs
// safe and limits this to the first message. The plugin env vars are absent in a
// hook, so a failure here just means fewer labels qualify.
/**
 * @returns {Set<string>} Configured tool labels. Empty if the config cannot be read —
 *   which is normal here, since a hook is not a plugin process.
 */
function toolLabels() {
  try {
    return new Set(require("./config.js").loadTools().map((t) => t.label));
  } catch {
    return new Set();
  }
}

/**
 * Whether a tab label may be overwritten.
 *
 * @param {string} label The tab's current label.
 * @returns {boolean} True for a bare number or a tool label. Anything else was named
 *   by a previous prompt or by hand, which is what limits this to the first message.
 */
function isDefaultLabel(label) {
  if (!label) return true;
  if (/^\d+$/.test(label.trim())) return true;
  return toolLabels().has(label.trim());
}

// The two CLIs disagree on where the prompt lives, and neither contract is stable.
/**
 * Digs the prompt out of a hook payload.
 *
 * @param {object} data Parsed stdin.
 * @returns {string|null} The prompt text, or null if none of the known shapes match.
 */
function extractPrompt(data) {
  if (!data || typeof data !== "object") return null;
  const direct =
    data.prompt ??
    data.user_prompt ??
    data.userPrompt ??
    data.message ??
    data.text ??
    data.input;
  if (typeof direct === "string") return direct;
  if (data.payload) return extractPrompt(data.payload);
  return null;
}

// Tab bars are narrow: one line, no syntax noise, cut on a word boundary.
/**
 * Condenses a prompt into something that fits a tab bar.
 *
 * @param {string} prompt
 * @returns {string|null} One line, no syntax noise, cut on a word boundary; null if
 *   nothing meaningful is left.
 */
function toLabel(prompt) {
  let s = prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // A leading slash command says nothing about the task.
  s = s.replace(/^\/\S+\s*/, "").trim();
  if (!s) return null;

  if (s.length <= MAX_LEN) return s;
  const cut = s.slice(0, MAX_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > MAX_LEN * 0.5 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

/**
 * @returns {string} The hook payload, or `""` if stdin is unreadable.
 */
function readStdin() {
  try {
    return require("node:fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Renames the enclosing herdr tab after this session's first prompt.
 */
function main() {
  const tabId = process.env.HERDR_TAB_ID;
  if (!tabId) return; // not running inside a Herdr pane

  const raw = readStdin();
  if (!raw.trim()) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  const prompt = extractPrompt(data);
  if (!prompt) return;

  const label = toLabel(prompt);
  if (!label) return;

  const got = spawnSync(HERDR, ["tab", "get", tabId], { encoding: "utf8" });
  if (got.status !== 0) return;

  let current;
  try {
    current = JSON.parse(got.stdout).result.tab.label;
  } catch {
    return;
  }
  if (!isDefaultLabel(current)) return;

  spawnSync(HERDR, ["tab", "rename", tabId, label], { encoding: "utf8" });
}

try {
  main();
} catch {
  // A hook must never break the session it's attached to.
}
process.exit(0);

#!/usr/bin/env node
"use strict";

// UserPromptSubmit hook for Claude Code and Codex: renames the enclosing Herdr
// tab after the first prompt of a session, so a wall of tabs labelled "1" or
// "cc" becomes a wall of tabs labelled with what each one is actually doing.
//
// Wired up in ~/.claude/settings.json and ~/.codex/hooks.json.
//
// This must never print to stdout: for UserPromptSubmit, whatever the hook
// writes there is injected into the model's context.

const { spawnSync } = require("node:child_process");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const MAX_LEN = 28;

// Labels we're willing to overwrite: a bare tab number, or a tool's own label.
// Anything else was either already derived from a first prompt or named by hand,
// and is left alone — which is what limits this to the *first* message.
//
// Loaded from tools.toml, but this also runs as a Claude/Codex hook where the
// plugin env vars are absent, so a failure here just means fewer labels qualify.
function toolLabels() {
  try {
    return new Set(require("./lib.js").loadTools().map((t) => t.label));
  } catch {
    return new Set();
  }
}

function isDefaultLabel(label) {
  if (!label) return true;
  if (/^\d+$/.test(label.trim())) return true;
  return toolLabels().has(label.trim());
}

// The two CLIs don't agree on where the prompt lives, and neither contract is
// guaranteed stable, so check the plausible spots.
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

// Tab bars are narrow: collapse to one line, drop syntax noise, and cut on a
// word boundary so the label reads as words rather than a severed token.
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

function readStdin() {
  try {
    return require("node:fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

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

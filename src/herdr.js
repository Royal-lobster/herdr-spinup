"use strict";

// The herdr CLI is the whole plugin API.

const { spawnSync } = require("node:child_process");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";

/**
 * Runs a herdr CLI command.
 *
 * @param args Arguments, e.g. `["pane", "list"]`.
 * @returns The `result` payload, or `{}` for commands that print nothing.
 * @throws If the binary is missing, the command fails, or the reply is not JSON.
 */
function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: "utf8" });
  if (r.error) throw new Error(`could not run ${HERDR}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
  }
  if (!r.stdout.trim()) return {}; // some mutating commands print nothing

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`herdr ${args.join(" ")} returned non-JSON: ${r.stdout.slice(0, 200)}`);
  }
  // API failures come back as an {error:{code,message}} payload, not just a status.
  if (parsed.error) {
    const e = parsed.error;
    throw new Error(`herdr ${args.join(" ")} failed: ${e.message || ""}${e.code ? ` (${e.code})` : ""}`);
  }
  return parsed.result;
}

module.exports = { herdr };

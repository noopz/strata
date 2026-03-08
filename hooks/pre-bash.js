/**
 * PreToolUse hook — intercepts Bash grep/rg commands.
 * Matcher: Bash
 *
 * Only intercepts simple grep/rg commands (no pipes, redirects, subshells).
 * Uses deny + additionalContext to return structurally-annotated results.
 *
 * Passthrough ({}): for non-grep commands, piped/complex commands, or errors.
 *
 * Replaces pre-bash.sh with pure Node.js for Windows compatibility.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin, strataLog, getProjectRoot } from "./lib/common.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEARCH_CLI = path.join(__dirname, "..", "dist", "search-cli.js");

// Compute cacheDir for logging
let projectRoot;
if (process.env.CLAUDE_PROJECT_DIR) {
  projectRoot = process.env.CLAUDE_PROJECT_DIR;
} else {
  projectRoot = getProjectRoot(process.cwd());
}
const cacheDir = path.join(projectRoot, ".strata");

// If CLI not built, passthrough
if (!fs.existsSync(SEARCH_CLI)) {
  strataLog(cacheDir, { hook: "pre-bash", decision: "passthrough_no_cli" });
  process.stdout.write("{}\n");
  process.exit(0);
}

const input = await readStdin();
const toolInput = input.tool_input || input;
const command = (toolInput.command || "").trim();

// Parse the grep/rg command to extract pattern and path
const parsed = parseGrepCommand(command);

if (!parsed) {
  strataLog(cacheDir, { hook: "pre-bash", decision: "passthrough_not_grep" });
  process.stdout.write("{}\n");
  process.exit(0);
}

const { pattern: grepPattern, searchPath: grepPath } = parsed;

// Build search-cli args
const searchArgs = [SEARCH_CLI, grepPattern, grepPath || "."];

// Run search-cli
let results;
try {
  results = execFileSync("node", searchArgs, {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
} catch {
  strataLog(cacheDir, { hook: "pre-bash", decision: "passthrough_cli_error", pattern: grepPattern });
  process.stdout.write("{}\n");
  process.exit(0);
}

// If no results, passthrough
if (!results) {
  strataLog(cacheDir, { hook: "pre-bash", decision: "passthrough_no_results", pattern: grepPattern });
  process.stdout.write("{}\n");
  process.exit(0);
}

strataLog(cacheDir, { hook: "pre-bash", decision: "annotated_results", pattern: grepPattern });

const output = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Results provided with structural context annotations below.",
    additionalContext: `Search results for ${grepPattern}:\n\n${results}`,
  },
};

process.stdout.write(JSON.stringify(output) + "\n");

/**
 * Parse a shell command to check if it's a simple grep/rg invocation.
 * Returns { pattern, searchPath } or null if not a simple grep/rg command.
 */
function parseGrepCommand(cmd) {
  // Skip empty, complex, or non-grep commands
  if (!cmd || /[|><;]|\$\(|&&|`/.test(cmd) || !/^\s*(grep|rg)\s/.test(cmd)) {
    return null;
  }

  // Simple tokenizer (handles quoted arguments)
  const parts = [];
  let cur = "";
  let inQ = false;
  let qChar = "";
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (inQ) {
      if (c === qChar) inQ = false;
      else cur += c;
    } else if (c === '"' || c === "'") {
      inQ = true;
      qChar = c;
    } else if (c === " " || c === "\t") {
      if (cur) { parts.push(cur); cur = ""; }
    } else {
      cur += c;
    }
  }
  if (cur) parts.push(cur);

  // Extract pattern and path
  let pattern = "";
  let searchPath = "";
  let skipNext = false;
  let foundPattern = false;
  const flagsWithValue = new Set([
    "-e", "--regexp", "-f", "--file", "-m", "--max-count",
    "-A", "-B", "-C", "--context", "--glob", "-t", "--type",
    "--include", "--exclude", "--color", "--colors",
  ]);

  for (let i = 1; i < parts.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    const a = parts[i];
    if (flagsWithValue.has(a)) {
      if ((a === "-e" || a === "--regexp") && i + 1 < parts.length) {
        pattern = parts[i + 1];
        foundPattern = true;
      }
      skipNext = true;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (!foundPattern) { pattern = a; foundPattern = true; }
    else { searchPath = a; }
  }

  if (!pattern) return null;
  return { pattern, searchPath };
}

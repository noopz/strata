/**
 * PreToolUse hook — intercepts Grep tool calls.
 * Matcher: Grep
 *
 * Runs search-cli.js to generate structurally-annotated results.
 * Uses deny + additionalContext to suppress native Grep and return
 * annotated results as sole output.
 *
 * Passthrough ({}): if search-cli not built, pattern empty, or errors.
 *
 * Replaces pre-grep.sh with pure Node.js for Windows compatibility.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin, strataLog, normalizePath, getProjectRoot } from "./lib/common.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEARCH_CLI = path.join(__dirname, "..", "dist", "search-cli.js");

const input = await readStdin();
const toolInput = input.tool_input || input;
const pattern = toolInput.pattern || "";
const searchPath = toolInput.path || "";
const globPat = toolInput.glob || "";

// Compute cacheDir for logging
let projectRoot;
if (searchPath && fs.existsSync(searchPath) && fs.statSync(searchPath).isDirectory()) {
  projectRoot = getProjectRoot(searchPath);
} else if (process.env.CLAUDE_PROJECT_DIR) {
  projectRoot = process.env.CLAUDE_PROJECT_DIR;
} else {
  projectRoot = getProjectRoot(process.cwd());
}
const cacheDir = path.join(projectRoot, ".strata");

// If CLI not built, passthrough
if (!fs.existsSync(SEARCH_CLI)) {
  process.stdout.write("{}\n");
  process.exit(0);
}

// If pattern is empty, passthrough
if (!pattern) {
  strataLog(cacheDir, { hook: "pre-grep", decision: "passthrough_no_pattern" });
  process.stdout.write("{}\n");
  process.exit(0);
}

// Build search-cli args
const searchArgs = [SEARCH_CLI, pattern, searchPath || "."];
if (globPat) {
  searchArgs.push(globPat);
}

// Run search-cli
let results;
try {
  results = execFileSync("node", searchArgs, {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
} catch {
  strataLog(cacheDir, { hook: "pre-grep", decision: "passthrough_cli_error", pattern });
  process.stdout.write("{}\n");
  process.exit(0);
}

// If no results, passthrough to let native Grep report "no matches"
if (!results) {
  strataLog(cacheDir, { hook: "pre-grep", decision: "passthrough_no_results", pattern });
  process.stdout.write("{}\n");
  process.exit(0);
}

strataLog(cacheDir, { hook: "pre-grep", decision: "annotated_results", pattern });

const output = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Results provided with structural context annotations below.",
    additionalContext: `Search results for ${pattern}:\n\n${results}`,
  },
};

process.stdout.write(JSON.stringify(output) + "\n");

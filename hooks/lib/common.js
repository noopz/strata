/**
 * Shared utilities for Strata Node.js hooks.
 *
 * Provides stdin reading, JSONL logging, path normalization,
 * and re-exports project root / cache dir helpers from dist/utils.js.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Re-export utilities from the compiled TypeScript source
const utilsPath = path.join(__dirname, "..", "..", "dist", "utils.js");
const { getProjectRoot, getCacheDir, getIndexPath } = await import(utilsPath);
export { getProjectRoot, getCacheDir, getIndexPath };

/**
 * Read all of stdin and parse as JSON.
 * Returns the parsed object, or an empty object on error.
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Append JSONL log entries to $CACHE_DIR/hook.log.
 * Silently no-ops if cacheDir is not provided or on error.
 *
 * @param {string} cacheDir - Path to the .strata cache directory
 * @param {Record<string, unknown>} entries - Key-value pairs to log
 */
export function strataLog(cacheDir, entries) {
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const record = { ts: new Date().toISOString(), ...entries };
    fs.appendFileSync(
      path.join(cacheDir, "hook.log"),
      JSON.stringify(record) + "\n"
    );
  } catch {
    // Best effort
  }
}

/**
 * Normalize a file path for cross-platform compatibility.
 *
 * On Windows under MSYS2/Git Bash, paths may arrive as `/c/Users/...`
 * instead of `C:\Users\...`. `path.resolve('/c/Users/zack')` on Windows
 * wrongly produces `C:\c\Users\zack`. This function detects the MSYS2
 * format and converts it before resolving.
 *
 * @param {string} p - The path to normalize
 * @returns {string} Resolved absolute path
 */
export function normalizePath(p) {
  if (!p) return p;
  // Detect MSYS2 format: /c/Users/... → C:\Users\...
  const msys2Match = p.match(/^\/([a-zA-Z])\/(.*)/);
  if (msys2Match) {
    p = `${msys2Match[1].toUpperCase()}:\\${msys2Match[2].replace(/\//g, "\\")}`;
  }
  return path.resolve(p);
}

/**
 * PostToolUse hook — cache invalidation after Edit/Write.
 * Matcher: Edit|Write
 *
 * Directly imports invalidateCache() instead of spawning a child process.
 * Replaces post-edit.sh for Windows compatibility.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin, strataLog, normalizePath, getCacheDir } from "./lib/common.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const input = await readStdin();
const toolInput = input.tool_input || input;
const rawPath = toolInput.file_path || "";

if (!rawPath) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const filePath = normalizePath(rawPath);

if (!fs.existsSync(filePath)) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const cacheDir = getCacheDir(filePath);

// Import invalidateCache directly from compiled dist
try {
  const { invalidateCache } = await import(
    path.join(__dirname, "..", "dist", "invalidate-cli.js")
  );
  invalidateCache(filePath);
  strataLog(cacheDir, { hook: "post-edit", decision: "invalidated", file: filePath });
} catch {
  strataLog(cacheDir, { hook: "post-edit", decision: "invalidate_failed", file: filePath });
}

process.stdout.write("{}\n");

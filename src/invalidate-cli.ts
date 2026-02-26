#!/usr/bin/env node
/**
 * CLI for cache invalidation.
 * Called by post-edit.sh hook when files are modified via Edit/Write.
 *
 * Usage: node invalidate-cli.js <file_path>
 * Deletes filesystem cache entries and removes the file from the
 * cross-file index so it gets re-analyzed on next read.
 *
 * Env: CLAUDE_PROJECT_DIR — project root (set by Claude Code)
 *      STRATA_INDEX_PATH — override path for persistent index file
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CrossFileIndex } from "./cross-file-index.js";

/**
 * Get the project root directory.
 * Primary: $CLAUDE_PROJECT_DIR (set by Claude Code for hooks and child processes)
 * Fallback: walk up from a path looking for project markers
 * Last resort: cwd (Claude Code runs hooks from the project directory)
 */
function getProjectRoot(filePath: string): string {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  let dir = path.dirname(filePath);
  const markers = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
  while (dir !== path.dirname(dir)) {
    for (const marker of markers) {
      if (fs.existsSync(path.join(dir, marker))) {
        return dir;
      }
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function getCacheDir(filePath: string): string {
  return path.join(getProjectRoot(filePath), ".strata");
}

function getIndexPath(filePath: string): string {
  if (process.env.STRATA_INDEX_PATH) {
    return process.env.STRATA_INDEX_PATH;
  }
  return path.join(getCacheDir(filePath), "cross-file-index.json");
}

const filePath = process.argv[2];
if (!filePath) {
  process.exit(0);
}

const absPath = path.resolve(filePath);
const cacheDir = getCacheDir(absPath);
const fileHash = createHash("sha256").update(absPath).digest("hex");

// Delete all cache files for this path (any mtime)
try {
  if (fs.existsSync(cacheDir)) {
    const entries = fs.readdirSync(cacheDir);
    for (const entry of entries) {
      if (entry.startsWith(fileHash)) {
        fs.unlinkSync(path.join(cacheDir, entry));
      }
    }
  }
} catch {
  // Best effort
}

// Remove from cross-file index so it gets re-analyzed on next read
const indexPath = getIndexPath(absPath);
try {
  if (fs.existsSync(indexPath)) {
    const index = new CrossFileIndex();
    index.importState(fs.readFileSync(indexPath, "utf-8"));
    index.removeFile(absPath);
    fs.writeFileSync(indexPath, index.exportState(), "utf-8");
  }
} catch {
  // Best effort
}

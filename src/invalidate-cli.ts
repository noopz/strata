#!/usr/bin/env node
/**
 * CLI for cache invalidation.
 * Called by post-edit hook when files are modified via Edit/Write.
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
import { getCacheDir, getIndexPath } from "./utils.js";

/**
 * Invalidate all cached outlines for a file and remove it from the cross-file index.
 *
 * @param filePath - Absolute path to the file whose cache should be invalidated
 */
export function invalidateCache(filePath: string): void {
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
}

// CLI entry point
const filePath = process.argv[2];
if (filePath) {
  invalidateCache(filePath);
} else if (process.argv[1] && path.basename(process.argv[1]).includes("invalidate-cli")) {
  process.exit(0);
}

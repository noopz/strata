/**
 * Shared utilities for Strata CLIs and hooks.
 *
 * Extracted from analyze-cli.ts and invalidate-cli.ts to avoid
 * duplicating project-root discovery and cache-path logic.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Get the project root directory.
 * Primary: $CLAUDE_PROJECT_DIR (set by Claude Code for hooks and child processes)
 * Fallback: walk up from a path looking for project markers
 * Last resort: cwd (Claude Code runs hooks from the project directory)
 */
export function getProjectRoot(filePath: string): string {
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

/** Get the .strata cache dir for a file's project. */
export function getCacheDir(filePath: string): string {
  const projectRoot = getProjectRoot(filePath);
  return path.join(projectRoot, ".strata");
}

/** Get the cross-file index path for a file's project. */
export function getIndexPath(filePath: string): string {
  if (process.env.STRATA_INDEX_PATH) {
    return process.env.STRATA_INDEX_PATH;
  }
  return path.join(getCacheDir(filePath), "cross-file-index.json");
}

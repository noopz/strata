#!/usr/bin/env node
/**
 * CLI entry point for structural analysis.
 * Called by the PreToolUse hook to generate structural views for cache misses.
 *
 * Maintains a persistent cross-file index so structural outlines include
 * connections to previously analyzed files. The index is progressively
 * built as files are discovered during a session.
 *
 * Usage: node analyze-cli.js <file_path> [max_depth]
 * Outputs the structural view (with cross-file connections) to stdout.
 *
 * Env: CLAUDE_PROJECT_DIR — project root (set by Claude Code)
 *      STRATA_INDEX_PATH — override path for persistent index file
 */

import fs from "node:fs";
import path from "node:path";
import { analyzeFile } from "./structural-analyzer.js";
import { CrossFileIndex } from "./cross-file-index.js";
import { renderStructuralView } from "./formatter.js";
import { computeHash } from "./hashline.js";

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

/** Get the .strata cache dir for a file's project. */
function getCacheDir(filePath: string): string {
  const projectRoot = getProjectRoot(filePath);
  return path.join(projectRoot, ".strata");
}

/** Get the cross-file index path for a file's project. */
function getIndexPath(filePath: string): string {
  if (process.env.STRATA_INDEX_PATH) {
    return process.env.STRATA_INDEX_PATH;
  }
  return path.join(getCacheDir(filePath), "cross-file-index.json");
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: analyze-cli <file_path> [max_depth]");
  process.exit(1);
}

const maxDepth = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;

const absPath = path.resolve(filePath);
if (!fs.existsSync(absPath)) {
  console.error(`File not found: ${absPath}`);
  process.exit(1);
}

const indexPath = getIndexPath(absPath);

const stat = fs.statSync(absPath);
const content = fs.readFileSync(absPath, "utf-8");
const lines = content.split("\n");

// Analyze the file
const tree = analyzeFile(lines, absPath, stat.mtimeMs, maxDepth);

// Load or create the cross-file index (scoped per project)
const index = new CrossFileIndex();
try {
  if (fs.existsSync(indexPath)) {
    const indexData = fs.readFileSync(indexPath, "utf-8");
    index.importState(indexData);
  }
} catch {
  // Corrupt or unreadable index — start fresh
}

// Add this file to the index
index.indexFile(absPath, tree, lines);

// Get connections to previously seen files
const connections = index.getConnections(absPath, 5);

// Render with connections
const view = renderStructuralView(tree, connections, undefined, computeHash, lines);

// Save the updated index
try {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, index.exportState(), "utf-8");
} catch {
  // Best effort — don't fail the hook if we can't persist
}

const hint = "  edit workflow: structural_expand <range> → structural_edit\n";
const viewWithHint = view.replace("\n  ---\n", "\n  ---\n" + hint);
process.stdout.write(viewWithHint);

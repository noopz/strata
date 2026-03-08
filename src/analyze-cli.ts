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
import { fileURLToPath } from "node:url";
import { analyzeFile } from "./structural-analyzer.js";
import { CrossFileIndex } from "./cross-file-index.js";
import { renderStructuralView } from "./formatter.js";
import { getIndexPath } from "./utils.js";

/**
 * Generate a structural outline for a file.
 * Returns the rendered outline string including cross-file connections.
 *
 * @param filePath - Absolute path to the file to analyze
 * @param maxDepth - Optional maximum depth for analysis and rendering
 */
export function generateOutline(filePath: string, maxDepth?: number): string {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
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

  // Render with connections. Default render depth of 2 — shows sections and their
  // immediate methods/blocks. The tree retains deeper analysis for targeted reads.
  const renderDepth = maxDepth ?? 2;
  const view = renderStructuralView(tree, connections, renderDepth);

  // Save the updated index
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, index.exportState(), "utf-8");
  } catch {
    // Best effort — don't fail the hook if we can't persist
  }

  return view;
}

// CLI entry point — only runs when this file is the direct entry point, not when imported
const __analyze_filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === __analyze_filename;

if (isDirectRun) {
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

  process.stdout.write(generateOutline(absPath, maxDepth));
}

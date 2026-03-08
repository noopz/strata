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
/**
 * Generate a structural outline for a file.
 * Returns the rendered outline string including cross-file connections.
 *
 * @param filePath - Absolute path to the file to analyze
 * @param maxDepth - Optional maximum depth for analysis and rendering
 */
export declare function generateOutline(filePath: string, maxDepth?: number): string;

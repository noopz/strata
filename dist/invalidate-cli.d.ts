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
/**
 * Invalidate all cached outlines for a file and remove it from the cross-file index.
 *
 * @param filePath - Absolute path to the file whose cache should be invalidated
 */
export declare function invalidateCache(filePath: string): void;

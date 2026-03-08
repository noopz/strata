/**
 * Shared utilities for Strata CLIs and hooks.
 *
 * Extracted from analyze-cli.ts and invalidate-cli.ts to avoid
 * duplicating project-root discovery and cache-path logic.
 */
/**
 * Get the project root directory.
 * Primary: $CLAUDE_PROJECT_DIR (set by Claude Code for hooks and child processes)
 * Fallback: walk up from a path looking for project markers
 * Last resort: cwd (Claude Code runs hooks from the project directory)
 */
export declare function getProjectRoot(filePath: string): string;
/** Get the .strata cache dir for a file's project. */
export declare function getCacheDir(filePath: string): string;
/** Get the cross-file index path for a file's project. */
export declare function getIndexPath(filePath: string): string;
